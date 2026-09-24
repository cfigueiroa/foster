import type { AccountRef, CodeSessionData } from '../domain/types.js';
import type { CardRetitledEvent, LedgerEvent } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import type { RetitleRequest } from './retitle.js';

/**
 * Marks the app undid while it was open, written again while it is closed.
 *
 * `retitle.ts` writes a card with the app running, on purpose, and says what it
 * costs: the app can save a card it holds in memory back over the write. Measured
 * 24/09/2026 on a real store: one `/fosteia` marked 49 rows "(outro arquivo, …)",
 * and within three minutes the running app had written 10 of them back under
 * their old titles — no foster event in between, and the run's own re-plan had
 * already passed, so it said nothing. The next sweep put 3 back, the one after
 * that the other 7. Three whole runs, for marks this run had already decided.
 *
 * So the gap that `foster layout --yes --restart` (and `sweep --restart`) opens
 * with the app closed puts them back, from the ledger alone: for every card of
 * this account whose last recorded write is a retitle, a card that now shows a
 * title foster has seen it wear *before* that write is one the app reverted,
 * and gets the write again — title, and the archived flag the write set. A card
 * showing any other title was renamed by somebody and is left alone, the rule
 * every other pass here keeps. Written while the app is down, it is what the app
 * reads when it starts, so it holds.
 *
 * The one reading this cannot tell apart: a row renamed by hand to exactly a
 * title it wore before. The sweep's own plan would mark that row again on its
 * next run just the same, so this is no bolder than the pass that wrote it.
 */

function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid;
}

export function planMarksBack(
  events: readonly LedgerEvent[],
  target: AccountRef,
  read: (file: string) => CodeSessionData | undefined = readSessionFile,
): RetitleRequest[] {
  const last = new Map<string, CardRetitledEvent>();
  const worn = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== 'card_retitled' || !sameAccount(event.target, target)) continue;
    const titles = worn.get(event.sessionId) ?? new Set<string>();
    titles.add(event.from);
    const previous = last.get(event.sessionId);
    if (previous) titles.add(previous.to);
    worn.set(event.sessionId, titles);
    last.set(event.sessionId, event);
  }

  const requests: RetitleRequest[] = [];
  for (const [sessionId, event] of last) {
    const card = read(event.path);
    if (!card) continue;
    const now = card.title ?? '';
    if (now === event.to) continue;
    const before = worn.get(sessionId)!;
    // A title this card has worn and that the last write moved it off. The
    // write's own target is excluded: a card that went back and forth between
    // two titles must not read its current, intended one as a reversion.
    before.delete(event.to);
    if (!before.has(now)) continue;
    requests.push({
      path: event.path,
      target: event.target,
      native: event.native,
      title: event.to,
      ...(event.toArchived === undefined ? {} : { archived: event.toArchived }),
      as: event.as ?? 'stale',
      ...(event.template ? { template: event.template } : {}),
    });
  }
  return requests;
}
