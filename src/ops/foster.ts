import { applyFilter, byRecency, selectByIds, type SessionFilter } from '../domain/filter.js';
import type { AccountRef, DiscoveredSession, StoreLayout, Unfosterable } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds } from '../ledger/project.js';
import { scanSources } from '../store/scanner.js';
import { liveSessions, sessionRegistryRoots } from '../store/liveSessions.js';
import { ambiguousIds, requireUniquePrefix } from '../domain/prefix.js';
import { describeUnfosterable } from '../domain/fostering.js';
import { transcriptBytes, transcriptRoots } from '../store/transcripts.js';

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

/**
 * Fills in `transcriptBytes` for the sessions held back as never opened.
 *
 * Reporting one of these as simply unreachable is how real work goes quietly
 * missing: `never-opened` is decided by a missing focus time alone, which a
 * record nobody ever opened and a conversation that ran its whole life outside
 * the app both satisfy. Measuring is what tells them apart, and it is done only
 * for those sessions because answering means indexing the transcript trees.
 */
export function measureNeverOpened(
  sessions: DiscoveredSession[],
  env: NodeJS.ProcessEnv = process.env,
  configDirs: string[] = [],
): DiscoveredSession[] {
  const wanted = new Map<string, string>();
  for (const session of sessions) {
    if (!session.reasons.includes('never-opened')) continue;
    const id = session.data.cliSessionId;
    if (id) wanted.set(session.data.sessionId, id);
  }
  if (wanted.size === 0) return sessions;

  const bytes = transcriptBytes(new Set(wanted.values()), transcriptRoots(env, configDirs));
  return sessions.map((session) => {
    const id = wanted.get(session.data.sessionId);
    if (id === undefined) return session;
    return { ...session, transcriptBytes: bytes.get(id) ?? 0 };
  });
}

/**
 * Narrows to the ids named, and says why when one of them is not on offer.
 *
 * `rejected` is the same scan without the fosterable filter. Without it an id
 * that names a real session held back by its reasons was reported as matching
 * nothing, under advice to go and look at a list the session appears in — which
 * reads as a typo and sends the reader to check an id that was right all along.
 */
export function selectFosterSessions(
  candidates: DiscoveredSession[],
  sessionIds: string[],
  rejected: DiscoveredSession[] = [],
): DiscoveredSession[] {
  const { selected, unmatched } = selectByIds(candidates, sessionIds);
  if (unmatched.length > 0) {
    throw new Error(unmatchedMessage(unmatched, rejected));
  }
  return byRecency(selected);
}

/** What each flag makes fosterable, for the ids that named a held-back session. */
const OFFERED_BY: Partial<Record<Unfosterable, string>> = {
  'scheduled-task': '--include-scheduled',
  'spawned-task': '--include-spawned',
  archived: '--archived',
};

function unmatchedMessage(unmatched: string[], rejected: DiscoveredSession[]): string {
  const lines: string[] = [];
  const missing: string[] = [];

  for (const id of unmatched) {
    const { selected } = selectByIds(rejected, [id]);
    const found = selected[0];
    if (!found) {
      missing.push(id);
      continue;
    }
    const why = found.reasons.map((reason) => describeUnfosterable(reason)).join(', ');
    const flags = [...new Set(found.reasons.flatMap((r) => OFFERED_BY[r] ?? []))];
    // Phrased so the reason reads the same whether there is one or several, and
    // whether it takes an article or not: "is archived" and "is background task"
    // cannot both follow the same verb.
    lines.push(
      `${id} is not offered: ${why}.` +
        (flags.length > 0 ? ` Add ${flags.join(' ')} to include it.` : ''),
    );
  }

  if (missing.length > 0) {
    lines.unshift(`No session matches ${missing.join(', ')}.`);
  }
  return lines.join('\n');
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
