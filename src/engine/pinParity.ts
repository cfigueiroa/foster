import { sameAccount, listAccountDirs } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { LedgerEvent } from '../ledger/types.js';
import { scanAccount, type ScanCache } from '../store/scanner.js';
import { readPinState, type PinState } from '../store/pinstate.js';
import { firstLine } from '../util/fs.js';
import { resolveContinuingCard } from './continuingCard.js';

/**
 * Cross-account pin parity — the target account (signed in) ends up with the
 * same pins the most recently active *other* account already has.
 *
 * Measured 26/09/2026: the pin list (`store/pinstate.ts`) is one list per
 * Desktop installation, holding card ids from every account at once — a card
 * a copy is minted under has a fresh id, so a copy of a pinned conversation
 * always arrives unpinned however carefully it is fostered. Bringing the pin
 * itself across is therefore its own pass, run in the same closed-app gap
 * `engine/pinMoves.ts` already writes in, against the same IndexedDB.
 *
 * Per conversation (`cliSessionId`, case-insensitive):
 *
 * - the **source** is the card for that conversation in whichever *other*
 *   account has the latest `lastActivityAt` among all of them — mirroring the
 *   "most recently active wins" rule `engine/layout.ts` already uses for
 *   groups and `engine/view.ts` for the filter menu;
 * - `desiredPinned` is whether the source's own card id is in the pin list;
 * - the **target row** is the row to continue in — `resolveContinuingCard`,
 *   the same choice `planGroups` makes (not archived, a clean title, then the
 *   latest activity) — so a pin never lands on an archived row.
 *
 * Local change wins: a pin is added when desired and not already there, but
 * an unwanted pin is removed only when it is one foster itself pinned before
 * (recorded in a `pins_synced` event) — never a pin the user set by hand,
 * here or anywhere else.
 */

export interface PinParityItem {
  cardId: string;
  title: string;
}

export interface PinParityPlan {
  target: AccountRef;
  /** Card ids to pin — desired and not pinned yet. */
  toPin: PinParityItem[];
  /** Card ids to unpin — no longer desired, and foster's own pin to begin with. */
  toUnpin: PinParityItem[];
  /** Set when there was something to compare and the pin list could not be read. */
  unreadable?: string;
}

/**
 * Every id this installation's ledger says foster pinned for this account and
 * has not since unpinned — folded straight from the events, the same way
 * `pendingPinMoves` folds `pin_move_deferred`/`pins_moved` rather than going
 * through `project()`.
 */
export function fosterOwnedPins(events: readonly LedgerEvent[], target: AccountRef): Set<string> {
  const owned = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'pins_synced' || !sameAccount(event.account, target)) continue;
    for (const id of event.pinned) owned.add(id);
    for (const id of event.unpinned) owned.delete(id);
  }
  return owned;
}

/**
 * Read-only: no LevelDB write, no ledger write. `applyLayout` re-reads the
 * pin list itself right before writing, in the same batch as the pin-move
 * pass (`engine/pinMoves.ts`) — this is only the plan-time read, and a plan
 * built from it is reconciled against a fresh read the same way a group or a
 * routine plan already is.
 */
export function planPinParity(
  store: StoreLayout,
  target: AccountRef,
  events: readonly LedgerEvent[],
  read: (store: StoreLayout) => PinState | undefined = readPinState,
  cache?: ScanCache,
): PinParityPlan {
  let pins: PinState | undefined;
  try {
    pins = read(store);
  } catch (error) {
    const message = error instanceof Error ? firstLine(error.message) : String(error);
    return { target, toPin: [], toUnpin: [], unreadable: message };
  }
  if (!pins) return { target, toPin: [], toUnpin: [] };

  const others = listAccountDirs(store).filter((account) => !sameAccount(account, target));
  const pinnedIds = new Set(pins.ids);

  // The best (most recently active) source card per conversation, across
  // every other account — one scan per account, slim, the same cost
  // `planGroups`' own `cardsOf` already pays.
  const bestSource = new Map<string, DiscoveredSession>();
  for (const account of others) {
    const cards = scanAccount(store, account, undefined, { slim: true, cache });
    for (const card of cards) {
      const conversation = card.data.cliSessionId?.toLowerCase();
      if (!conversation) continue;
      const current = bestSource.get(conversation);
      if (!current || (card.data.lastActivityAt ?? 0) > (current.data.lastActivityAt ?? 0)) {
        bestSource.set(conversation, card);
      }
    }
  }

  const targetCards = scanAccount(store, target, undefined, { slim: true, cache });
  const byConversation = new Map<string, DiscoveredSession[]>();
  for (const card of targetCards) {
    const conversation = card.data.cliSessionId?.toLowerCase();
    if (!conversation) continue;
    const list = byConversation.get(conversation) ?? [];
    list.push(card);
    byConversation.set(conversation, list);
  }

  const owned = fosterOwnedPins(events, target);
  const toPin: PinParityItem[] = [];
  const toUnpin: PinParityItem[] = [];
  const decided = new Set<string>();

  for (const [conversation, candidates] of byConversation) {
    const row = resolveContinuingCard(candidates);
    if (!row) continue;
    const cardId = row.data.sessionId;
    if (decided.has(cardId)) continue;
    decided.add(cardId);

    const source = bestSource.get(conversation);
    const desired = source ? pinnedIds.has(source.data.sessionId) : false;
    const currentlyPinned = pinnedIds.has(cardId);
    const title = row.data.title ?? cardId;

    if (desired && !currentlyPinned) {
      toPin.push({ cardId, title });
    } else if (!desired && currentlyPinned && owned.has(cardId)) {
      toUnpin.push({ cardId, title });
    }
  }

  return { target, toPin, toUnpin };
}
