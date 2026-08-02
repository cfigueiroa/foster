import type { AccountRef } from '../domain/types.js';

/**
 * The ledger is an append-only JSONL log. Current state is a fold over the
 * events, never a mutable record — so the file is human-readable, diffable and
 * trivially recoverable, and no native database dependency is needed.
 */
export type LedgerEvent =
  AccountLabelledEvent | FosteredEvent | ReturnedEvent | OperationFailedEvent;

interface BaseEvent {
  /** Schema version, so old logs stay readable as the tool evolves. */
  v: 1;
  ts: number;
  toolVersion: string;
}

export interface AccountLabelledEvent extends BaseEvent {
  kind: 'account_labelled';
  accountUuid: string;
  label: string;
}

export interface FosteredEvent extends BaseEvent {
  kind: 'fostered';
  /** Identity of the session in its origin account — the stable half of the key. */
  originSessionId: string;
  origin: AccountRef;
  target: AccountRef;
  /** The freshly minted id written into the copy. */
  copySessionId: string;
  copyPath: string;
  /** Title before the prefix was applied, so a return can restore it exactly. */
  originalTitle?: string;
  /**
   * The conversation both the copy and the original point at. Recorded because it
   * is the only way to reach the transcript once the copy is gone, and the
   * transcript is what proves the conversation continued after it was fostered.
   * Absent in entries written before this was kept.
   */
  cliSessionId?: string;
  prefix: string;
}

export interface ReturnedEvent extends BaseEvent {
  kind: 'returned';
  originSessionId: string;
  target: AccountRef;
  copySessionId: string;
  /**
   * True when foster did not remove the copy — it found it already gone and
   * brought the record in line with the disk. The fold treats it like any other
   * return; the distinction is for anyone reading the log afterwards, who would
   * otherwise see foster claiming a deletion it never performed.
   */
  reconciled?: true;
}

export interface OperationFailedEvent extends BaseEvent {
  kind: 'failed';
  operation: string;
  originSessionId?: string;
  reason: string;
}

/**
 * An event as supplied by a caller, before the log stamps schema version, time
 * and tool version onto it.
 *
 * Written out per member rather than as `Omit<LedgerEvent, ...>`: Omit over a
 * union collapses to the keys the members share, which would silently reject
 * every event-specific field.
 */
type Draft<T extends BaseEvent> = Omit<T, 'v' | 'ts' | 'toolVersion'> & { ts?: number };

export type LedgerEventInput =
  | Draft<AccountLabelledEvent>
  | Draft<FosteredEvent>
  | Draft<ReturnedEvent>
  | Draft<OperationFailedEvent>;

/** A fostering that is currently in place, derived by folding the log. */
export interface ActiveFostering {
  originSessionId: string;
  origin: AccountRef;
  target: AccountRef;
  copySessionId: string;
  copyPath: string;
  originalTitle?: string;
  /** The conversation behind both the copy and the original, when it was recorded. */
  cliSessionId?: string;
  fosteredAt: number;
}
