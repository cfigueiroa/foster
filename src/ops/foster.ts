import {
  applyFilter,
  byRecency,
  selectByIds,
  type ReachCheck,
  type SessionFilter,
} from '../domain/filter.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds } from '../ledger/project.js';
import { fromAccounts, scanSources, scanStore } from '../store/scanner.js';
import { liveSessions, sessionRegistryRoots } from '../store/liveSessions.js';
import { ambiguousIds, requireUniquePrefix } from '../domain/prefix.js';

/**
 * Sessions a sweep may offer, classified the way the ledger classifies them.
 *
 * The on-disk `_foster` marker dies the first time the app saves a copy, so a
 * scan that does not consult the ledger will offer those copies as if they were
 * new sessions. Every surface — command, menu, agent — has to go through here.
 *
 * `here` is the destination's own reach, built by the caller with `sidebarOf` —
 * not resolved from an account id here, because the destination's cards can
 * live in a different store than `store` names (an install read cross-store via
 * `--from-store`), and only the caller knows which. Given it, a copy that
 * carried on somewhere `here` cannot reach can be offered back rather than
 * refused as not the last card left (#49). Left out, a caller with no settled
 * destination yet — `foster list` without a fixed one — keeps asking only "is
 * this the last one?", which is the answer it always gave.
 */
export function listFosterable(
  store: StoreLayout,
  sources: AccountRef[],
  ledger: Ledger,
  filter: SessionFilter = {},
  here?: ReachCheck,
): DiscoveredSession[] {
  return fosterableFrom(scanStore(store, copySessionIds(ledger.read())), sources, filter, here);
}

/**
 * The same answer from a scan the caller already holds.
 *
 * `scanned` has to be the whole store, classified by the ledger — what
 * `scanStore(store, copySessionIds(...))` returns — because whether a copy is the
 * last card of its conversation is decided against every account, the
 * destination included. See `scanSources`.
 */
export function fosterableFrom(
  scanned: DiscoveredSession[],
  sources: AccountRef[],
  filter: SessionFilter = {},
  here?: ReachCheck,
): DiscoveredSession[] {
  return byRecency(applyFilter(fromAccounts(scanned, sources), filter, here));
}

/**
 * The unfiltered scan of those sources, still classified by the ledger — so a
 * "N not shown (already a copy)" count is about the same copies the next
 * screen will hide.
 */
export function scanFosterable(
  store: StoreLayout,
  sources: AccountRef[],
  ledger: Ledger,
): DiscoveredSession[] {
  return scanSources(store, sources, copySessionIds(ledger.read()));
}

export function selectFosterSessions(
  candidates: DiscoveredSession[],
  sessionIds: string[],
): DiscoveredSession[] {
  const { selected, unmatched } = selectByIds(candidates, sessionIds);
  if (unmatched.length > 0) {
    throw new Error(`No session matches ${unmatched.join(', ')}.`);
  }
  return byRecency(selected);
}

export function matchAccountPrefix(refs: AccountRef[], prefix: string, flag: string): AccountRef[] {
  return requireUniquePrefix(refs, prefix, (ref) => ref.accountUuid, {
    none: `No account matches ${flag} "${prefix}".`,
    ambiguous: (ids) => ambiguousIds(flag, prefix, 'account', ids),
  });
}

export function matchOrganizationPrefix(
  refs: AccountRef[],
  prefix: string,
  flag: string,
): AccountRef[] {
  return requireUniquePrefix(refs, prefix, (ref) => ref.organizationUuid, {
    none: `No organization matches ${flag} "${prefix}".`,
    ambiguous: (ids) => ambiguousIds(flag, prefix, 'organization', ids),
  });
}

/** Conversations a live `claude` is writing, lower-cased — the set fosterSessions wants. */
export function liveConversationIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    liveSessions(sessionRegistryRoots(env)).map((session) => session.sessionId.toLowerCase()),
  );
}
