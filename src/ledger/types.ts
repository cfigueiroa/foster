import type { AccountProfile } from '../domain/profile.js';
import type { AccountRef } from '../domain/types.js';

/**
 * The ledger is an append-only JSONL log. Current state is a fold over the
 * events, never a mutable record — so the file is human-readable, diffable and
 * trivially recoverable, and no native database dependency is needed.
 */
export type LedgerEvent =
  | AccountLabelledEvent
  | AccountIdentitySeenEvent
  | AccountIdentityForgottenEvent
  | AccountSwitchedEvent
  | FosteredEvent
  | ReturnedEvent
  | FosteringFollowedEvent
  | CardRepointedEvent
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
  /**
   * The rest of the profile, when the profile itself was found: organization,
   * subscription status, the raw tier, the dates. Nested rather than spread
   * across the event so that the three fields above keep meaning exactly what
   * they meant in logs written before this existed.
   *
   * This is the half that matters for an account you are not signed into. The
   * response cache only ever describes the current session, so an account's
   * subscription is knowable exactly once — while you are in it — and only
   * because it was written down here on the way past.
   */
  profile?: AccountProfile;
}

/**
 * A sighting withdrawn: what foster believed about an account, unbelieved.
 *
 * Reading a volatile source and remembering the answer has a failure mode that
 * only remembering creates. A sighting that was wrong outlives the cache that
 * produced it, and the fold has no way to reach a decision it has already made:
 * a later sighting can correct a field only by carrying a different value for it,
 * and the cache that once said something wrong is usually saying nothing at all
 * by the time anyone notices. That is how a single misread address became this
 * account's email permanently — the record could not be argued with, only added
 * to.
 *
 * So the withdrawal is an event like any other. The log still says what was seen
 * and when, which is the point of an append-only log; the fold simply stops
 * treating it as current, and the next real sighting starts the record over.
 */
export interface AccountIdentityForgottenEvent extends BaseEvent {
  kind: 'account_identity_forgotten';
  accountUuid: string;
}

/**
 * A config directory signed in as somebody else.
 *
 * The only write foster makes that changes who a future process *is*, so the
 * ledger carries it for the same reason it carries a fostering: without a record,
 * "why is this directory on that account?" has no answer, and a switch that went
 * half-wrong looks identical to one that never happened.
 *
 * What it deliberately does not carry is any part of the credential — not the
 * token, not the refresh token, not their lengths or shapes. The emails are the
 * point of the record and are already in this log wherever an identity was seen;
 * a token would make the ledger a place worth stealing, which it is not today
 * and should not become.
 */
export interface AccountSwitchedEvent extends BaseEvent {
  kind: 'account_switched';
  configDir: string;
  /** Who was signed in before, when foster could establish it. */
  from?: string;
  to: string;
  /**
   * When the credential that was installed had been taken. The vault is
   * append-only, so a switch can install something recorded weeks ago; the age
   * of what was installed is the fact that explains a switch that verified fine
   * and stopped working shortly after.
   */
  takenAt?: number;
  /**
   * How many live processes were registered in that directory at the moment of
   * the write. Not a failure and not a refusal: it is the number that explains
   * an account mysteriously reverting half an hour later, and it is unknowable
   * after the fact.
   */
  liveWriters: number;
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
   * True when the copy is still on disk and holds a conversation that is not the
   * one it was made for, and not a branch of it either — the app reused the card
   * for unrelated work.
   *
   * Distinct from `reconciled`, which says the file was already gone: here it is
   * very much there, and saying otherwise would send anyone reading the log
   * looking for a deletion that never happened. Foster stops tracking it, which
   * has a consequence worth stating: `return` works from the active fosterings,
   * so it will not remove this file. That is deliberate — the card is now the
   * app's own row for something else, and deleting it would take away a
   * conversation the user can see — but it does mean the file outlives foster's
   * record of it.
   *
   * A card moved onto a *branch* of the conversation it was made for is not this.
   * See `FosteringFollowedEvent`.
   */
  repurposed?: true;
}

/**
 * The app branched a copy, and foster followed it there.
 *
 * A copy opened while its conversation is being written elsewhere does not
 * continue it: the app writes a new transcript and moves the card onto that. The
 * card is still one row, still showing that work, and now further along than the
 * original — nothing was lost and nothing needs replacing.
 *
 * Treating it as a lost copy is what had to stop. The fold dropped the fostering,
 * the next sweep found the origin session untracked, and wrote a *second* copy of
 * the half the card had just moved off — so one conversation became two rows in
 * one sidebar, and the run that did it was the tidy-up. Measured on a real store:
 * every one of the six copies the app had branched came back as a duplicate row.
 *
 * Recorded apart from `CardRepointedEvent` on purpose. That one is a move foster
 * made and can undo; this is a move the app made, and offering to put it back
 * would promise something foster has no business promising.
 */
export interface FosteringFollowedEvent extends BaseEvent {
  kind: 'fostering_followed';
  originSessionId: string;
  target: AccountRef;
  copySessionId: string;
  /** The conversation the copy was made for. */
  from: string;
  /** The branch the app moved it onto, which the fostering now tracks. */
  to: string;
}

/**
 * A card moved onto a different conversation.
 *
 * The one write foster makes to a file it did not create. A fork leaves an
 * account holding a card for the half that stopped, and there is no way to show
 * the half that carried on without either adding a second row — which is the
 * thing the sidebar is already too full of — or moving the row it has. Moving it
 * changes one field and keeps everything else about the card: its identity, its
 * pins, its place in the app's own records.
 *
 * Which makes this the event that has to be reversible, and reversible without
 * reading anything but the log. `from` is where the app had it, `to` is where
 * foster put it, and `path` is where to find it — so an undo needs no scan, and
 * works even for a card whose account is no longer signed in.
 */
export interface CardRepointedEvent extends BaseEvent {
  kind: 'card_repointed';
  /** The card's own session id, which the repoint does not change. */
  sessionId: string;
  /** The account directory it sits in. */
  target: AccountRef;
  path: string;
  /** The conversation it pointed at before. */
  from: string;
  /** The conversation it points at now. */
  to: string;
  /** The `lastActivityAt` it wore before, so an undo restores its place in Recents. */
  fromActivityAt?: number;
  /**
   * True when the app made this card rather than foster.
   *
   * Recorded because it is the fact that decides how careful the next command
   * has to be, and it cannot be recovered afterwards: the `_foster` marker does
   * not survive the app saving a copy, so a file read later cannot say who wrote
   * it.
   */
  native: boolean;
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
  | Draft<AccountIdentityForgottenEvent>
  | Draft<AccountSwitchedEvent>
  | Draft<FosteredEvent>
  | Draft<ReturnedEvent>
  | Draft<FosteringFollowedEvent>
  | Draft<CardRepointedEvent>
  | Draft<ConversationPurgedEvent>
  | Draft<OperationFailedEvent>;

/**
 * A card that is currently pointed somewhere other than where the app had it.
 *
 * `from` is the *original* pointer, carried across repeated repoints rather than
 * replaced by each one. That is what makes "put it back" mean the same thing
 * however many times a card has been moved, and it is why a card moved back to
 * where it started stops being one of these at all rather than becoming an entry
 * that says nothing changed.
 */
export interface RepointedCard {
  sessionId: string;
  path: string;
  target: AccountRef;
  /** Where the app had it before foster touched it at all. */
  from: string;
  /** Where it points now. */
  to: string;
  /** The date it wore before foster touched it, carried across repeated moves like `from`. */
  fromActivityAt?: number;
  native: boolean;
  repointedAt: number;
}

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
  /**
   * True once the app has branched this copy and foster followed it there.
   *
   * The card is foster's file, but what it holds now is a conversation that
   * exists nowhere else — the branch was born from opening this very row, so
   * this is usually the only card it has in any account. Deleting it would take
   * that conversation out of every sidebar, and `restore` could not offer it back
   * because a file foster unlinks leaves no deletion marker. So a sweep-wide
   * `return` leaves it alone; see `selectReturnTargets`.
   */
  followedBranch?: true;
}
