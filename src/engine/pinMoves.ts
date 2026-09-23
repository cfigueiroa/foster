import path from 'node:path';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { LedgerEvent } from '../ledger/types.js';
import { scanAccount } from '../store/scanner.js';
import { backupPinState, readPinState, writePinState, type PinState } from '../store/pinstate.js';
import { firstLine } from '../util/fs.js';

/**
 * Pin moves the sweep had to put off, and the write that finishes them.
 *
 * The sweep marks a pinned row — a branch that stopped, or the other file of a
 * conversation shown twice — and the pin should follow onto the row to continue
 * in. The pin list is the app's own IndexedDB, which takes a write only while
 * the app is closed, and a sweep run from a session the app hosts never sees it
 * closed. Measured 23/09/2026: `/fosteia` marked a pinned row, said "the pin
 * could not be moved yet", and nothing ever came back for it — the next sweep
 * only looks at rows it marks itself, and the detached `foster layout --yes
 * --restart` that finishes `/fosteia` in the gap knew nothing about pins.
 *
 * So the sweep records the move (`pin_move_deferred`) and `foster layout`
 * applies whatever is still pending, in the same gap it writes groups in. The
 * sweep's own move, when the app happens to be closed, goes through the same
 * `applyPinMoves` below.
 */

export interface PinMove {
  staleSessionId: string;
  cleanSessionId: string;
  staleTitle: string;
  cleanTitle: string;
  as: 'stale' | 'other-file';
}

export interface PinMovesPlan {
  /** Pending moves whose stale row is still pinned — the ones a write would change. */
  moves: PinMove[];
  /**
   * Pending moves with nothing left to do, settled on the next write so they
   * stop being offered: the stale row is no longer pinned (whoever unpinned it —
   * a row the user pins again later is theirs), or the row the pin was meant for
   * is gone or archived since, so moving it there would lose the pin instead of
   * keeping it.
   */
  settled: PinMove[];
  /** Set when there was something pending and the pin list could not be read. */
  unreadable?: string;
}

function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid;
}

/**
 * Every deferred move not yet settled, for this account. A later deferral for
 * the same stale row replaces an earlier one; a `pins_moved` naming it settles
 * it, whatever came before.
 */
export function pendingPinMoves(events: readonly LedgerEvent[], target: AccountRef): PinMove[] {
  const pending = new Map<string, PinMove>();
  for (const event of events) {
    if (event.kind === 'pin_move_deferred') {
      if (!sameAccount(event.target, target)) continue;
      pending.set(event.staleSessionId, {
        staleSessionId: event.staleSessionId,
        cleanSessionId: event.cleanSessionId,
        staleTitle: event.staleTitle,
        cleanTitle: event.cleanTitle,
        as: event.as,
      });
    } else if (event.kind === 'pins_moved') {
      for (const move of event.moves) pending.delete(move.staleSessionId);
    }
  }
  return [...pending.values()];
}

/**
 * Split what is pending into what a write would change and what is already
 * settled. Read-only: one LevelDB read and one scan of the target's cards, and
 * only when something is pending, so a store with nothing deferred touches
 * neither.
 *
 * The row the pin was meant for is checked again here, not trusted from the
 * deferral: between the sweep that deferred it and this run, a `foster return`
 * can have removed that copy, or a later sweep can have marked and archived it.
 */
export function planPinMoves(
  store: StoreLayout,
  events: readonly LedgerEvent[],
  target: AccountRef,
  read: (store: StoreLayout) => PinState | undefined = readPinState,
): PinMovesPlan {
  const pending = pendingPinMoves(events, target);
  if (pending.length === 0) return { moves: [], settled: [] };

  let pins: PinState | undefined;
  try {
    pins = read(store);
  } catch (error) {
    const message = error instanceof Error ? firstLine(error.message) : String(error);
    return { moves: [], settled: [], unreadable: message };
  }

  const shown = new Set(
    scanAccount(store, target)
      .filter((card) => !card.data.isArchived)
      .map((card) => card.data.sessionId),
  );
  // Nothing pinned at all: every stale row has already lost its pin.
  const ids = new Set(pins?.ids ?? []);
  const writable = (move: PinMove): boolean =>
    ids.has(move.staleSessionId) && shown.has(move.cleanSessionId);
  return {
    moves: pending.filter(writable),
    settled: pending.filter((move) => !writable(move)),
  };
}

export interface ApplyPinMovesResult {
  /** Moves actually written. */
  moved: number;
  /** The backup taken before the write, when there was one. */
  backup?: string;
}

/**
 * Write the plan's moves in one append, backing the database up first, and
 * settle them in the ledger — the written ones and the ones already done alike.
 *
 * The caller owns the "app is closed" check: `applyLayout` refuses a running
 * app before it gets here, and the sweep's pin pass asks `inspectApp` first.
 */
export function applyPinMoves(
  store: StoreLayout,
  ledger: Ledger,
  plan: PinMovesPlan,
  options: { now?: () => Date } = {},
): ApplyPinMovesResult {
  if (plan.moves.length === 0 && plan.settled.length === 0) return { moved: 0 };

  const settle = (written: PinMove[], already: PinMove[]): void => {
    ledger.append({
      kind: 'pins_moved',
      moves: [
        ...written.map((move) => ({
          staleSessionId: move.staleSessionId,
          cleanSessionId: move.cleanSessionId,
          written: true,
        })),
        ...already.map((move) => ({
          staleSessionId: move.staleSessionId,
          cleanSessionId: move.cleanSessionId,
          written: false,
        })),
      ],
    });
  };

  // Read fresh, not from the plan: the app may have flushed a pin of its own
  // between planning and this write.
  const pins = plan.moves.length > 0 ? readPinState(store) : undefined;
  const ids = new Set(pins?.ids ?? []);
  const toWrite = plan.moves.filter((move) => ids.has(move.staleSessionId));
  const already = [...plan.settled, ...plan.moves.filter((move) => !ids.has(move.staleSessionId))];

  if (!pins || toWrite.length === 0) {
    settle([], already);
    return { moved: 0 };
  }

  let next = pins.ids;
  for (const move of toWrite) {
    next = next.filter((id) => id !== move.staleSessionId);
    if (!next.includes(move.cleanSessionId)) next = [...next, move.cleanSessionId];
  }

  const stamp = (options.now?.() ?? new Date()).getTime();
  const backup = backupPinState(
    store,
    path.join(path.dirname(ledger.path), 'backups', `pin-state-${stamp}`),
  );
  writePinState(pins, next);
  settle(toWrite, already);
  return { moved: toWrite.length, backup };
}
