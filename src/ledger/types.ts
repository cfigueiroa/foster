import type { AccountRef } from '../domain/types.js';

/**
 * The ledger is an append-only JSONL log. Current state is a fold over the
 * events, never a mutable record — so the file is human-readable, diffable and
 * trivially recoverable, and no native database dependency is needed.
 */
export type LedgerEvent =
  | AccountLabelledEvent
  | AccountIdentitySeenEvent
  | FosteredEvent
  | ReturnedEvent
  | ConversationPurgedEvent
  | OperationFailedEvent;

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

/**
 * Who an account belongs to, as the app's cache said at one moment.
 *
 * Recorded because the source is volatile in a way no amount of careful reading
 * fixes. The profile lands in the web-origin storage when the app fetches it, and
 * leaves when Chromium compacts that database: measured here, the plan was
 * readable minutes after signing in and gone from every non-credential file
 * afterwards. A better parser cannot find what is no longer written down.
 *
 * So the answer is kept the moment it is seen. The ledger is foster's own file,
 * outside anything the app rewrites, which makes it the durable half of a pair
 * whose other half is a cache. It is also what lets an account be named while you
 * are signed into a different one: the cache only ever describes the session in
 * front of you, and this remembers the ones behind.
 *
 * Each field is optional because a partial sighting is worth keeping — a run that
 * saw the name and email but not the plan should not erase a plan seen earlier.
 */
export interface AccountIdentitySeenEvent extends BaseEvent {
  kind: 'account_identity_seen';
  accountUuid: string;
  email?: string;
  name?: string;
  plan?: string;
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
  /**
   * The installation the session was read from, when it was not the one written
   * into. Without it nothing downstream can find the original's card, which is
   * the card that goes stale — so the reassurance about a conversation that
   * carried on stayed silent in exactly the arrangement that confuses most.
   */
  originStore?: string;
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
  /**
   * True when the copy is still on disk and no longer holds the conversation it
   * was made for — the app branched it and moved the card onto the branch.
   *
   * Distinct from `reconciled`, which says the file was already gone: here it is
   * very much there, and saying otherwise would send anyone reading the log
   * looking for a deletion that never happened. Foster stops tracking it, which
   * has a consequence worth stating: `return` works from the active fosterings,
   * so it will not remove this file. That is deliberate — the card is now the
   * app's own row for the branch, and deleting it would take away a conversation
   * the user can see — but it does mean the file outlives foster's record of it.
   */
  repurposed?: true;
}

/**
 * A conversation destroyed on disk, recorded deliberately thin.
 *
 * The ledger exists so every operation can be replayed in reverse, and this is
 * the one that cannot be — so what it records is not a way back but an account
 * of what happened. Without it a transcript missing from `~/.claude/projects`
 * looks like corruption, and "did foster do this?" has no answer.
 *
 * What it does *not* record is the point. The title, the working directory and
 * the text were the thing the user asked to be rid of; copying them into a file
 * that survives would make the ledger the backup this command promises not to
 * keep. An opaque id, a count and a size say that something was destroyed here
 * without preserving any of it.
 */
export interface ConversationPurgedEvent extends BaseEvent {
  kind: 'conversation_purged';
  cliSessionId: string;
  /** How many copies of the transcript were removed — mirrors can exist. */
  files: number;
  bytes: number;
}

export interface OperationFailedEvent extends BaseEvent {
  kind: 'failed';
  operation: string;
  originSessionId?: string;
  /**
   * The conversation, for operations keyed on one rather than on a session card.
   * A failed purge without it names nothing at all, which is the worst moment to
   * be anonymous: the operation may have destroyed part of a transcript before
   * it threw.
   */
  cliSessionId?: string;
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
  | Draft<AccountIdentitySeenEvent>
  | Draft<FosteredEvent>
  | Draft<ReturnedEvent>
  | Draft<ConversationPurgedEvent>
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
  /** The installation the original lives in, when it is not the one holding the copy. */
  originStore?: string;
  fosteredAt: number;
}
