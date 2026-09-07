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
  /**
   * Bring a scheduled task's conversation across as an ordinary one.
   *
   * The exclusion is real but narrower than it looks: what the app refuses to
   * list under Recents is a *card* carrying `scheduledTaskId`, not the
   * conversation behind it, and the transcript is an ordinary transcript. So the
   * copy arrives with that field dropped — see buildFosterCopy — and shows up
   * like any other row.
   *
   * Off by default, because the copy is not the task. The schedule, its trigger
   * and its history stay in the account that owns them, and nothing here runs
   * again; what crosses is the reading of what it did. That is a different thing
   * from what the row said in its own account, so it is asked for rather than
   * swept up.
   */
  includeScheduled?: boolean;
  /**
   * Bring across a conversation the app spawned from a background-task chip.
   *
   * Running unattended is the point of one, exactly as it is for a schedule, so
   * the copy is given a focus time and the link back to the chip is dropped —
   * see buildFosterCopy. What crosses is the reading of what it did.
   *
   * Off by default for the same reason `--include-scheduled` is: these never had
   * a row anywhere, so bringing them in is a decision to make rather than a gap
   * to close. It is worth making, though, and the flag exists because the
   * alternative was reconstructing the record by hand: a spawned session can
   * carry a full piece of work and nothing in the sidebar will ever mention it.
   */
  includeSpawned?: boolean;
}

/** The reasons that still stand once the caller has said what it will accept. */
export function blockingReasons(session: DiscoveredSession, filter: SessionFilter): Unfosterable[] {
  const excused = new Set<Unfosterable>();
  if (filter.includeArchived) excused.add('archived');
  if (filter.includeScheduled && session.reasons.includes('scheduled-task')) {
    excused.add('scheduled-task');
    // Only alongside the one above, never on its own. A scheduled task that was
    // never opened is the ordinary case — running unattended is the point of one
    // — and the copy is given a focus time of its own so it lands in Recents. A
    // session that was merely never opened is a different matter and stays out:
    // this flag is about scheduled tasks, not about that.
    excused.add('never-opened');
  }
  if (filter.includeSpawned && session.reasons.includes('spawned-task')) {
    excused.add('spawned-task');
    // Alongside the one above and never on its own, on the same reasoning: a
    // session the app spawned was never focused because nobody was there to
    // focus it. A session that was merely never opened stays out.
    excused.add('never-opened');
  }
  return excused.size === 0
    ? session.reasons
    : session.reasons.filter((reason) => !excused.has(reason));
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
 * What `applyFilter` needs to ask before refusing a copy whose conversation
 * still has a card of its own elsewhere — the same question #69 taught
 * `resolveExisting` to ask instead of trusting identity alone.
 *
 * Shaped to match `engine/sidebar.ts`'s `Sidebar` rather than importing it: this
 * module is domain-layer data-shaping, and a `Lineage`-backed answer is
 * necessarily built from reading transcripts, which stays the caller's job.
 */
export interface ReachCheck {
  unreached(cliSessionId: string | undefined, cwd: string | undefined): number;
}

/**
 * Selection is filter-first rather than a checkbox list: with a few hundred
 * sessions, picking them one by one is unusable. The user narrows, sees the
 * count, and confirms the batch.
 *
 * `here` is optional so every caller that has not been taught to measure reach
 * keeps the old answer for a copy: refused unless it is the last card left.
 */
export function applyFilter(
  sessions: DiscoveredSession[],
  filter: SessionFilter,
  here?: ReachCheck,
): DiscoveredSession[] {
  return sessions.filter((session) => {
    // A copy is not a source while its conversation still has a card of its own
    // — unless the copy carried on somewhere that card cannot reach (#49). "Is
    // this the last one left?" missed exactly that: a copy fostered while its
    // origin still existed, then continued in a working directory the origin
    // never named, held records nothing else could reach and was never offered
    // back. Asking what it reaches beyond `here` catches that case without
    // reopening the ordinary one — ordinary copies answer zero and stay refused.
    const copyWithCard = session.isCopy && !session.isStranded;
    if (copyWithCard) {
      const beyond = here?.unreached(session.data.cliSessionId, session.data.cwd) ?? 0;
      if (beyond === 0) return false;
    }

    // `unfosterableReasons` marks every copy `already-a-copy`, and `markStranded`
    // already lifts that mark for the one case it used to recognise — the last
    // card left. A copy passing only because of `beyond` above needs the same
    // lift here, or this check would refuse right back what the one above just
    // let through.
    const blocking = blockingReasons(session, filter).filter(
      (reason) => reason !== 'already-a-copy' || !copyWithCard,
    );
    if (!filter.includeUnfosterable && blocking.length > 0) return false;

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
