import { bareSessionId } from './naming.js';
import type { DiscoveredSession, Unfosterable } from './types.js';

export interface SessionFilter {
  /** Case-insensitive substring match against the title. */
  title?: string;
  /** Case-insensitive substring match against the working directory. */
  cwd?: string;
  /** Only sessions active on or after this instant. */
  since?: number;
  /** Include sessions that cannot be fostered (scheduled tasks, never opened). */
  includeUnfosterable?: boolean;
  /**
   * Treat an archived session as fosterable.
   *
   * Archiving is not the same kind of exclusion as the others. A scheduled task
   * or a never-opened session has no place in the sidebar at all, so a copy of
   * one would be a file the app silently never lists. An archived session has a
   * place — the app's own archived view — and the user put it there on purpose.
   * Refusing it by default keeps a sweep from dragging back what was tucked
   * away; refusing it always makes a conversation whose only card is archived
   * unreachable from any other account.
   */
  includeArchived?: boolean;
}

/** The reasons that still stand once the caller has said what it will accept. */
export function blockingReasons(session: DiscoveredSession, filter: SessionFilter): Unfosterable[] {
  return filter.includeArchived
    ? session.reasons.filter((reason) => reason !== 'archived')
    : session.reasons;
}

/**
 * Narrows to named items by identifier prefix.
 *
 * Identifiers may be given bare or with the app's `local_` prefix, and abbreviated
 * to any unique prefix. An id that matches nothing is reported rather than an
 * empty result: a typo and "that session is gone" look identical otherwise.
 *
 * `matchOn` is what the typed id is compared to. `identity` is how a hit is
 * de-duplicated when two arguments name the same row — for sessions that is the
 * same field; for fostered copies the match is the origin and the identity is
 * the copy, because one origin can have a copy in two accounts.
 */
export function selectByKey<T>(
  items: T[],
  ids: string[],
  matchOn: (item: T) => string,
  identity: (item: T) => string = matchOn,
): { selected: T[]; unmatched: string[] } {
  const selected = new Map<string, T>();
  const unmatched: string[] = [];

  for (const id of ids) {
    const needle = bareSessionId(id).toLowerCase();
    const matches = items.filter((item) =>
      bareSessionId(matchOn(item)).toLowerCase().startsWith(needle),
    );
    if (matches.length === 0) {
      unmatched.push(id);
      continue;
    }
    for (const match of matches) selected.set(identity(match), match);
  }

  return { selected: [...selected.values()], unmatched };
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
  return selectByKey(sessions, ids, (session) => session.data.sessionId);
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
    // A copy is not a source while its conversation still has a card of its own.
    // When it is the last one left, it is the only way that conversation can
    // reach another account at all.
    if (session.isCopy && !session.isStranded) return false;
    if (!filter.includeUnfosterable && blockingReasons(session, filter).length > 0) return false;

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
