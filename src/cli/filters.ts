import { bareSessionId } from '../domain/naming.js';
import type { DiscoveredSession } from '../domain/types.js';

export interface SessionFilter {
  /** Case-insensitive substring match against the title. */
  title?: string;
  /** Case-insensitive substring match against the working directory. */
  cwd?: string;
  /** Only sessions active on or after this instant. */
  since?: number;
  /** Include sessions that cannot be fostered (scheduled tasks, never opened). */
  includeUnfosterable?: boolean;
}

/**
 * Narrows to named sessions, refusing rather than guessing.
 *
 * Identifiers may be given bare or with the app's `local_` prefix, and abbreviated
 * to any unique prefix. An id that matches nothing is an error rather than an
 * empty result: a typo and "that session is gone" look identical otherwise, and
 * only one of them means the user should stop and look.
 */
export function selectByIds(
  sessions: DiscoveredSession[],
  ids: string[],
): { selected: DiscoveredSession[]; unmatched: string[] } {
  const selected = new Map<string, DiscoveredSession>();
  const unmatched: string[] = [];

  for (const id of ids) {
    const needle = bareSessionId(id).toLowerCase();
    const matches = sessions.filter((session) =>
      bareSessionId(session.data.sessionId).toLowerCase().startsWith(needle),
    );
    if (matches.length === 0) {
      unmatched.push(id);
      continue;
    }
    for (const match of matches) selected.set(match.data.sessionId, match);
  }

  return { selected: [...selected.values()], unmatched };
}

/**
 * Selection is filter-first rather than a checkbox list: with a few hundred
 * sessions, picking them one by one is unusable. The user narrows, sees the
 * count, and confirms the batch.
 */
export function applyFilter(
  sessions: DiscoveredSession[],
  filter: SessionFilter,
): DiscoveredSession[] {
  return sessions.filter((session) => {
    if (session.isCopy) return false;
    if (!filter.includeUnfosterable && session.reasons.length > 0) return false;

    if (filter.title) {
      const title = session.data.title ?? '';
      if (!title.toLowerCase().includes(filter.title.toLowerCase())) return false;
    }

    if (filter.cwd) {
      const cwd = session.data.cwd ?? '';
      if (!cwd.toLowerCase().includes(filter.cwd.toLowerCase())) return false;
    }

    if (filter.since !== undefined && activityOf(session) < filter.since) return false;

    return true;
  });
}

/** Most recently active first — what the user is most likely looking for. */
export function byRecency(sessions: DiscoveredSession[]): DiscoveredSession[] {
  return [...sessions].sort((a, b) => activityOf(b) - activityOf(a));
}

/**
 * When a session was last touched.
 *
 * Shared by the filter and the ordering on purpose: they disagreed before, with
 * only the ordering considering lastFocusedAt. A session opened yesterday but
 * with no recorded activity sorted to the top of the list and was then excluded
 * by --since, which is a confusing thing for one command to do.
 */
export function activityOf(session: DiscoveredSession): number {
  return session.data.lastActivityAt ?? session.data.lastFocusedAt ?? session.data.createdAt ?? 0;
}

/** Parses a relative age such as "30d" or "12h" into an absolute cutoff. */
export function parseSince(value: string, now: number = Date.now()): number | undefined {
  const match = /^(\d+)\s*([dhw])$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const hour = 3_600_000;
  const scale = unit === 'h' ? hour : unit === 'd' ? 24 * hour : 7 * 24 * hour;
  return now - amount * scale;
}
