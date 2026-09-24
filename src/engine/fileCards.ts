import { UNTITLED } from '../domain/fostering.js';
import { staleMark, stripMarks, templatesSeen } from '../domain/stale.js';
import type { DiscoveredSession } from '../domain/types.js';
import type { LedgerState } from '../ledger/project.js';
import type { Ledger } from '../ledger/log.js';
import type { LedgerEvent } from '../ledger/types.js';
import { fileOpenedFrom, type ConversationScan } from '../store/transcripts.js';
import { weighScans, type ScanWeight } from './branches.js';
import type { Lineage } from './lineage.js';
import { archivedByFosterIds, lastMarkedAs, markFor, UNKNOWN_MARK_DETAIL } from './marks.js';
import { retitleCards, type RetitleOutcome, type RetitleRequest } from './retitle.js';

/**
 * One conversation, two rows, and the rows say which one to continue in.
 *
 * This is the sibling of `branchCards.ts`, for the case that is not a fork. A
 * `cliSessionId` names a conversation, not a file: the app opens the transcript
 * under the project directory for the card's own working directory, so
 * continuing one conversation from a repository and from a worktree cut out of
 * it leaves two files under one id, each holding what was written while its own
 * card was in use. The sweep brings both rows on purpose — each opens records
 * the other cannot (`executor.ts`) — and until now they arrived wearing the
 * same title, with nothing to say which was which.
 *
 * Measured on a real store (19/09/2026, 1272 copies into one account): 12 such
 * pairs with both rows in the sidebar. The repository's file was the fuller one
 * in 7 and the worktree's in 5, so no rule of thumb about which side wins; 4
 * pairs had a second row that opened no file at all; and the app archived the
 * loser by itself in 10 of the 12 — but only after one of the rows was used,
 * which is exactly the choice the reader was making blind.
 *
 * So this pass makes the choice and says so. **The row to continue in is the one
 * whose last answer is the most recent** — where the work was left — and it keeps
 * its title, coming back out of the archived view if foster is what filed it.
 * Every other row of that conversation wears a dated mark and is filed away:
 * still there, still opens, no longer competing for the click. Nothing is merged
 * and no transcript is rewritten; the two files stay two files.
 *
 * What it refuses to touch is as deliberate as what it marks. A row opening the
 * *same* file as the row to continue in is not this pass's business — that is a
 * duplicate, a different problem. A conversation whose rows all open nothing has
 * no measurable answer, so it is left alone rather than guessed at. And a live
 * `claude` writing the conversation stops the write, the way every other pass
 * treats a conversation with a writer in it.
 */

/** One row of a conversation this account shows more than once. */
export interface FileRow {
  /** The card's own id in this account. */
  sessionId: string;
  /** What it is called now, mark and all. */
  title: string;
  /** The transcript it opens, when that can be told at all. */
  file?: string;
  /** Records that file holds. Zero when it opens none. */
  total: number;
  /** Records no other file of this conversation holds. */
  only: number;
  /** Its last answer — what the mark is stamped with. */
  stoppedAt?: number;
  /** True for the row to continue in. */
  working: boolean;
  action: 'keep' | 'retitle' | 'none';
}

export interface FilePlan {
  cliSessionId: string;
  /**
   * The row to continue in: its id, and the title it wears once any mark is
   * off. The sweep's pin pass needs both — a pin sitting on a row this pass
   * just filed away has to be moved onto something, and this is it.
   */
  working: { sessionId: string; title: string };
  rows: FileRow[];
  retitle: RetitleRequest[];
  /** Rows left as they are, and why. */
  skipped: { sessionId: string; title: string; detail: string }[];
}

export interface FilePlanInput {
  /** The destination's cards on disk, copies this run just wrote included. */
  hereCards: DiscoveredSession[];
  kin: Lineage;
  /** What the row that is not the one to continue in wears. */
  otherFileTemplate: string;
  /**
   * The marks the run's other passes write, so a row already wearing one of
   * them is recognised rather than marked twice.
   */
  otherTemplates: readonly string[];
  /** Conversations a live `claude` is writing, lower-cased. */
  live: ReadonlySet<string>;
  state: LedgerState;
  /** The ledger's raw events, for `templatesSeen` — see `domain/stale.ts` (#35). */
  events: readonly LedgerEvent[];
}

export const LIVE_WRITER_DETAIL = 'a live claude is writing this conversation — left as it is';

export function planFileCards(input: FilePlanInput): FilePlan[] {
  const { hereCards, kin, otherFileTemplate, otherTemplates, live, state, events } = input;
  const templates = [...new Set([otherFileTemplate, ...otherTemplates, ...templatesSeen(events)])];

  // Cards foster itself filed away. Only those are lifted back out when the row
  // turns out to be the one to continue in: a flag the user set is the user's.
  const archivedByFoster = archivedByFosterIds(state);

  const branchDecided = branchMarkedIds(events);
  const plans: FilePlan[] = [];

  for (const [, cards] of groupByConversation(hereCards)) {
    if (cards.length < 2) continue;
    const id = cards[0]!.data.cliSessionId!;

    // A row the branch pass has spoken about is its to speak about. The two
    // passes answer different questions — which branch of a fork carried on,
    // and which file of one conversation was written to last — and a row can
    // be on the losing side of both. Marking it here would replace a true
    // statement about its branch with a true statement about its file, and the
    // branch is the one that decides whether the row belongs in the sidebar at
    // all. Measured as a real conflict: a stale branch whose conversation is
    // also held in two files came out of the sweep wearing this pass's mark
    // instead of the one that had just been written for it.
    if (cards.some((card) => branchDecided.has(card.data.sessionId))) continue;

    // One file is the whole conversation, so every row here opens the same
    // thing: a duplicate, which this pass has nothing to say about.
    const files = kin.transcripts().get(id) ?? [];
    if (files.length < 2) continue;

    const opens = new Map<string, string | undefined>();
    const scans = new Map<string, ConversationScan>();
    for (const card of cards) {
      const file = fileOpenedFrom(files, card.data.cwd);
      opens.set(card.data.sessionId, file);
      if (file === undefined || scans.has(file)) continue;
      const scan = kin.reachOf(id, card.data.cwd);
      if (scan) scans.set(file, scan);
    }

    // Keyed by file rather than by card: two rows opening one file must be
    // weighed once, or each would count the other as a holder and both would
    // come back holding nothing of their own.
    const weights = weighScans(scans);
    const weightOf = (card: DiscoveredSession): ScanWeight | undefined => {
      const file = opens.get(card.data.sessionId);
      return file === undefined ? undefined : weights.get(file);
    };

    // Nothing measurable to choose between: left alone rather than guessed at.
    const readable = cards.filter((card) => weightOf(card) !== undefined);
    if (readable.length === 0) continue;

    const working = [...readable].sort((a, b) =>
      byContinuation(weightOf(a)!, weightOf(b)!, a.data.sessionId, b.data.sessionId),
    )[0]!;
    const workingFile = opens.get(working.data.sessionId);
    if (cards.every((card) => opens.get(card.data.sessionId) === workingFile)) continue;

    const plan: FilePlan = {
      cliSessionId: id,
      working: {
        sessionId: working.data.sessionId,
        title: stripMarks(working.data.title ?? '', templates),
      },
      rows: [],
      retitle: [],
      skipped: [],
    };

    for (const card of cards) {
      const weight = weightOf(card);
      const file = opens.get(card.data.sessionId);
      const isWorking = card.data.sessionId === working.data.sessionId;
      // A row opening the same file as the row to continue in is a duplicate,
      // not the other file of the conversation. Saying "other file" on it would
      // be a claim about the disk that is simply untrue.
      const sameFile = !isWorking && file !== undefined && file === workingFile;
      const stoppedAt = weight?.lastAssistantAt ?? weight?.lastMessageAt;
      const row: FileRow = {
        sessionId: card.data.sessionId,
        title: card.data.title ?? UNTITLED,
        ...(file === undefined ? {} : { file }),
        total: weight?.total ?? 0,
        only: weight?.only ?? 0,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        working: isWorking,
        action: sameFile ? 'none' : 'keep',
      };

      if (!sameFile) {
        const mark = isWorking ? '' : staleMark(otherFileTemplate, stoppedAt);
        const decision = markFor(card, {
          as: isWorking ? 'tip' : 'other-file',
          mark,
          ...(isWorking ? {} : { template: otherFileTemplate }),
          templates,
          archivedByFoster,
          file: !isWorking,
        });
        if (decision.kind === 'unknown-mark') {
          plan.skipped.push({
            sessionId: card.data.sessionId,
            title: card.data.title ?? UNTITLED,
            detail: UNKNOWN_MARK_DETAIL,
          });
        } else if (decision.kind === 'write') {
          if (live.has(id.toLowerCase())) {
            plan.skipped.push({
              sessionId: card.data.sessionId,
              title: card.data.title ?? UNTITLED,
              detail: LIVE_WRITER_DETAIL,
            });
          } else {
            plan.retitle.push(decision.request);
            row.action = 'retitle';
          }
        }
      }

      plan.rows.push(row);
    }

    // Both rows were already saying the right thing: no plan, nothing to report,
    // and — the part that matters — nothing for the confirmation to count as
    // unfinished on a second run.
    if (plan.retitle.length === 0 && plan.skipped.length === 0) continue;
    plans.push(plan);
  }

  return plans;
}

export interface FileCardsResult {
  plans: FilePlan[];
  retitled: RetitleOutcome[];
  /** Rows this pass filed into the archived view. */
  archived: number;
}

export function applyFileCards(
  plans: FilePlan[],
  options: { ledger: Ledger; dryRun?: boolean },
): FileCardsResult {
  const retitled: RetitleOutcome[] = [];
  let archived = 0;

  for (const plan of plans) {
    const marks = retitleCards(plan.retitle, {
      ledger: options.ledger,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    });
    for (const outcome of marks) {
      if (outcome.status === 'retitled' && outcome.archived?.to) archived += 1;
    }
    retitled.push(...marks);
  }

  return { plans, retitled, archived };
}

/**
 * Where the work was left, which is what decides the row to continue in.
 *
 * The last *answer*, never the last record: opening a row appends a user record
 * with today's timestamp and no answer after it, so a row that was merely
 * clicked would otherwise outrank the one that was worked in — the same trap
 * `branches.ts` documents for mtime. Ties fall back to `only` — what a row
 * holds that no other file of the conversation holds — before `lastMessageAt`,
 * on purpose: a mere click changes `lastMessageAt` (that is the whole reason
 * `lastAssistantAt` is asked first), so a tied election that fell back to it
 * would flip the moment somebody opened the row this pass had just filed away.
 * `only` does not move on a click. After that, sheer size, then the id, so the
 * answer never depends on which card the scan listed first.
 *
 * This is the one election a "which row is the row to continue in" caller
 * should ever run — `where.ts`'s report imports it rather than keeping its
 * own copy, precisely so the two never drift into naming different rows for
 * the same conversation (milestone review, 0.62.0: they once did, `only`
 * and `lastMessageAt` swapped between the two).
 */
export function byContinuation(a: ScanWeight, b: ScanWeight, idA: string, idB: string): number {
  const answered = (b.lastAssistantAt ?? 0) - (a.lastAssistantAt ?? 0);
  if (answered !== 0) return answered;
  if (a.only !== b.only) return b.only - a.only;
  const said = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
  if (said !== 0) return said;
  if (a.total !== b.total) return b.total - a.total;
  return idA.localeCompare(idB);
}

/**
 * Cards whose title the branch pass is responsible for. `lastMarkedAs`
 * (`marks.ts`) does the fold this pass and `branchCards.ts` used to each do
 * their own way; this keeps only the `as` values that are the branch pass's.
 */
function branchMarkedIds(events: readonly LedgerEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const [id, as] of lastMarkedAs(events)) if (as === 'stale' || as === 'diverged') ids.add(id);
  return ids;
}

/** The destination's cards, by the conversation they open. Case folded, as ids are everywhere. */
function groupByConversation(cards: DiscoveredSession[]): Map<string, DiscoveredSession[]> {
  const groups = new Map<string, DiscoveredSession[]>();
  for (const card of cards) {
    const id = card.data.cliSessionId;
    if (!id) continue;
    const key = id.toLowerCase();
    const found = groups.get(key);
    if (found) found.push(card);
    else groups.set(key, [card]);
  }
  return groups;
}
