import { fosteringKey } from '../domain/fostering.js';
import type { KnownIdentity } from '../domain/identity.js';
import type { ActiveFostering, LedgerEvent, RepointedCard, RetitledCard } from './types.js';

export type { KnownIdentity };

export interface LedgerState {
  /** Keyed by origin session + target account: one active copy per pair. */
  active: Map<string, ActiveFostering>;
  labels: Map<string, string>;
  /** Who each account belongs to, as last seen — see KnownIdentity. */
  identities: Map<string, KnownIdentity>;
  /** Cards sitting on a conversation the app did not put them on, keyed by session id. */
  repointed: Map<string, RepointedCard>;
  /** Cards wearing a title, or an archived flag, the app did not give them, keyed by session id. */
  retitled: Map<string, RetitledCard>;
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
   * see `HandlerArmedEvent`. Exactly one of `previous`/`createdFrom` is set,
   * carried straight from the event. Cleared by `handler_restored`, so its
   * presence alone says a login was interrupted before it could put the
   * handler back.
   */
  handlerArmed?: {
    root: string;
    previous?: string;
    createdFrom?: 'shell' | 'open' | 'command';
    at: number;
  };
}

/**
 * Current state is a pure fold over the event log — there is no mutable record to
 * drift out of sync with the file.
 */
export function project(events: LedgerEvent[]): LedgerState {
  const active = new Map<string, ActiveFostering>();
  const labels = new Map<string, string>();
  const identities = new Map<string, KnownIdentity>();
  const repointed = new Map<string, RepointedCard>();
  const retitled = new Map<string, RetitledCard>();
  const profiles = new Map<string, string>();
  const clientRoots = new Map<string, 'client' | 'container'>();
  let handlerArmed: LedgerState['handlerArmed'];
  // Which fostering a copy belongs to, so a repoint can find it. The fold is
  // keyed on the origin session, and a repoint knows only the card it rewrote.
  const fosteringOfCopy = new Map<string, string>();

  for (const event of events) {
    switch (event.kind) {
      case 'account_labelled':
        labels.set(event.accountUuid, event.label);
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
        const key = fosteringKey(event.originSessionId, event.target);
        active.set(key, {
          originSessionId: event.originSessionId,
          origin: event.origin,
          target: event.target,
          copySessionId: event.copySessionId,
          copyPath: event.copyPath,
          originalTitle: event.originalTitle,
          cliSessionId: event.cliSessionId,
          originStore: event.originStore,
          fosteredAt: event.ts,
          ...(event.archived ? { archivedByFoster: true } : {}),
        });
        fosteringOfCopy.set(event.copySessionId, key);
        break;
      }

      case 'returned':
        active.delete(fosteringKey(event.originSessionId, event.target));
        fosteringOfCopy.delete(event.copySessionId);
        break;

      case 'fostering_followed': {
        // The copy is the same file in the same account; only the conversation it
        // holds has moved. Keeping the fostering and moving its pointer is the
        // whole point — dropping it is what used to make the next sweep write a
        // second card for work that already had a row.
        const key = fosteringKey(event.originSessionId, event.target);
        const fostering = active.get(key);
        if (fostering) {
          active.set(key, { ...fostering, cliSessionId: event.to, followedBranch: true });
        }

        // Foster's own claim on this card lapses here. `repointed` is what
        // `--undo` reads, and it means "foster moved this, and can put it back";
        // once the app has moved the same card somewhere foster never put it,
        // putting it back would not restore a state foster is responsible for —
        // it would drop the branch the app just made, which is the one thing on
        // that card nothing else holds.
        repointed.delete(event.copySessionId);
        break;
      }

      case 'card_repointed': {
        // The conversation a copy holds moves with it. Without this the next
        // command reads the file, finds a pointer that disagrees with the ledger,
        // and calls the copy `repurposed` — dropping the tracking of the very
        // card foster had just put right.
        const key = fosteringOfCopy.get(event.sessionId);
        const fostering = key === undefined ? undefined : active.get(key);
        if (key !== undefined && fostering) {
          active.set(key, { ...fostering, cliSessionId: event.to });
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
        const back = event.to === from && (archivedNow ?? false) === (fromArchived ?? false);
        if (back) retitled.delete(event.sessionId);
        else {
          retitled.set(event.sessionId, {
            sessionId: event.sessionId,
            path: event.path,
            target: event.target,
            from,
            to: event.to,
            ...(fromArchived === undefined ? {} : { fromArchived }),
            ...(archivedNow === undefined ? {} : { toArchived: archivedNow }),
            native: event.native,
            retitledAt: event.ts,
          });
        }
        break;
      }

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
          at: event.ts,
          ...(event.previous !== undefined ? { previous: event.previous } : {}),
          ...(event.createdFrom !== undefined ? { createdFrom: event.createdFrom } : {}),
        };
        break;

      case 'handler_restored':
        handlerArmed = undefined;
        break;

      case 'account_switched':
      case 'conversation_purged':
      case 'failed':
        // History, not state. A switch, a purge and a failure are recorded so
        // the log can say what happened; none of them change the fold.
        break;
    }
  }

  return {
    active,
    labels,
    identities,
    repointed,
    retitled,
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
): boolean {
  return state.active.has(fosteringKey(originSessionId, target));
}
