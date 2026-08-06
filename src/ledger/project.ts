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
