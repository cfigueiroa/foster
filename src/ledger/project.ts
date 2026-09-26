import { fosteringKey } from '../domain/fostering.js';
import type { KnownIdentity } from '../domain/identity.js';
import { comparablePath } from '../domain/paths.js';
import type {
  ActiveFostering,
  ArchiveSyncedCard,
  DatedCard,
  ImportedConversation,
  LedgerEvent,
  RepointedCard,
  RetitledCard,
  WorktreeReleasedCard,
} from './types.js';

export type { KnownIdentity };

export interface LedgerState {
  /**
   * Every active copy, keyed by the copy's own session id.
   *
   * Not keyed by `fosteringKey`: the executor's #63 path legitimately writes a
   * *second* copy under one idempotency key when the offered card's own file
   * reaches records the first copy cannot (a second file of one conversation,
   * `resolveExisting` in `engine/executor.ts`) — both copies are current and
   * both have to stay tracked. Keying on the copy id, which is unique and never
   * reused, is what makes that possible; keying on the fostering key made the
   * second `fostered` event overwrite the first in this map, which is why
   * `return`, `unclaim`, `titleSync` and everything else that reads `active`
   * lost the older copy — it was still on disk, un-tracked. Measured against the
   * real ledger: 275 `fostered` events overwrote a still-active key this way.
   * See `activeByKey` for the lookup this replaces.
   */
  active: Map<string, ActiveFostering>;
  /**
   * Reverse index from `fosteringKey` to every copy id currently filed under
   * it — almost always one, occasionally two (see `active` above). This is
   * what `isFostered` and the executor's idempotency check read; nothing else
   * needs it, because everything else already enumerates copies through
   * `listActive`/`active.values()`.
   */
  activeByKey: Map<string, Set<string>>;
  labels: Map<string, string>;
  /** Who each account belongs to, as last seen — see KnownIdentity. */
  identities: Map<string, KnownIdentity>;
  /** Cards sitting on a conversation the app did not put them on, keyed by session id. */
  repointed: Map<string, RepointedCard>;
  /** Cards wearing a title, or an archived flag, the app did not give them, keyed by session id. */
  retitled: Map<string, RetitledCard>;
  /**
   * Cards wearing a `lastActivityAt` the app did not give them, keyed by
   * session id — see `CardDatedEvent`.
   */
  dated: Map<string, DatedCard>;
  /**
   * Cards whose archived flag foster's own `archive_synced` write last set,
   * keyed by session id — see `ArchiveSyncedEvent` and `engine/archiveSync.ts`.
   */
  archiveSynced: Map<string, ArchiveSyncedCard>;
  /**
   * Copies whose worktree claim was released and not yet put back, keyed by
   * path — see `WorktreeReleasedEvent`.
   */
  worktreeReleased: Map<string, WorktreeReleasedCard>;
  /**
   * Codex rollouts imported and not yet undone, keyed by rollout id — see
   * `ConversationImportedEvent`.
   */
  imported: Map<string, ImportedConversation>;
  /**
   * Named Desktop installations, keyed by name. Re-registering a name points it
   * at a new root — the fold keeps only the latest, which is the rename.
   */
  profiles: Map<string, string>;
  /**
   * Registered CLI client roots, keyed by the root itself, holding whether it is
   * a single client directory or a container of several — see
   * `ClientRootRegisteredEvent`.
   */
  clientRoots: Map<string, 'client' | 'container'>;
  /**
   * The `claude://` handler's previous state, while a login is in flight —
   * see `HandlerArmedEvent`. `key` and `previous` are carried straight from
   * the event. A `handler_restored` with `restored: true` clears this, so its
   * presence alone says a login was interrupted before it could put the
   * handler back. One with `restored: false` means the attempt ran and the
   * read-back did not match — there is still a route to put back, so `key`
   * and `previous` stay put and `restoreFailed` is set, instead of throwing
   * away the one record that says what to restore and to where.
   */
  handlerArmed?: {
    root: string;
    key: string;
    previous: string;
    at: number;
    /** Set when the most recent `handler_restored` for this record failed. */
    restoreFailed?: boolean;
  };
}

/**
 * The last fold this process computed for a given events array, so a second
 * `project()` call over the same `Ledger.read()` result does not redo it.
 *
 * Keyed by the array's own identity (a `WeakMap`, so a projected-away events
 * array is not held alive by this cache) and its length, matching how
 * `Ledger.append()` keeps its cached array — same identity, longer — rather
 * than handing out a new one. A length change is the cheap, sufficient proxy
 * for "the content changed" here: nothing under `src/` mutates an events array
 * in place (`ledger/log.ts` only ever pushes), so identity plus length is as
 * good a fingerprint as hashing the contents, for a fraction of the cost.
 */
const foldCache = new WeakMap<LedgerEvent[], { length: number; state: LedgerState }>();

/**
 * Current state is a pure fold over the event log — there is no mutable record to
 * drift out of sync with the file. `project()` itself is the cached, public
 * entry point: it returns a fresh shallow copy of a memoized fold, never the
 * fold's own Maps. `fosterSessions` (`engine/executor.ts`) and
 * `identifyHeldAccounts` (`cli/index.ts`) both delete/set entries on the state
 * they get back mid-run, to reconcile it against what they are about to write —
 * sound when every call got its own brand-new Maps, which is what this
 * preserves even though the expensive fold underneath now runs once per
 * distinct array rather than once per call.
 */
export function project(events: LedgerEvent[]): LedgerState {
  const cached = foldCache.get(events);
  if (cached && cached.length === events.length) return cloneState(cached.state);

  const state = foldEvents(events);
  foldCache.set(events, { length: events.length, state });
  return cloneState(state);
}

/** Shallow copy: same entries, Maps (and the one nested object) a caller owns. */
function cloneState(state: LedgerState): LedgerState {
  return {
    active: new Map(state.active),
    activeByKey: new Map(Array.from(state.activeByKey, ([key, copies]) => [key, new Set(copies)])),
    labels: new Map(state.labels),
    identities: new Map(state.identities),
    repointed: new Map(state.repointed),
    retitled: new Map(state.retitled),
    dated: new Map(state.dated),
    archiveSynced: new Map(state.archiveSynced),
    worktreeReleased: new Map(state.worktreeReleased),
    imported: new Map(state.imported),
    profiles: new Map(state.profiles),
    clientRoots: new Map(state.clientRoots),
    ...(state.handlerArmed ? { handlerArmed: { ...state.handlerArmed } } : {}),
  };
}

function foldEvents(events: LedgerEvent[]): LedgerState {
  const active = new Map<string, ActiveFostering>();
  const activeByKey = new Map<string, Set<string>>();
  const labels = new Map<string, string>();
  const identities = new Map<string, KnownIdentity>();
  const repointed = new Map<string, RepointedCard>();
  const retitled = new Map<string, RetitledCard>();
  const dated = new Map<string, DatedCard>();
  const archiveSynced = new Map<string, ArchiveSyncedCard>();
  const worktreeReleased = new Map<string, WorktreeReleasedCard>();
  const imported = new Map<string, ImportedConversation>();
  const profiles = new Map<string, string>();
  const clientRoots = new Map<string, 'client' | 'container'>();
  let handlerArmed: LedgerState['handlerArmed'];
  // Which fostering key a copy was filed under, so a repoint or a return can
  // find it from the card alone. Also what keeps `activeByKey` honest: it is
  // the only record of which key a given copy's entry has to be removed from.
  const fosteringOfCopy = new Map<string, string>();

  const indexByKey = (key: string, copySessionId: string): void => {
    let copies = activeByKey.get(key);
    if (!copies) {
      copies = new Set();
      activeByKey.set(key, copies);
    }
    copies.add(copySessionId);
  };
  const unindexByKey = (key: string | undefined, copySessionId: string): void => {
    if (key === undefined) return;
    const copies = activeByKey.get(key);
    if (!copies) return;
    copies.delete(copySessionId);
    if (copies.size === 0) activeByKey.delete(key);
  };

  for (const event of events) {
    switch (event.kind) {
      // An empty label is how a name is taken back: the log is append-only, so
      // "no longer called that" has to be something written down rather than a
      // line removed. `applyLabel` refuses to write one, so the only source is
      // `label --clear`, and the account falls back to whatever else names it.
      case 'account_labelled':
        if (event.label) labels.set(event.accountUuid, event.label);
        else labels.delete(event.accountUuid);
        break;

      case 'account_identity_seen': {
        // Merged over what is already known, so a run that saw only the name
        // keeps the plan an earlier one recorded. The timestamp moves regardless:
        // it marks when the account was last looked at, which is what makes a
        // remembered answer honest about its age.
        const known = identities.get(event.accountUuid);
        identities.set(event.accountUuid, {
          ...known,
          ...(event.email ? { email: event.email } : {}),
          ...(event.name ? { name: event.name } : {}),
          ...(event.plan ? { plan: event.plan } : {}),
          // Merged one level down as well, so a sighting that found the profile
          // but not the billing half keeps the card and renewal date an earlier
          // one recorded. Replacing the object wholesale would lose them on
          // every ordinary visit.
          ...(event.profile ? { profile: { ...known?.profile, ...event.profile } } : {}),
          seenAt: event.ts,
        });
        break;
      }

      // Dropped whole rather than field by field: a sighting is one reading of
      // one profile, and half-keeping it would leave the name of an account
      // whose email was wrong — which is the same mistake, quieter.
      case 'account_identity_forgotten':
        identities.delete(event.accountUuid);
        break;

      case 'fostered': {
        const key = fosteringKey(event.originSessionId, event.target, event.cliSessionId);
        active.set(event.copySessionId, {
          originSessionId: event.originSessionId,
          origin: event.origin,
          target: event.target,
          copySessionId: event.copySessionId,
          copyPath: event.copyPath,
          originalTitle: event.originalTitle,
          ...(event.prefix ? { prefix: event.prefix } : {}),
          cliSessionId: event.cliSessionId,
          originStore: event.originStore,
          fosteredAt: event.ts,
          ...(event.archived ? { archivedByFoster: true } : {}),
        });
        fosteringOfCopy.set(event.copySessionId, key);
        indexByKey(key, event.copySessionId);
        break;
      }

      case 'returned':
        // Resolved through the copy, which is the primary key of `active` now —
        // no need to rebuild the fostering key first. `activeByKey` still needs
        // one, to know which key's set to drop the copy from; the legacy
        // fallback covers a `returned` for a copy whose `fostered` event this
        // fold never saw (a log that starts mid-stream).
        unindexByKey(
          fosteringOfCopy.get(event.copySessionId) ??
            fosteringKey(event.originSessionId, event.target),
          event.copySessionId,
        );
        active.delete(event.copySessionId);
        fosteringOfCopy.delete(event.copySessionId);
        break;

      case 'fostering_followed':
        // The copy is the same file in the same account; only the conversation it
        // holds has moved. Keeping the fostering and moving its pointer is the
        // whole point — dropping it is what used to make the next sweep write a
        // second card for work that already had a row.
        //
        // Resolved through the copy, which needs no key lookup any more: `active`
        // is keyed on the copy id directly, and the idempotency key this copy was
        // filed under (`activeByKey`) never changes here — it names the
        // conversation that was copied *from the origin*, which does not move
        // when the app branches the copy. `cliSessionId` is what tracks where the
        // copy went, and that is the only field this write updates.
        {
          const fostering = active.get(event.copySessionId);
          if (fostering) {
            active.set(event.copySessionId, {
              ...fostering,
              cliSessionId: event.to,
              followedBranch: true,
            });
          }
        }

        // Foster's own claim on this card lapses here. `repointed` is what
        // `--undo` reads, and it means "foster moved this, and can put it back";
        // once the app has moved the same card somewhere foster never put it,
        // putting it back would not restore a state foster is responsible for —
        // it would drop the branch the app just made, which is the one thing on
        // that card nothing else holds.
        repointed.delete(event.copySessionId);
        break;

      case 'card_repointed': {
        // The conversation a copy holds moves with it. Without this the next
        // command reads the file, finds a pointer that disagrees with the ledger,
        // and calls the copy `repurposed` — dropping the tracking of the very
        // card foster had just put right. Resolved straight off the copy id —
        // `active`'s own key now — with no need for `fosteringOfCopy` at all.
        const fostering = active.get(event.sessionId);
        if (fostering) {
          active.set(event.sessionId, { ...fostering, cliSessionId: event.to });
        }

        // `from` is where the app had it, which the first repoint is the only one
        // to know. Later ones carry it forward, so putting a card back is always
        // the same destination however many times it has moved.
        const known = repointed.get(event.sessionId);
        const origin = known?.from ?? event.from;
        const originActivity = known ? known.fromActivityAt : event.fromActivityAt;
        if (event.to === origin) repointed.delete(event.sessionId);
        else {
          repointed.set(event.sessionId, {
            sessionId: event.sessionId,
            path: event.path,
            target: event.target,
            from: origin,
            to: event.to,
            ...(originActivity === undefined ? {} : { fromActivityAt: originActivity }),
            native: event.native,
            repointedAt: event.ts,
          });
        }
        break;
      }

      case 'card_retitled': {
        // The original title and flag are what the first write saw; later ones
        // carry them forward, so the answer to "what did the app have here?" is
        // the same however many sweeps have marked the card since. A card written
        // back to exactly that stops being one of these.
        const known = retitled.get(event.sessionId);
        const from = known?.from ?? event.from;
        const fromArchived = known ? known.fromArchived : event.fromArchived;
        const archivedNow = event.toArchived ?? known?.toArchived;
        // Only a write that *undoes* a mark can land the card back where it
        // started. A write that puts one on lands on the same string whenever the
        // card was already wearing that very mark when foster first saw it — a
        // copy made from an already-marked card, whose `from` is therefore the
        // marked title (#79). Reading that as "back to the original" deletes the
        // record of the mark the branch pass just wrote, and the title sync that
        // runs next in the same sweep then has nothing proving there is a mark to
        // preserve: it strips it, the next sweep writes it again, and the two
        // passes undo each other for ever.
        // Written as "not a marking write" rather than as a list of the undoing
        // ones, so an entry from before `as` was kept still counts as undoing.
        const marks = event.as === 'stale' || event.as === 'diverged';
        const back =
          !marks && event.to === from && (archivedNow ?? false) === (fromArchived ?? false);
        // What this write did to the mark, taken from the write's own account of
        // itself rather than from the strings: a sync changes the title under the
        // mark and leaves the mark alone, `tip` is the write that takes one off,
        // and the two marking kinds leave the mark they just put on standing in
        // front of `to`.
        const markedTo =
          event.as === 'synced' ? known?.markedTo : event.as === 'tip' ? undefined : event.to;
        if (back) retitled.delete(event.sessionId);
        else {
          retitled.set(event.sessionId, {
            sessionId: event.sessionId,
            path: event.path,
            target: event.target,
            from,
            to: event.to,
            ...(markedTo === undefined ? {} : { markedTo }),
            ...(fromArchived === undefined ? {} : { fromArchived }),
            ...(archivedNow === undefined ? {} : { toArchived: archivedNow }),
            native: event.native,
            retitledAt: event.ts,
          });
        }
        break;
      }

      case 'card_dated': {
        // Same shape as `card_retitled`: the first write's `from` is what the
        // app had, later writes carry it forward, and a write that lands back
        // on that value is indistinguishable from never having touched the
        // card at all — which is what makes `undoDateRequests` need no event
        // of its own, only another write in the other direction.
        const known = dated.get(event.sessionId);
        const from = known?.from ?? event.from;
        const back = from !== undefined && event.to === from;
        if (back) dated.delete(event.sessionId);
        else {
          dated.set(event.sessionId, {
            sessionId: event.sessionId,
            path: event.path,
            target: event.target,
            ...(from === undefined ? {} : { from }),
            to: event.to,
            native: event.native,
            datedAt: event.ts,
          });
        }
        break;
      }

      case 'archive_synced':
        // No history to carry forward the way `card_retitled`'s `from` is: a
        // write that lands the flag back on `from` still says something —
        // that a source moved on and back — and `engine/archiveSync.ts` only
        // ever reads the latest write's own `to` and timestamp, never asks
        // "what did the app have before foster touched this at all". So this
        // is a plain overwrite, keyed on session id like every other of these
        // small per-card maps.
        archiveSynced.set(event.sessionId, {
          sessionId: event.sessionId,
          path: event.path,
          target: event.target,
          from: event.from,
          to: event.to,
          native: event.native,
          syncedAt: event.ts,
        });
        break;

      case 'worktree_released':
        // Keyed the same way `storeRootOfCopy` comparisons are everywhere else in
        // this fold: two spellings of one file must not become two open releases,
        // one of them invisible to `--undo` because it was written under the path
        // the other case happened to use.
        worktreeReleased.set(comparablePath(event.path), {
          path: event.path,
          sessionId: event.sessionId,
          ...(event.worktreePath !== undefined ? { worktreePath: event.worktreePath } : {}),
          ...(event.worktreeName !== undefined ? { worktreeName: event.worktreeName } : {}),
          ...(event.worktreeLazy !== undefined ? { worktreeLazy: event.worktreeLazy } : {}),
          ...(event.cwdFrom !== undefined ? { cwdFrom: event.cwdFrom } : {}),
          ...(event.cwdTo !== undefined ? { cwdTo: event.cwdTo } : {}),
          releasedAt: event.ts,
        });
        break;

      case 'worktree_release_undone':
        worktreeReleased.delete(comparablePath(event.path));
        break;

      case 'conversation_imported':
        imported.set(event.rolloutId, {
          ...(event.source !== undefined ? { source: event.source } : {}),
          rolloutId: event.rolloutId,
          sourceRolloutPath: event.sourceRolloutPath,
          contentHash: event.contentHash,
          ...(event.cliVersion !== undefined ? { cliVersion: event.cliVersion } : {}),
          target: event.target,
          cardPath: event.cardPath,
          transcriptPath: event.transcriptPath,
          sessionId: event.sessionId,
          ...(event.title !== undefined ? { title: event.title } : {}),
          importedAt: event.ts,
        });
        break;

      case 'conversation_import_undone':
        imported.delete(event.rolloutId);
        break;

      // Re-registering a known name is the rename: `set` replaces the root a
      // name pointed at rather than refusing, because a profile is the name,
      // not the path underneath it.
      case 'profile_registered':
        profiles.set(event.name, event.root);
        break;

      case 'profile_forgotten':
        profiles.delete(event.name);
        break;

      case 'client_root_registered':
        clientRoots.set(event.root, event.as);
        break;

      case 'client_root_forgotten':
        clientRoots.delete(event.root);
        break;

      case 'handler_armed':
        handlerArmed = {
          root: event.root,
          key: event.key,
          previous: event.previous,
          at: event.ts,
        };
        break;

      case 'handler_restored':
        // A successful restore closes the window `handler_armed` opened —
        // there is nothing left to put back. A failed one means the write did
        // not take: the route is still pointed at a profile, so the record of
        // what to restore (`key`/`previous`) has to survive for `--restore`
        // and `doctor` to act on, marked so callers can tell the last attempt
        // did not work.
        if (event.restored) {
          handlerArmed = undefined;
        } else if (handlerArmed !== undefined) {
          handlerArmed = { ...handlerArmed, restoreFailed: true };
        }
        break;

      case 'account_switched':
      case 'conversation_purged':
      case 'failed':
      case 'layout_applied':
      case 'pin_move_deferred':
      case 'pins_moved':
      case 'pins_synced':
      case 'layout_assigned':
      case 'view_carried':
      case 'view_seen':
        // History, not state. A switch, a purge, a failure and a layout run are
        // recorded so the log can say what happened; none of them change the
        // fold — the app owns both files a layout run writes, so there is
        // nothing here for a later command to read back as current state.
        // Deferred pin moves are read straight off the events by
        // `pendingPinMoves` (`engine/pinMoves.ts`), not through the fold; the
        // cross-account parity events added alongside pins (`pins_synced`,
        // `layout_assigned`, `view_carried`, `view_seen`) are read the same
        // direct way by `engine/pinParity.ts`, `engine/layout.ts` and
        // `engine/view.ts`.
        break;
    }
  }

  return {
    active,
    activeByKey,
    labels,
    identities,
    repointed,
    retitled,
    dated,
    archiveSynced,
    worktreeReleased,
    imported,
    profiles,
    clientRoots,
    ...(handlerArmed ? { handlerArmed } : {}),
  };
}

/** Cards currently pointed somewhere the app did not point them, oldest move first. */
export function listRepointed(state: LedgerState): RepointedCard[] {
  return [...state.repointed.values()].sort((a, b) => a.repointedAt - b.repointedAt);
}

/** Cards wearing a title or flag the app did not give them, oldest write first. */
export function listRetitled(state: LedgerState): RetitledCard[] {
  return [...state.retitled.values()].sort((a, b) => a.retitledAt - b.retitledAt);
}

/** Cards wearing a `lastActivityAt` the app did not give them, oldest write first. */
export function listDated(state: LedgerState): DatedCard[] {
  return [...state.dated.values()].sort((a, b) => a.datedAt - b.datedAt);
}

/** Cards whose archived flag `archive_synced` last set, oldest write first. */
export function listArchiveSynced(state: LedgerState): ArchiveSyncedCard[] {
  return [...state.archiveSynced.values()].sort((a, b) => a.syncedAt - b.syncedAt);
}

/**
 * The latest value foster itself established for a card's archived flag,
 * whichever of the two writers set it last — `archive_synced`
 * (`state.archiveSynced`) or a `card_retitled` whose `toArchived` this fold
 * already carries in `state.retitled` — plus when.
 *
 * `undefined` means neither has ever touched this card's flag: the card is
 * either a bare fostering that took the default (unarchived, unless the
 * branch pass archived it on purpose — see `FosteredEvent.archived`) or a
 * native card foster has never written to at all. `engine/archiveSync.ts`
 * reads this to tell a value the *user* changed by hand from one it can
 * still bring back into step.
 */
export function lastForsterArchiveWrite(
  state: LedgerState,
  sessionId: string,
): { value: boolean; at: number } | undefined {
  const synced = state.archiveSynced.get(sessionId);
  const retitled = state.retitled.get(sessionId);
  const candidates: { value: boolean; at: number }[] = [];
  if (synced) candidates.push({ value: synced.to, at: synced.syncedAt });
  if (retitled?.toArchived !== undefined) {
    candidates.push({ value: retitled.toArchived, at: retitled.retitledAt });
  }
  if (candidates.length === 0) return undefined;
  return candidates.reduce((latest, next) => (next.at >= latest.at ? next : latest));
}

/** Copies whose worktree claim is released and not yet put back, oldest first. */
export function listWorktreeReleased(state: LedgerState): WorktreeReleasedCard[] {
  return [...state.worktreeReleased.values()].sort((a, b) => a.releasedAt - b.releasedAt);
}

/** Codex rollouts and cloud sessions imported and not yet undone, oldest import first. */
export function listImported(state: LedgerState): ImportedConversation[] {
  return [...state.imported.values()].sort((a, b) => a.importedAt - b.importedAt);
}

/**
 * `listImported`, scoped to one importer's own conversations — `source`
 * absent on an entry means `'codex'` (see `ImportedConversation.source`).
 *
 * Both importers fold into the same `state.imported` map, keyed on
 * `rolloutId` alone, so a bare `--undo` (no `--session` filter) must ask for
 * its own source explicitly rather than sweeping up the other importer's
 * conversations just because they happen to share the map.
 */
export function listImportedFrom(
  state: LedgerState,
  source: 'codex' | 'cloud',
): ImportedConversation[] {
  return listImported(state).filter((i) => (i.source ?? 'codex') === source);
}

/**
 * Every session id foster has ever written, whether or not the copy still exists.
 *
 * Ids are minted here and never reused, so an id from a returned fostering cannot
 * collide with anything else — which makes the whole history the safe answer, and
 * a cheaper one than folding.
 */
export function copySessionIds(events: LedgerEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) if (event.kind === 'fostered') ids.add(event.copySessionId);
  return ids;
}

export function listActive(state: LedgerState): ActiveFostering[] {
  return [...state.active.values()].sort((a, b) => a.fosteredAt - b.fosteredAt);
}

/**
 * Narrow to the copies sitting in one account.
 *
 * `foster` chooses where copies go with `--to`; without the same axis here, the
 * command that undoes it could not read the one dimension it was written along.
 * The target of every copy has been in the ledger from the start — the filter
 * was simply missing, and its absence left "clean up the account I stopped
 * using" with no expression short of listing every id by hand, while the
 * unfiltered command removed the copies in the account still in use.
 *
 * Matched against the accounts that actually hold copies rather than the
 * directories on disk, because that is the question being asked. A prefix
 * matching nothing is answered with where the copies really are, which is the
 * fact the user was reaching for anyway.
 */
export function selectByTarget(
  active: ActiveFostering[],
  accountPrefix: string | undefined,
  organizationPrefix: string | undefined,
): ActiveFostering[] {
  let selected = active;

  if (accountPrefix !== undefined) {
    selected = selected.filter((f) => f.target.accountUuid.startsWith(accountPrefix));
  }
  if (organizationPrefix !== undefined) {
    selected = selected.filter((f) => f.target.organizationUuid.startsWith(organizationPrefix));
  }

  if (selected.length === 0) {
    const named =
      accountPrefix !== undefined ? `--to "${accountPrefix}"` : `--to-org "${organizationPrefix}"`;
    throw new Error(
      `No fostered copies are in the account ${named} names.\nCopies are in:\n${whereCopiesAre(active)}`,
    );
  }

  // Ambiguity is reported rather than guessed at, as everywhere else — and it
  // matters more here than anywhere, because guessing wide removes copies from
  // an account the user never named.
  const accounts = new Set(selected.map((f) => f.target.accountUuid));
  if (accountPrefix !== undefined && accounts.size > 1) {
    throw new Error(
      `--to "${accountPrefix}" is ambiguous: it matches ${accounts.size} accounts.\n` +
        [...accounts].map((uuid) => `  ${uuid}`).join('\n'),
    );
  }

  return selected;
}

/** One line per account holding copies — the answer to "where are they, then?". */
export function whereCopiesAre(active: ActiveFostering[]): string {
  const counts = new Map<string, number>();
  for (const fostering of active) {
    counts.set(fostering.target.accountUuid, (counts.get(fostering.target.accountUuid) ?? 0) + 1);
  }

  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([uuid, count]) => `  ${uuid}  ${count} cop${count === 1 ? 'y' : 'ies'}`)
    .join('\n');
}

/**
 * Idempotency check. Fostering mints a new sessionId every time, so "has this
 * already been done?" cannot be answered by looking for a file — it has to be
 * keyed on the origin session and the target account.
 */
export function isFostered(
  state: LedgerState,
  originSessionId: string,
  target: { accountUuid: string; organizationUuid: string },
  cliSessionId?: string,
): boolean {
  const hasAny = (key: string): boolean => (state.activeByKey.get(key)?.size ?? 0) > 0;
  if (hasAny(fosteringKey(originSessionId, target, cliSessionId))) return true;
  // The legacy key, for fosterings written before the conversation was recorded.
  return cliSessionId !== undefined && hasAny(fosteringKey(originSessionId, target));
}
