import { activityOf, byRecency } from '../domain/filter.js';
import { looksMarked, stripMarks, templatesSeen } from '../domain/stale.js';
import type { AccountRef, DiscoveredSession } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { lastForsterArchiveWrite, project, type LedgerState } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { appArchivesOnPrClose } from '../store/appPrefs.js';
import { readSessionFile } from '../store/sessionFile.js';
import { errorMessage } from '../util/fs.js';
import { writeFileAtomic } from '../util/fsatomic.js';

/**
 * Bring a card's archived flag into step with the account most recently
 * active on the same conversation.
 *
 * A sweep already brings a copy in with the flag its source wore *at the
 * moment it was copied* (`buildFosterCopy` — always unarchived, unless the
 * branch pass archived it on purpose, `FosteredEvent.archived`), and never
 * touches it again. So an archived conversation later reopened in the
 * account it came from — or a native conversation somebody archived in one
 * account and kept working in another — stays out of step in every other
 * account for as long as foster runs: the sidebar reads as if the work had
 * stopped, or as if it had not, depending on which side you look from.
 *
 * "Most recently active" is the same `activityOf`/`byRecency` ordering the
 * rest of this codebase already reads a conversation's own freshness by
 * (`domain/filter.ts`), asked across every card sharing a `cliSessionId` —
 * copies and native cards alike, in every account but the target. Nothing
 * here rescans; it is handed the cards a sweep already read (see `runSweep`
 * passing cards to `planTitleSync` for the shape this follows).
 *
 * **Only a source that moved on after this row was last used here is ever
 * followed — for every row, copy or native, with or without a ledger
 * record.** `bestSource.lastActivityAt` has to be strictly greater than this
 * card's own `lastActivityAt`, or the row is left alone (`used-here-last`).
 * This is not an optimisation, it is the rule that keeps an on-purpose change
 * safe: the house's own archive ritual archives a session in the account it
 * ran in, which gives that account the higher activity, and leaves every
 * other account's card on the same conversation unarchived and — because
 * nothing has touched it since — older. A check that asked only "does foster
 * own this flag" and not "did the source actually move on" would still let
 * that older, untouched, unarchived card in another account undo the very
 * archive the ritual just made on purpose, the moment a sweep next ran into
 * the account holding it. A first version of this pass made exactly that
 * mistake for an old copy with no ledger record at all — trusting a "safe to
 * sync" default the moment the source disagreed, recency unchecked — and it
 * is why the check is now unconditional rather than only asked for a native
 * card.
 *
 * **Local change wins, once the recency gate above has already been
 * passed.** A target card whose current flag is not the one *foster itself*
 * last set is left alone (`changed-by-hand`) — read from the ledger, never
 * guessed from the strings on disk. `lastForsterArchiveWrite`
 * (`ledger/project.ts`) answers that for a card either of `archive_synced` or
 * a `card_retitled` carrying `toArchived` has touched before: whichever of
 * the two wrote last wins. A card neither writer has ever touched has no such
 * record, and is simply followed, once recency has already cleared it —
 * except a copy the branch pass archived on purpose
 * (`FosteredEvent.archived`/`ActiveFostering.archivedByFoster`), which is
 * that pass's own decision to own, the same as a title mark, and is left
 * alone here (`foster-marked`) rather than second-guessed.
 *
 * **A tie in recency settles nothing.** Two cards can carry the identical
 * `lastActivityAt` — a spawned or never-opened card in particular, whose
 * activity is whatever placeholder timestamp it was seeded with rather than a
 * real moment — and when the tied cards disagree on the flag, picking one
 * over the other would be an arbitrary array-order accident, not a read of
 * which account was really more recent. Such a card is left alone rather than
 * guessed at.
 *
 * **Marks are never touched.** A title carrying a mark this ledger has ever
 * seen foster write (`templatesSeen`, the same set `titleSync.ts` reads) is
 * the branch or second-file pass's own row, and neither the archived flag it
 * was filed under nor its tip counterpart is this pass's to move — see
 * `markedThisRound` for the same-run half of that rule, needed because a row
 * this very sweep round just marked has no `card_retitled` in the ledger yet
 * for `lastForsterArchiveWrite` to have read.
 */

export interface ArchiveSyncItem {
  /** The card to rewrite. */
  path: string;
  sessionId: string;
  /** The account directory the card sits in. */
  target: AccountRef;
  /** The flag it carries now. */
  from: boolean;
  /** The flag it will carry. */
  to: boolean;
  /** True when the app made this card rather than foster. */
  native: boolean;
  /** The card whose account was most recently active, for the report. */
  sourceSessionId?: string;
  /**
   * Why this card may be rewritten: `copy-follows-source` — a copy, the
   * source moved on after this row was last used here, and nothing here
   * disagrees with the flag foster itself last set (or nothing has ever set
   * one); `native-follows-newer-source` — the same, for a native card.
   */
  because: 'copy-follows-source' | 'native-follows-newer-source';
}

export interface ArchiveSyncSkipped {
  sessionId: string;
  /**
   * `no-source` — no other account has a card on this conversation at all;
   * `already-matches` — the flag already agrees with the most recent source;
   * `tied-sources` — two or more sources tie for most recently active and
   * disagree on the flag, so "most recent" cannot settle it; `marked` — the
   * row wears a mark from the branch or second-file pass; `used-here-last` —
   * the source is not strictly more recently active than this row's own
   * `lastActivityAt`, so following it could undo an on-purpose change made
   * here after the source's own last activity — see the module doc;
   * `changed-by-hand` — the flag disagrees with the last value foster itself
   * set, so a person changed it since; `foster-marked` — a copy the branch
   * pass archived on purpose (`FosteredEvent.archived`), which is that
   * pass's own decision to own, not this pass's to second-guess.
   */
  reason:
    | 'no-source'
    | 'already-matches'
    | 'tied-sources'
    | 'marked'
    | 'used-here-last'
    | 'app-archives'
    | 'changed-by-hand'
    | 'foster-marked';
}

export interface PlanArchiveSyncResult {
  items: ArchiveSyncItem[];
  skipped: ArchiveSyncSkipped[];
}

function fosteringOf(state: LedgerState, sessionId: string): ActiveFostering | undefined {
  return state.active.get(sessionId);
}

export interface PlanArchiveSyncOptions {
  target: AccountRef;
  /** This account's own cards, read after every earlier pass has written. */
  targetCards: readonly DiscoveredSession[];
  /** Every other account's cards, from the same scan the sweep already took. */
  otherCards: readonly DiscoveredSession[];
  state?: LedgerState;
  /** Extra templates this run knows about that are not in the ledger yet. */
  runTemplates?: readonly string[];
  /**
   * Session ids the branch or second-file pass marked earlier in this same
   * round — no `card_retitled` for them has reached the ledger's fold yet,
   * so `lastForsterArchiveWrite` cannot see the mark on its own.
   */
  markedThisRound?: ReadonlySet<string>;
  /**
   * The app's own `ccAutoArchiveOnPrClose`. When on, a row carrying a pull request is never
   * un-archived here: the app archives it again at its next start (`appArchivesOnPrClose`).
   */
  appArchivesOnPrClose?: boolean;
}

export function planArchiveSync(
  ledger: Ledger,
  options: PlanArchiveSyncOptions,
): PlanArchiveSyncResult {
  const { target, targetCards, otherCards } = options;
  const state = options.state ?? project(ledger.read());
  const templates = [
    ...new Set([...(options.runTemplates ?? []), ...templatesSeen(ledger.read())]),
  ].filter((template) => template !== '');
  const markedThisRound = options.markedThisRound ?? new Set<string>();

  const bySource = new Map<string, DiscoveredSession[]>();
  for (const session of otherCards) {
    const id = session.data.cliSessionId?.toLowerCase();
    if (!id) continue;
    // A row a sweep marked in another account — "(stale…)", "(other file…)" —
    // wears the archived flag that pass filed it under, not the state of the
    // conversation; following it would archive this account's clean row.
    const sourceTitle = session.data.title ?? '';
    if (stripMarks(sourceTitle, templates) !== sourceTitle || looksMarked(sourceTitle)) continue;
    const list = bySource.get(id) ?? [];
    list.push(session);
    bySource.set(id, list);
  }

  const items: ArchiveSyncItem[] = [];
  const skipped: ArchiveSyncSkipped[] = [];

  for (const card of targetCards) {
    const cliId = card.data.cliSessionId?.toLowerCase();
    const sessionId = card.data.sessionId;
    if (!cliId) continue;

    const sources = bySource.get(cliId);
    if (!sources || sources.length === 0) {
      skipped.push({ sessionId, reason: 'no-source' });
      continue;
    }

    const ranked = byRecency(sources);
    const bestSource = ranked[0]!;
    const topActivity = activityOf(bestSource);
    const tied = ranked.filter((s) => activityOf(s) === topActivity);
    if (tied.some((s) => Boolean(s.data.isArchived) !== Boolean(bestSource.data.isArchived))) {
      skipped.push({ sessionId, reason: 'tied-sources' });
      continue;
    }
    const desired = Boolean(bestSource.data.isArchived);
    const current = Boolean(card.data.isArchived);
    if (desired === current) {
      skipped.push({ sessionId, reason: 'already-matches' });
      continue;
    }

    if (
      !desired &&
      appArchivesOnPrClose(card.data as { prs?: unknown }, options.appArchivesOnPrClose ?? false)
    ) {
      skipped.push({ sessionId, reason: 'app-archives' });
      continue;
    }

    const title = card.data.title ?? '';
    if (stripMarks(title, templates) !== title || markedThisRound.has(sessionId)) {
      skipped.push({ sessionId, reason: 'marked' });
      continue;
    }

    // The one gate every row goes through, copy or native, ledger record or
    // not: a source is only ever followed once it has genuinely moved on
    // *after* this very row was last used here. See the module doc — this is
    // what stops an on-purpose archive (or unarchive) from being undone by
    // an older, untouched card in another account.
    const hereActivity = card.data.lastActivityAt ?? 0;
    const sourceActivity = bestSource.data.lastActivityAt ?? 0;
    if (!(sourceActivity > hereActivity)) {
      skipped.push({ sessionId, reason: 'used-here-last' });
      continue;
    }

    const fostering = fosteringOf(state, sessionId);
    const established = lastForsterArchiveWrite(state, sessionId);

    let because: ArchiveSyncItem['because'];
    if (established) {
      if (current !== established.value) {
        skipped.push({ sessionId, reason: 'changed-by-hand' });
        continue;
      }
      because = fostering ? 'copy-follows-source' : 'native-follows-newer-source';
    } else if (fostering) {
      if (fostering.archivedByFoster) {
        // The branch pass filed this row away on purpose — its own decision
        // to own, not an inherited default this pass may reconsider.
        skipped.push({ sessionId, reason: 'foster-marked' });
        continue;
      }
      because = 'copy-follows-source';
    } else {
      because = 'native-follows-newer-source';
    }

    items.push({
      path: card.path,
      sessionId,
      target,
      from: current,
      to: desired,
      native: !fostering,
      sourceSessionId: bestSource.data.sessionId,
      because,
    });
  }

  return { items, skipped };
}

export interface ArchiveSyncOutcome {
  path: string;
  sessionId: string;
  from: boolean;
  to: boolean;
  status: 'written' | 'skipped' | 'failed';
  detail?: string;
}

export interface ApplyArchiveSyncOptions {
  ledger: Ledger;
  dryRun?: boolean;
}

/**
 * Write the plan. Same writer `retitle.ts` uses (`writeFileAtomic`), and the
 * same no-closed-app-guard reasoning: a lost write costs a mark the next
 * sweep round puts back, never a silent divergence, since the plan is always
 * computed fresh from what is on disk.
 */
export function applyArchiveSync(
  items: readonly ArchiveSyncItem[],
  options: ApplyArchiveSyncOptions,
): ArchiveSyncOutcome[] {
  const { ledger, dryRun = false } = options;
  const outcomes: ArchiveSyncOutcome[] = [];

  for (const item of items) {
    const data = readSessionFile(item.path);
    if (!data) {
      outcomes.push({
        path: item.path,
        sessionId: item.sessionId,
        from: item.from,
        to: item.to,
        status: 'failed',
        detail: 'the card could not be read',
      });
      continue;
    }

    const from = Boolean(data.isArchived);
    if (from === item.to) {
      outcomes.push({
        path: item.path,
        sessionId: data.sessionId,
        from,
        to: item.to,
        status: 'skipped',
        detail: 'already says so',
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        path: item.path,
        sessionId: data.sessionId,
        from,
        to: item.to,
        status: 'written',
      });
      continue;
    }

    try {
      const written = { ...data, isArchived: item.to };
      writeFileAtomic(item.path, JSON.stringify(written));
      ledger.append({
        kind: 'archive_synced',
        sessionId: data.sessionId,
        target: item.target,
        path: item.path,
        from,
        to: item.to,
        native: item.native,
        ...(item.sourceSessionId ? { sourceSessionId: item.sourceSessionId } : {}),
      });
      outcomes.push({
        path: item.path,
        sessionId: data.sessionId,
        from,
        to: item.to,
        status: 'written',
      });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'archive_sync', reason });
      outcomes.push({
        path: item.path,
        sessionId: data.sessionId,
        from,
        to: item.to,
        status: 'failed',
        detail: reason,
      });
    }
  }

  return outcomes;
}
