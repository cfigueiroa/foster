import { applyFilter, byRecency, selectByIds, type SessionFilter } from '../domain/filter.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds } from '../ledger/project.js';
import { scanSources } from '../store/scanner.js';
import { liveSessions, sessionRegistryRoots } from '../store/liveSessions.js';
import { ambiguousIds, requireUniquePrefix } from '../domain/prefix.js';

/**
 * Sessions a sweep may offer, classified the way the ledger classifies them.
 *
 * The on-disk `_foster` marker dies the first time the app saves a copy, so a
 * scan that does not consult the ledger will offer those copies as if they were
 * new sessions. Every surface — command, menu, agent — has to go through here.
 */
export function listFosterable(
  store: StoreLayout,
  sources: AccountRef[],
  ledger: Ledger,
  filter: SessionFilter = {},
): DiscoveredSession[] {
  return byRecency(applyFilter(scanSources(store, sources, copySessionIds(ledger.read())), filter));
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
