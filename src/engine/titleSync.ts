import { layoutFor, sessionPath } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project, type LedgerState } from '../ledger/project.js';
import type { ActiveFostering, RetitledCard } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import { retitleCards, type RetitleOutcome } from './retitle.js';

/**
 * Bring a copy's title back into step with the original's.
 *
 * A copy carries the title of the instant it was made, and every later sweep
 * sees it as already fostered and walks past. So a conversation renamed in the
 * account it came from keeps the old name in every other account for ever
 * (#17) — the sidebar reads as if the work were missing, when only its name is.
 * Nothing about the mechanics was in the way: `retitle.ts` has rewritten titles
 * with the app open since 0.37.0. The step was missing, not the ability.
 *
 * Three decisions hold this together, and all three come from the ledger rather
 * than from reading strings.
 *
 * **Whose title wins.** Only a copy still wearing the last title foster itself
 * wrote is rewritten. That is `card_retitled.to` when foster has marked the card
 * since, and the fostering's `originalTitle` otherwise. A copy the user renamed
 * by hand matches neither and is left alone — measured on a real store, 875 of
 * 911 copies still matched, 9 wore a mark, and the single hand-renamed one was
 * exactly the row that must not be trampled.
 *
 * **Marks are kept, and never copied.** The mark a branch wears is not part of
 * its name, so it survives the rewrite; and a mark the *origin* happens to wear
 * is not carried over, or the two would stack. Both are derived from the same
 * record rather than matched by prefix: `card_retitled` holds the title before
 * the mark and after it, so whatever precedes `from` inside `to` is the mark,
 * exactly. That is what keeps this clear of #35 — a run does not have to be told
 * the words a mark was written with in order to recognise it.
 *
 * **Cards are paired by card, never by conversation.** A title lives on a card;
 * one conversation becomes a card per account and another per branch. The ledger
 * already records which card was copied from which, and on the same store 85
 * fosterings carry no `cliSessionId` at all — pairing on the transcript would
 * silently drop them.
 *
 * Only the title crosses. `card_retitled` carries the archived flag too, and
 * following that as well would make this state sync: whether a branch belongs in
 * the archived view is the sweep's own decision, taken per branch, and not this
 * pass's to overrule.
 */

export interface TitleSyncItem {
  /** The copy to rewrite. */
  path: string;
  copySessionId: string;
  /** The account directory the copy sits in. */
  target: AccountRef;
  /** What the copy is called now. */
  from: string;
  /** What it will be called: the original's own title, behind any mark it wears. */
  to: string;
  /** The mark being preserved, when the copy wears one. */
  mark?: string;
}

export interface TitleSyncSkipped {
  copySessionId: string;
  /**
   * `renamed-here` — the copy no longer says what foster last wrote, so somebody
   * chose its name; `no-baseline` — nothing records what foster wrote and the
   * copy is not blank, so there is nothing to compare against; `unknown-mark` —
   * foster marked this card but the mark cannot be told from the title beneath
   * it; `origin-gone` — the card it was copied from can no longer be read.
   */
  reason: 'renamed-here' | 'no-baseline' | 'unknown-mark' | 'origin-gone';
}

export interface PlanTitleSyncResult {
  items: TitleSyncItem[];
  skipped: TitleSyncSkipped[];
}

/**
 * What a copy's title is compared against: the last title foster wrote on it,
 * and the mark that title carries.
 *
 * `card_retitled` wins over the fostering's `originalTitle` because it is later
 * — the branch pass may have marked this very card since it was made.
 *
 * The mark is derived against the title the copy was *made* with, never against
 * `card_retitled.from`. A card marked twice — stale on one run, then diverged on
 * the next, which #35 makes ordinary — has a `from` that already carries the
 * earlier mark, and subtracting that leaves nothing. Measured on a real store,
 * that is exactly what happened: a row wearing "(outro ramo, seguiu 26/08 14:24)"
 * was planned to lose it. When neither reading lands on a mark this can prove,
 * the copy is left alone rather than rewritten with a guess.
 */
function baselineOf(
  fostering: ActiveFostering,
  retitled: RetitledCard | undefined,
): { title: string; mark: string } | 'unknown-mark' | undefined {
  if (retitled) {
    const made = fostering.originalTitle;
    if (made !== undefined && retitled.to.endsWith(made)) {
      return { title: retitled.to, mark: retitled.to.slice(0, retitled.to.length - made.length) };
    }
    return 'unknown-mark';
  }
  if (fostering.originalTitle === undefined) return undefined;
  return { title: fostering.originalTitle, mark: '' };
}

/** The original's title with any mark of its own taken back off. */
function originTitle(card: { title?: string }, retitled: RetitledCard | undefined): string {
  const title = card.title ?? '';
  if (retitled && title === retitled.to) return retitled.from;
  return title;
}

function storeFor(fostering: ActiveFostering, store: StoreLayout): StoreLayout {
  return fostering.originStore ? layoutFor(fostering.originStore) : store;
}

/**
 * Every copy in one account whose original is called something else now.
 *
 * Read-only: it opens the cards on both sides and writes nothing.
 */
export function planTitleSync(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
  state: LedgerState = project(ledger.read()),
): PlanTitleSyncResult {
  const items: TitleSyncItem[] = [];
  const skipped: TitleSyncSkipped[] = [];

  for (const fostering of listActive(state)) {
    if (
      fostering.target.accountUuid !== target.accountUuid ||
      fostering.target.organizationUuid !== target.organizationUuid
    ) {
      continue;
    }

    const copy = readSessionFile(fostering.copyPath);
    if (!copy) continue;

    const origin = readSessionFile(
      sessionPath(storeFor(fostering, store), fostering.origin, fostering.originSessionId),
    );
    if (!origin) {
      skipped.push({ copySessionId: fostering.copySessionId, reason: 'origin-gone' });
      continue;
    }

    const here = copy.title ?? '';
    const found = baselineOf(fostering, state.retitled.get(fostering.copySessionId));
    if (found === 'unknown-mark') {
      skipped.push({ copySessionId: fostering.copySessionId, reason: 'unknown-mark' });
      continue;
    }
    const baseline = found;

    // A copy of a conversation nobody had named is the one case with nothing to
    // compare and nothing to lose: it still says nothing, so a name arriving now
    // overwrites no decision. 253 of 8357 fosterings on the measured store are
    // exactly this.
    if (!baseline) {
      if (here !== '') {
        skipped.push({ copySessionId: fostering.copySessionId, reason: 'no-baseline' });
        continue;
      }
    } else if (here !== baseline.title) {
      skipped.push({ copySessionId: fostering.copySessionId, reason: 'renamed-here' });
      continue;
    }

    const mark = baseline?.mark ?? '';
    const to = mark + originTitle(origin, state.retitled.get(fostering.originSessionId));
    if (to === here) continue;

    items.push({
      path: fostering.copyPath,
      copySessionId: fostering.copySessionId,
      target: fostering.target,
      from: here,
      to,
      ...(mark ? { mark } : {}),
    });
  }

  return { items, skipped };
}

export interface ApplyTitleSyncOptions {
  ledger: Ledger;
  dryRun?: boolean;
}

/**
 * Write the plan. A copy is never native, so this never touches a card the app
 * made — and, like every other title write, it shows only at the next restart.
 */
export function applyTitleSync(
  items: TitleSyncItem[],
  options: ApplyTitleSyncOptions,
): RetitleOutcome[] {
  return retitleCards(
    items.map((item) => ({
      path: item.path,
      target: item.target,
      native: false,
      title: item.to,
      as: 'synced' as const,
    })),
    { ledger: options.ledger, ...(options.dryRun ? { dryRun: true } : {}) },
  );
}
