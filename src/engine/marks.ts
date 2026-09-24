import { UNTITLED } from '../domain/fostering.js';
import { looksMarked, staleMatcher, stampWithin, stripMarks } from '../domain/stale.js';
import type { DiscoveredSession } from '../domain/types.js';
import type { LedgerState } from '../ledger/project.js';
import type { LedgerEvent } from '../ledger/types.js';
import type { RetitleRequest } from './retitle.js';

/**
 * Putting a mark on a row, and taking one off.
 *
 * Two passes decide that a row is not the one to continue in, for two different
 * reasons. `branchCards.ts` decides it among the branches of a fork; `fileCards.ts`
 * decides it among the rows of one conversation that opens more than one file.
 * What they do about it is the same write, and the rules that make that write
 * safe were learned the hard way — recognising a mark an earlier run wrote in
 * other words (#35), leaving a row alone once recognised, and never stacking a
 * mark in front of one this run cannot explain. Written once here so the two
 * passes cannot drift apart on any of it.
 */

/**
 * What a row is left wearing when foster cannot account for its mark.
 *
 * Shared with `cli/render.ts`, which counts and names these rows in the sweep
 * summary, and with the tests that pin the shape down — a string typed once
 * cannot drift between the place that writes it and the place that reads it.
 */
export const UNKNOWN_MARK_DETAIL = 'wears a mark foster cannot account for — left as it is';

/**
 * What to do about one card — write a mark, leave it because there is nothing
 * to change, or leave it because it is already wearing a mark this run cannot
 * account for.
 */
export type MarkDecision =
  { kind: 'write'; request: RetitleRequest } | { kind: 'unknown-mark' } | { kind: 'none' };

export interface MarkContext {
  /** Why the write is being made, recorded on the event. */
  as: RetitleRequest['as'];
  /** The mark to wear, moment already filled in. Empty means: take one off. */
  mark: string;
  /** The template `mark` was made from. Absent when the write removes a mark. */
  template?: string;
  /** Every template this run knows about, its own and the ledger's. */
  templates: readonly string[];
  /** Copies foster itself filed away — the only ones it lifts back out. */
  archivedByFoster: Set<string>;
  /** True to file the row in the archived view; false to lift foster's own filing. */
  file: boolean;
}

/**
 * Copies foster itself filed away, by session id — the only ones a card
 * turning out to be the row to continue in may be lifted back out of the
 * archived view for. A flag the user set by hand is the user's, whatever this
 * pass now thinks of the row.
 *
 * `branchCards.ts` and `fileCards.ts` computed this identically side by side;
 * shared here so the two cannot drift.
 */
export function archivedByFosterIds(state: LedgerState): Set<string> {
  const ids = new Set<string>();
  for (const fostering of state.active.values()) {
    if (fostering.archivedByFoster) ids.add(fostering.copySessionId);
  }
  for (const card of state.retitled.values()) {
    if (card.toArchived) ids.add(card.sessionId);
  }
  return ids;
}

/**
 * The last `as` the ledger recorded for each session id — last entry wins,
 * because the marking passes undo each other's marks by design: a row marked
 * stale that turns out to be the branch that carried on is written back as
 * `tip`, and after that it is nobody's but that pass's again.
 *
 * A copy `branchCards.ts` brings in already wearing a mark is folded in as
 * `stale` too — it was born on the losing side of a fork just as much as a
 * card rewritten in place, and `fileCards.ts`'s own reading of "which rows
 * has the branch pass already spoken for" needs to see it the same way.
 *
 * `branchCards.ts` and `fileCards.ts` each built this fold themselves, one
 * reading `card_retitled` alone and the other adding `fostered`; the same map
 * answers both, and each caller keeps only the `as` values that are its own
 * to answer for.
 */
export function lastMarkedAs(events: readonly LedgerEvent[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const event of events) {
    if (event.kind === 'fostered' && event.template !== undefined) {
      last.set(event.copySessionId, 'stale');
    } else if (event.kind === 'card_retitled') {
      last.set(event.sessionId, event.as);
    }
  }
  return last;
}

export function markFor(card: DiscoveredSession, context: MarkContext): MarkDecision {
  const { as, mark, template, templates, archivedByFoster, file } = context;
  const current = card.data.title ?? '';
  const clean = stripMarks(current, templates);

  // Every template this run knows about is already off. A title that still
  // looks marked wears one from a foster this run cannot explain, or a hand
  // edit shaped like one — either way, guessing at it is how a mark this run
  // does not recognise gets a second mark stacked in front of it.
  if (looksMarked(clean)) return { kind: 'unknown-mark' };

  const freshTitle = mark === '' ? clean : `${mark}${clean.trim() ? clean : UNTITLED}`;

  // What the card already wears, with the recognised mark taken off — the
  // stripped-away prefix rather than the clean title left behind.
  const existingMark = current.slice(0, current.length - clean.length);

  // Recognising an old mark is only half of #35's fix. The other half: a row
  // already wearing a mark for the very moment this run would stamp it with
  // is left exactly as it is, whatever words that mark used — only a
  // genuinely different moment (the row's situation actually changed) or a
  // write that wants no mark at all earns a rewrite. Comparing the moment
  // rather than the string is what keeps a `--stale-prefix` chosen today from
  // turning into a rewrite of every row an earlier run marked in different
  // words.
  const alreadyCurrent =
    mark !== '' &&
    existingMark !== '' &&
    stampWithin(existingMark) !== undefined &&
    stampWithin(existingMark) === stampWithin(mark);
  const title = alreadyCurrent ? current : freshTitle;

  // Only a row this run is setting aside is filed away. One it is promoting
  // comes back out of the archived view when foster is the one that put it
  // there — an earlier sweep, ranking by another measure, filed the row the
  // user was working in; a flag the user set is still the user's.
  let archived: boolean | undefined;
  if (file) {
    if (!card.data.isArchived) archived = true;
  } else if (card.data.isArchived && archivedByFoster.has(card.data.sessionId)) {
    archived = false;
  }

  if (title === current && archived === undefined) return { kind: 'none' };

  // A write that puts a mark on records the template it was just given, unless
  // the row's existing words are being kept as they are — then it is whichever
  // known template those words came from. A write that takes a mark off records
  // whichever known template explains the mark it just removed — undefined when
  // none does.
  const recorded =
    mark === '' || alreadyCurrent ? templateResponsibleFor(current, templates) : template;

  return {
    kind: 'write',
    request: {
      path: card.path,
      target: card.account,
      native: !card.isCopy,
      title,
      ...(archived === undefined ? {} : { archived }),
      as,
      ...(recorded ? { template: recorded } : {}),
    },
  };
}

/**
 * Which known template explains the mark at the front of `title`, when one
 * does — the first that matches, since a mark this run is about to remove was
 * itself written by exactly one of them (or by none, if the title carries no
 * mark at all).
 */
export function templateResponsibleFor(
  title: string,
  templates: readonly string[],
): string | undefined {
  return templates.find((template) => template !== '' && staleMatcher(template).test(title));
}
