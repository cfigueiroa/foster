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
  | CardRetitledEvent
  | CardDatedEvent
  | ConversationPurgedEvent
  | OperationFailedEvent
  | ProfileRegisteredEvent
  | ProfileForgottenEvent
  | ClientRootRegisteredEvent
  | ClientRootForgottenEvent
  | HandlerArmedEvent
  | HandlerRestoredEvent
  | WorktreeReleasedEvent
  | WorktreeReleaseUndoneEvent
  | ConversationImportedEvent
  | ConversationImportUndoneEvent
  | LayoutAppliedEvent
  | PinMoveDeferredEvent
  | PinsMovedEvent
  | ArchiveSyncedEvent
  | PinsSyncedEvent
  | LayoutAssignedEvent
  | ViewCarriedEvent
  | ViewSeenEvent;

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
  /**
   * True when the copy was written archived by foster's own decision rather
   * than because the source was. The branch pass files the branch that stopped
   * in the archived view; should that branch later carry on and become the tip,
   * this is what says the flag was foster's to lift, not the user's.
   */
  archived?: true;
  /**
   * The template `prefix`'s mark was made from, `{when}` unfilled — set when the
   * branch pass brings a copy in with a mark already in front of its title (see
   * `BringRequest.prefix`). Absent in entries written before this was kept and
   * for a copy brought with no mark at all; `templatesSeen` in `domain/stale.ts`
   * derives a fallback from `prefix` itself for the entries that lack it.
   */
  template?: string;
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
 * A card's title, and possibly its archived flag, rewritten by the sweep.
 *
 * The second write foster makes to a file it did not create, and a lighter one
 * than a repoint: nothing about which conversation the row opens changes. A
 * fork gives every branch a row, and this is how the rows that did not carry
 * on come to say so — the title gains the stale mark, and the row moves to the
 * archived view. Both fields are recorded before and after, so the log can say
 * what the card wore when foster found it, and a later pass can tell a flag
 * foster set from one the user set.
 */
export interface CardRetitledEvent extends BaseEvent {
  kind: 'card_retitled';
  /** The card's own session id, which the write does not change. */
  sessionId: string;
  /** The account directory it sits in. */
  target: AccountRef;
  path: string;
  /** The title it wore before. */
  from: string;
  /** The title it wears now. */
  to: string;
  /** The archived flag before, when the write changed it. */
  fromArchived?: boolean;
  /** The archived flag after, when the write changed it. */
  toArchived?: boolean;
  /** True when the app made this card rather than foster — see `CardRepointedEvent`. */
  native: boolean;
  /**
   * Why: marked as the branch that stopped, marked as the other file of a
   * conversation this account shows twice, restored to the row to continue in,
   * or brought back into step with the title its original wears now.
   */
  as: 'stale' | 'tip' | 'diverged' | 'other-file' | 'synced';
  /**
   * The template the mark was made from, `{when}` unfilled — set for `as: 'stale'`,
   * `as: 'diverged'` and `as: 'other-file'`, and for `as: 'tip'` the one REMOVED, when
   * it could be told. Absent in entries written before this was kept and for
   * `as: 'synced'`, which never carries a mark of its own; `templatesSeen` derives
   * a fallback for those from `from`/`to` themselves — see `domain/stale.ts`.
   */
  template?: string;
}

/**
 * A card's `lastActivityAt`, advanced to match its transcript's last answer.
 *
 * The third field foster writes into a file it did not create, and — unlike a
 * title — one that drives sidebar ORDER: a bad value here does not just read
 * oddly, it moves a row the user is looking for. #47: the app only stamps this
 * field when it is itself hosting the conversation, so work done through the
 * CLI, in a `cwd` the card was never opened from, advances the transcript
 * while the card's own date sits frozen at the moment it was created — the row
 * sinks in Recents and reads as work that never arrived.
 *
 * `from` is the *original* value, carried across repeated advances the same
 * way `RetitledCard.from` is — optional because a card can in principle have
 * no `lastActivityAt` at all before the first advance, and there is then
 * nothing truthful to put back. Mirrors `CardRetitledEvent` deliberately: same
 * atomic write, same "skip when it already says so", same undo shape (see
 * `undoDateRequests` in `engine/dates.ts`, which is `undoRetitleRequests`
 * copied rather than reinvented).
 */
export interface CardDatedEvent extends BaseEvent {
  kind: 'card_dated';
  /** The card's own session id, which the write does not change. */
  sessionId: string;
  /** The account directory it sits in. */
  target: AccountRef;
  path: string;
  /** The `lastActivityAt` it wore before, when it had one at all. */
  from?: number;
  /** The `lastActivityAt` it wears now. */
  to: number;
  /** True when the app made this card rather than foster — see `CardRepointedEvent`. */
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
 * A name given to a Desktop installation other than the one on the machine's
 * default path — a profile, in the sense `--store <name>` resolves.
 *
 * What it deliberately does not carry is any part of the account inside that
 * root: no `accountUuid`, no token, no URL. The name and the path are the only
 * facts that outlive the installation itself — the account a profile holds
 * changes underneath it, exactly the way the default installation's does, and
 * recording one here would make this event stale the moment someone signs out.
 *
 * Registering a name already in use is not a refusal: it is the rename. The
 * fold keeps only the latest root for a name, so pointing `work` at a new
 * directory is indistinguishable from renaming that directory, which is
 * deliberate — a profile is the name, not the path underneath it.
 */
export interface ProfileRegisteredEvent extends BaseEvent {
  kind: 'profile_registered';
  name: string;
  root: string;
}

/**
 * A profile name withdrawn.
 *
 * Removes the name from the folded state so `--store <name>` stops resolving
 * it; the registration itself stays in the log, because append-only means
 * exactly that. Nothing on disk is touched — the installation the name pointed
 * at is neither opened nor deleted, only forgotten as a name for it.
 */
export interface ProfileForgottenEvent extends BaseEvent {
  kind: 'profile_forgotten';
  name: string;
}

/**
 * A filesystem root registered as a place `foster` looks for CLI client config
 * directories, beyond the `~/.claude*` siblings it enumerates on its own.
 *
 * What it deliberately does not carry is any part of what lives under that
 * root: no `accountUuid`, no token, no URL — the same restraint as a profile
 * registration, and for the same reason: the root outlives whatever account
 * currently sits inside it. `as` distinguishes a container that holds several
 * client directories from a single client directory registered directly,
 * because the two are walked differently and the event has to say which one
 * this root is without re-reading the filesystem every time.
 */
export interface ClientRootRegisteredEvent extends BaseEvent {
  kind: 'client_root_registered';
  root: string;
  as: 'client' | 'container';
}

/**
 * A registered client root withdrawn — see `ProfileForgottenEvent`. The root
 * stops being offered for listing and launch; nothing under it is touched.
 */
export interface ClientRootForgottenEvent extends BaseEvent {
  kind: 'client_root_forgotten';
  root: string;
}

/**
 * The `claude://` handler was pointed at one profile for the duration of one
 * sign-in — see `engine/protocolHandler.ts`.
 *
 * Measured 05/09/2026: what actually decides where `claude:` activates is a
 * packaged ProgID's `Parameters` value, not the classic per-user command key
 * this event used to describe (`createdFrom`, an optional `previous`) —
 * foster no longer creates or deletes registry keys, only replaces this one
 * existing value. `key` is the ProgID's `Shell\open` key `Parameters` lives
 * under — it varies per install, so it travels with the event rather than
 * being re-derived every time. `previous` is always set now: the value read
 * back before this run touched it (normally the bare `"%1"`). `exe` is kept
 * only for messages — arming never needs it, since `Parameters` never
 * includes the executable — so it is optional.
 *
 * What it deliberately does not carry is any part of the sign-in itself: no
 * URL, no code, no account. Kept so a run interrupted after this event but
 * before `handler_restored` still tells the next one what to put back —
 * without it, an interrupted login leaves the handler routed to a profile
 * with nothing in the log saying it should be undone.
 */
export interface HandlerArmedEvent extends BaseEvent {
  kind: 'handler_armed';
  root: string;
  key: string;
  previous: string;
  exe?: string;
  armed: string;
}

/**
 * The `claude://` handler put back, ending the window `handler_armed` opened.
 *
 * `restored` says whether the read-back actually matched what was written —
 * false means the handler was left pointed somewhere, which is the fact
 * `foster app login --restore` and `doctor` need to warn about a stale route.
 * Nothing about the sign-in itself is recorded here either.
 */
export interface HandlerRestoredEvent extends BaseEvent {
  kind: 'handler_restored';
  root: string;
  restored: boolean;
}

/**
 * A copy's claim on a worktree, released — see `engine/unclaim.ts`.
 *
 * The copy no longer carries `worktreePath`/`worktreeName`/`worktreeLazy`, so it
 * stops contesting the branch its original still holds; `cwdFrom` and `cwdTo`
 * say what happened to `cwd`, the same fields `buildFosterCopy` decides with
 * for a copy being minted fresh (`worktreeClaim` in `domain/fostering.ts`).
 * Reversible without reading anything but the log: `path` is where to find the
 * card, and the three claim fields plus `cwdFrom` are everything `undoUnclaim`
 * needs to put back.
 *
 * What it deliberately never touches is a native card. Only a fostering the
 * ledger already tracks is a candidate, so a card the app wrote for itself is
 * never a source of this event — see `planUnclaim`.
 */
export interface WorktreeReleasedEvent extends BaseEvent {
  kind: 'worktree_released';
  path: string;
  /** The card's own session id, which the release does not change. */
  sessionId: string;
  worktreePath?: string;
  worktreeName?: string;
  /** The lazy worktree promise the card carried, whatever shape the app gave it. */
  worktreeLazy?: unknown;
  /** The `cwd` the card wore before the release. */
  cwdFrom?: string;
  /** Where `cwd` moved to, when the release moved it. */
  cwdTo?: string;
}

/**
 * A worktree release put back, ending the window `worktree_released` opened.
 *
 * Thin on purpose: `path` is the only fact `undoUnclaim` needs from this event
 * itself, since what to restore is read back out of the `worktree_released` it
 * is undoing rather than carried twice.
 */
export interface WorktreeReleaseUndoneEvent extends BaseEvent {
  kind: 'worktree_release_undone';
  path: string;
}

/**
 * An outside conversation brought in as a Claude conversation — a Codex CLI
 * rollout (issue #19) or, since `foster cloud pull`, a Claude Code cloud
 * session. Unlike every other write foster records, this one names no Claude
 * Desktop origin: the conversation did not run as a local Desktop conversation
 * before this, so what it carries is the source it came from and the two files
 * foster wrote from it (the transcript under ~/.claude/projects and the
 * sidebar card).
 *
 * Keyed on `rolloutId` in the fold, so a second import of the same source is a
 * no-op and `--undo` can find both files to remove. `contentHash` lets a source
 * that has since grown or changed be told from one that has not.
 */
export interface ConversationImportedEvent extends BaseEvent {
  kind: 'conversation_imported';
  /**
   * Which importer wrote this. Absent means `'codex'` — see `FosterImportMark.source`.
   */
  source?: 'codex' | 'cloud';
  /**
   * The Codex thread id, or the cloud session's own id (`cse_…`/`session_…`) —
   * the key this is folded and deduped on. For a Codex import this is also the
   * transcript's `cliSessionId`; a cloud pull mints a fresh uuid for that
   * instead (see `cloudTranscript.ts`), because a cloud id is not shaped like
   * one the app would accept as a session id.
   */
  rolloutId: string;
  /**
   * The rollout file path (Codex), or a human-readable "cloud session <id>"
   * description (cloud sessions have no local source file).
   */
  sourceRolloutPath: string;
  contentHash: string;
  cliVersion?: string;
  target: AccountRef;
  /** The sidebar card foster wrote. */
  cardPath: string;
  /** The transcript foster wrote under ~/.claude/projects. */
  transcriptPath: string;
  /** The card's own session id (`local_<the transcript's own cliSessionId>`). */
  sessionId: string;
  title?: string;
}

/**
 * An import undone, ending what `conversation_imported` recorded. Thin on
 * purpose, like `worktree_release_undone`: `rolloutId` is the only fact the fold
 * needs, since what was written is read back out of the import it undoes.
 */
export interface ConversationImportUndoneEvent extends BaseEvent {
  kind: 'conversation_import_undone';
  rolloutId: string;
}

/**
 * Groups and routines brought from every other account into the target — see
 * `engine/layout.ts`. Thin on purpose, like the other write-passes' events: what
 * changed is sitting in the two files themselves (a scope in
 * `claude_desktop_config.json`, a `scheduledTasks` array), and the app owns
 * both, so there is nothing here to undo by replaying fields the way a repoint
 * or a retitle can. Counts and the target are enough to say a run happened and
 * roughly what it did; `templatesSeen` and every other fold that reads marks
 * has no reason to look at this one.
 *
 * `groups` (cards newly assigned) and `routines` are the original two counts;
 * `groupsCreated`, `orderEntriesAdded` and `viewKeysCarried` were added
 * alongside them rather than replacing anything, so an event an older build
 * wrote — missing all three — still parses and still folds: `project()` never
 * reads a `layout_applied` event's fields at all (see the `case` below), and
 * nothing else in the codebase reads this event back either, so there was
 * nothing for a missing field to break.
 */
export interface LayoutAppliedEvent extends BaseEvent {
  kind: 'layout_applied';
  target: AccountRef;
  /** Cards newly assigned to a group. */
  groups: number;
  /** Of those, how many groups did not exist in the target before this run. Absent on an older event. */
  groupsCreated?: number;
  /** Manual order entries appended to a group's order list. Absent on an older event. */
  orderEntriesAdded?: number;
  routines: number;
  /** Sidebar filter-menu (view) keys carried from another account. Absent on an older event. */
  viewKeysCarried?: number;
}

/**
 * A pin the sweep wanted to move and could not: it had just marked a pinned row
 * (a branch that stopped, or the other file of a conversation shown twice), and
 * the pin list lives in the app's own IndexedDB, which only takes a write while
 * the app is closed — never the case for a sweep run from a session the app
 * hosts.
 *
 * Before this was kept, the move was said once, in that run's summary, and then
 * forgotten: the next sweep only looks at rows it marks itself, so the pin sat on
 * the archived row for good. Recorded here so `foster layout` — which runs in the
 * gap while the app is closed — can finish it (`engine/pinMoves.ts`). Settled by
 * a later `pins_moved` naming the same `staleSessionId`.
 */
export interface PinMoveDeferredEvent extends BaseEvent {
  kind: 'pin_move_deferred';
  target: AccountRef;
  /** The pinned row the sweep marked. */
  staleSessionId: string;
  /** The row to continue in — where the pin belongs. */
  cleanSessionId: string;
  /** The marked row's title as the sidebar shows it, mark included. */
  staleTitle: string;
  cleanTitle: string;
  /** Which mark the stale row wears. */
  as: 'stale' | 'other-file';
}

/**
 * Deferred pin moves that are settled: written, or found already done by hand
 * (the stale row no longer pinned). Either way `pendingPinMoves` stops offering
 * them, so a row the user pins again on purpose is never unpinned a second time.
 */
export interface PinsMovedEvent extends BaseEvent {
  kind: 'pins_moved';
  moves: { staleSessionId: string; cleanSessionId: string; written: boolean }[];
}

/**
 * A card's archived flag brought into step with the account another card of
 * the same conversation was most recently active in — see `engine/archiveSync.ts`.
 *
 * Deliberately as thin as `CardDatedEvent`: the flag before and after, and
 * nothing about the source card beyond its session id — no title, no account,
 * no content. `sourceSessionId` is kept only so a report can say which row this
 * followed, not to let anything be read back from it; `fold`'s own state (the
 * `archiveSynced` map) never carries it forward across writes.
 *
 * A card_retitled event with `toArchived` set already changes this same flag,
 * for the branch and second-file marking passes — this is the third writer of
 * it, alongside those and the fostering that first sets it. Kept as its own
 * kind rather than folded into `card_retitled` because nothing here ever
 * touches the title, and a reader asking "does foster still own this card's
 * archived flag" needs both writers' timestamps to find the latest.
 */
export interface ArchiveSyncedEvent extends BaseEvent {
  kind: 'archive_synced';
  /** The card's own session id, which the write does not change. */
  sessionId: string;
  /** The account directory it sits in. */
  target: AccountRef;
  path: string;
  /** The archived flag it wore before. */
  from: boolean;
  /** The archived flag it wears now. */
  to: boolean;
  /** True when the app made this card rather than foster — see `CardRepointedEvent`. */
  native: boolean;
  /** The card whose account was most recently active — named for the report, never read back. */
  sourceSessionId?: string;
}

/**
 * Cross-account pin parity, written by `foster layout` — see
 * `engine/pinParity.ts`. The pin list (`store/pinstate.ts`) is one list per
 * Desktop installation, holding card ids from every account at once, so a
 * card newly minted for a copy always arrives unpinned; this event is what
 * lets a later run tell "foster pinned this" from "the user pinned this" for
 * the ids it unpins later — `pinned` is the full set of ids this write left
 * pinned that foster itself is responsible for, so the fold only needs the
 * latest event per account rather than replaying every write.
 */
export interface PinsSyncedEvent extends BaseEvent {
  kind: 'pins_synced';
  account: AccountRef;
  /** Card ids in `account` that this run pinned, or found already pinned by foster. */
  pinned: string[];
  /** Card ids this run unpinned — always ids `pinned` named in an earlier event. */
  unpinned: string[];
}

/**
 * One card filed into one group by `applyLayout`, kept apart from the
 * summary counts `LayoutAppliedEvent` already carries so a later run can tell
 * whether the *current* group a target card sits in is one foster itself put
 * it in — the "local change wins" rule for moving a card between groups (see
 * AGENTS.md, "Groups and routines"). Folded to the latest assignment per
 * card, since a card can only ever be in one group at a time.
 */
export interface LayoutAssignedEvent extends BaseEvent {
  kind: 'layout_assigned';
  account: AccountRef;
  assignments: { cardId: string; groupName: string }[];
}

/**
 * One sidebar filter-menu, per-account key (`store/viewPrefs.ts`) carried by
 * `foster layout` from another account into the target — see
 * `engine/view.ts`'s carry rule. Recorded per key so a later run can tell
 * whether the target's *current* value for that key is still the one foster
 * wrote, which is what makes a second carry safe: it only overwrites a value
 * it owns, never a value the user set by hand afterwards.
 */
export interface ViewCarriedEvent extends BaseEvent {
  kind: 'view_carried';
  account: AccountRef;
  key: string;
  value: unknown;
}

/**
 * A sighting of the machine-wide sidebar filter menu's `groupBy`/`sort`
 * (`store/localStorage.ts`'s `dframe-store` record) for one account, taken
 * whenever `foster sweep` or `foster layout` reads the store. The record
 * itself is one list for the whole installation, and the page re-syncs it
 * from the server for whichever account is signed in at startup — so the
 * only way to know what a *different* account last showed is to have written
 * it down while that account was the one signed in. Only appended when it
 * differs from the latest sighting already on file for this account, so an
 * unchanged value does not spam the ledger on every run.
 */
export interface ViewSeenEvent extends BaseEvent {
  kind: 'view_seen';
  account: AccountRef;
  groupBy?: string;
  sortBy: string;
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
  | Draft<CardRetitledEvent>
  | Draft<CardDatedEvent>
  | Draft<ConversationPurgedEvent>
  | Draft<OperationFailedEvent>
  | Draft<ProfileRegisteredEvent>
  | Draft<ProfileForgottenEvent>
  | Draft<ClientRootRegisteredEvent>
  | Draft<ClientRootForgottenEvent>
  | Draft<HandlerArmedEvent>
  | Draft<HandlerRestoredEvent>
  | Draft<WorktreeReleasedEvent>
  | Draft<WorktreeReleaseUndoneEvent>
  | Draft<ConversationImportedEvent>
  | Draft<ConversationImportUndoneEvent>
  | Draft<LayoutAppliedEvent>
  | Draft<PinMoveDeferredEvent>
  | Draft<PinsMovedEvent>
  | Draft<ArchiveSyncedEvent>
  | Draft<PinsSyncedEvent>
  | Draft<LayoutAssignedEvent>
  | Draft<ViewCarriedEvent>
  | Draft<ViewSeenEvent>;

/**
 * A card whose title, or archived flag, is not what the app last had.
 *
 * `from` and `fromArchived` are the *original* values, carried across repeated
 * writes the way `RepointedCard.from` is, so "what did the user's card say?"
 * has one answer however many sweeps have marked it since.
 */
export interface RetitledCard {
  sessionId: string;
  path: string;
  target: AccountRef;
  /** The title the app had, before foster first touched it. */
  from: string;
  /** The title it wears now. */
  to: string;
  /**
   * The title left by the most recent write that could carry a mark — absent
   * when nothing has marked this card, or when `tip` took the mark back off.
   *
   * Only `stale` and `diverged` put a mark on; `as: 'synced'` rewrites the title
   * *underneath* the mark and leaves the mark exactly as it was. Recorded
   * separately from `to` because the difference is invisible afterwards: read
   * the mark off the latest title instead and a sync's own work is taken for a
   * mark, which the next sync then writes in front all over again. Measured on
   * a real store — a conversation renamed at its origin with an emoji in front
   * gained one more emoji per sweep, and the run never stopped saying "still out
   * of step".
   */
  markedTo?: string;
  /** The archived flag the app had, when foster changed it at all. */
  fromArchived?: boolean;
  /** The archived flag now, when foster set it. */
  toArchived?: boolean;
  native: boolean;
  retitledAt: number;
}

/**
 * A card whose `lastActivityAt` is not what the app last had.
 *
 * `from` is the *original* value, carried across repeated writes the way
 * `RetitledCard.from` is, so "what did the app's card say?" has one answer
 * however many times a sweep has advanced it since. Optional because a card
 * with no `lastActivityAt` at all has nothing to be carried forward.
 */
export interface DatedCard {
  sessionId: string;
  path: string;
  target: AccountRef;
  /** The `lastActivityAt` the app had, before foster first touched it. */
  from?: number;
  /** The `lastActivityAt` it wears now. */
  to: number;
  native: boolean;
  datedAt: number;
}

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

/**
 * A copy currently missing the worktree claim it once carried, keyed by path
 * rather than session id — the fold that matters here is per-file, and a card
 * that fails to read leaves nothing else to key it by.
 */
export interface WorktreeReleasedCard {
  path: string;
  sessionId: string;
  worktreePath?: string;
  worktreeName?: string;
  worktreeLazy?: unknown;
  cwdFrom?: string;
  cwdTo?: string;
  releasedAt: number;
}

/**
 * A Codex rollout or cloud session currently imported and not yet undone,
 * keyed by `rolloutId` — the folded projection of `conversation_imported`.
 * Holds the two paths foster wrote so `--undo` can remove them and `--list`
 * can say what is already in.
 */
export interface ImportedConversation {
  /** Absent means `'codex'` — see `FosterImportMark.source`. */
  source?: 'codex' | 'cloud';
  rolloutId: string;
  sourceRolloutPath: string;
  contentHash: string;
  cliVersion?: string;
  target: AccountRef;
  cardPath: string;
  transcriptPath: string;
  sessionId: string;
  title?: string;
  importedAt: number;
}

/**
 * A card whose archived flag foster's own `archive_synced` write last set,
 * keyed by session id — the folded projection of `ArchiveSyncedEvent`.
 *
 * Unlike `RetitledCard`, `from` here is the *most recent* write's own `from`,
 * not the original value carried forward: `engine/archiveSync.ts` only ever
 * needs "what did this write set the flag to, and when", to decide whether a
 * later disagreement is the user overriding foster or foster catching up with
 * a source that moved on again. `card_retitled`'s own `toArchived` is a
 * second, independent source of the same fact and is read alongside this one
 * rather than merged into it — see `lastForsterArchiveWrite`.
 */
export interface ArchiveSyncedCard {
  sessionId: string;
  path: string;
  target: AccountRef;
  from: boolean;
  to: boolean;
  native: boolean;
  syncedAt: number;
}

/** A fostering that is currently in place, derived by folding the log. */
export interface ActiveFostering {
  originSessionId: string;
  origin: AccountRef;
  target: AccountRef;
  copySessionId: string;
  copyPath: string;
  originalTitle?: string;
  /**
   * What foster put in front of the title when it made this copy, when it put
   * anything — the `↪ ` of the era before 0.37.0, and empty ever since.
   *
   * Kept because it is foster's own writing and nothing else can prove that: it
   * carries no moment, so `templatesSeen` will not derive a template from it and
   * `stripMarks` cannot take it off. Without this a copy still wearing it reads
   * as a title somebody chose, and the title pass reports a conflict over a
   * prefix foster wrote itself.
   */
  prefix?: string;
  /** The conversation behind both the copy and the original, when it was recorded. */
  cliSessionId?: string;
  /** The installation the original lives in, when it is not the one holding the copy. */
  originStore?: string;
  fosteredAt: number;
  /** True when foster wrote the copy archived by its own decision — see `FosteredEvent.archived`. */
  archivedByFoster?: true;
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
