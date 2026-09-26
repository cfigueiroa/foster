import { comparablePath, sameAccount, storeRootOfCopy } from '../domain/paths.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../domain/types.js';
import type { ArchiveSyncedEvent, CardRetitledEvent, LedgerEvent } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import type { ArchiveSyncItem } from './archiveSync.js';
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
 * this account in this store whose last recorded write is a retitle, a card that
 * now shows a title foster has seen it wear *before* that write is one the app
 * reverted, and gets the write again — the title, and the archived flag foster
 * last set on it. A card showing any other title was renamed by somebody and is
 * left alone, the rule every other pass here keeps. Written while the app is
 * down, it is what the app reads when it starts, so it holds.
 *
 * Only this store's cards: the ledger remembers every installation foster has
 * written into, and a second profile signed into the same account has an app of
 * its own that this gap never closed.
 *
 * The one reading this cannot tell apart: a row renamed by hand to exactly a
 * title it wore before. The sweep's own plan would mark that row again on its
 * next run just the same, so this is no bolder than the pass that wrote it.
 */
export function planMarksBack(
  events: readonly LedgerEvent[],
  target: AccountRef,
  store: StoreLayout,
  read: (file: string) => CodeSessionData | undefined = readSessionFile,
): RetitleRequest[] {
  const root = comparablePath(store.root);
  const last = new Map<string, CardRetitledEvent>();
  const worn = new Map<string, Set<string>>();
  // Carried forward the way the ledger's own fold carries it: a re-mark that
  // leaves the flag alone records no `toArchived`, and the flag an earlier write
  // set is still the one the card should wear.
  const archived = new Map<string, boolean>();
  for (const event of events) {
    if (event.kind !== 'card_retitled' || !sameAccount(event.target, target)) continue;
    if (comparablePath(storeRootOfCopy(event.path)) !== root) continue;
    const titles = worn.get(event.sessionId) ?? new Set<string>();
    titles.add(event.from);
    const previous = last.get(event.sessionId);
    if (previous) titles.add(previous.to);
    worn.set(event.sessionId, titles);
    last.set(event.sessionId, event);
    if (event.toArchived !== undefined) archived.set(event.sessionId, event.toArchived);
  }

  const requests: RetitleRequest[] = [];
  for (const [sessionId, event] of last) {
    const card = read(event.path);
    if (!card) continue;
    const now = card.title ?? '';
    // A title this card has worn and that the last write moved it off — the
    // write's own title excluded, so a card that went back and forth between two
    // titles never reads its current, intended one as a reversion.
    if (now === event.to || !worn.get(sessionId)!.has(now)) continue;
    const flag = archived.get(sessionId);
    requests.push({
      path: event.path,
      target: event.target,
      native: event.native,
      title: event.to,
      ...(flag === undefined ? {} : { archived: flag }),
      as: event.as,
      ...(event.template ? { template: event.template } : {}),
    });
  }
  return requests;
}

/**
 * `planMarksBack`'s own rule, for `archive_synced` instead of `card_retitled`:
 * a card of this account, in this store, whose *last* archive write this
 * ledger recorded is an `archive_synced`, is written again when the disk now
 * shows the flag that write's own `from` carried — the value the app had
 * before that write, meaning the app has since saved the card back over it.
 *
 * Kept separate from `planMarksBack` rather than folded in: the two events
 * write disjoint fields (a title versus a bare flag) and disjoint files' worth
 * of history to track (`worn` titles have no equivalent boolean shape worth
 * building), and `card_retitled`'s own `toArchived` half is already covered
 * by `planMarksBack` when a mark carries one — this only ever needs to catch
 * up the other writer, `engine/archiveSync.ts`'s own event.
 *
 * Only the *last* archive-touching event per card is read: a `card_retitled`
 * written after this event lands is the newer intent, and revisiting a flag
 * `archive_synced` set before that would fight the more recent write instead
 * of catching up on it — that case is `planMarksBack`'s to answer, not this
 * one's.
 */
export function planArchiveMarksBack(
  events: readonly LedgerEvent[],
  target: AccountRef,
  store: StoreLayout,
  read: (file: string) => CodeSessionData | undefined = readSessionFile,
): ArchiveSyncItem[] {
  const root = comparablePath(store.root);
  const last = new Map<string, ArchiveSyncedEvent | CardRetitledEvent>();
  for (const event of events) {
    if (
      (event.kind !== 'archive_synced' && event.kind !== 'card_retitled') ||
      !sameAccount(event.target, target)
    ) {
      continue;
    }
    if (comparablePath(storeRootOfCopy(event.path)) !== root) continue;
    if (event.kind === 'card_retitled' && event.toArchived === undefined) continue;
    last.set(event.sessionId, event);
  }

  const items: ArchiveSyncItem[] = [];
  for (const [sessionId, event] of last) {
    if (event.kind !== 'archive_synced') continue;
    const card = read(event.path);
    if (!card) continue;
    const now = Boolean(card.isArchived);
    if (now !== event.from || now === event.to) continue;
    items.push({
      path: event.path,
      sessionId,
      target: event.target,
      from: now,
      to: event.to,
      native: event.native,
      because: event.native ? 'native-follows-newer-source' : 'copy-follows-source',
    });
  }
  return items;
}
