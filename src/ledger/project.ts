import { fosteringKey } from '../domain/fostering.js';
import type { ActiveFostering, LedgerEvent } from './types.js';

export interface LedgerState {
  /** Keyed by origin session + target account: one active copy per pair. */
  active: Map<string, ActiveFostering>;
  labels: Map<string, string>;
}

/**
 * Current state is a pure fold over the event log — there is no mutable record to
 * drift out of sync with the file.
 */
export function project(events: LedgerEvent[]): LedgerState {
  const active = new Map<string, ActiveFostering>();
  const labels = new Map<string, string>();

  for (const event of events) {
    switch (event.kind) {
      case 'account_labelled':
        labels.set(event.accountUuid, event.label);
        break;

      case 'fostered':
        active.set(fosteringKey(event.originSessionId, event.target), {
          originSessionId: event.originSessionId,
          origin: event.origin,
          target: event.target,
          copySessionId: event.copySessionId,
          copyPath: event.copyPath,
          originalTitle: event.originalTitle,
          cliSessionId: event.cliSessionId,
          originStore: event.originStore,
          fosteredAt: event.ts,
        });
        break;

      case 'returned':
        active.delete(fosteringKey(event.originSessionId, event.target));
        break;

      case 'conversation_purged':
        // Deliberately no state. A purge destroys a conversation, not a
        // fostering: the cards that pointed at it were already gone — that is
        // the precondition for purging at all — so there is nothing here to fold
        // away. The event is history, and history is all it can be.
        break;

      case 'failed':
        // Failures are recorded for the audit trail but do not change state.
        break;
    }
  }

  return { active, labels };
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
