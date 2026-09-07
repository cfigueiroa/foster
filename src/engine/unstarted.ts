import type { CodeSessionData, DiscoveredSession } from '../domain/types.js';

/**
 * Requests that never got a turn.
 *
 * A background-task chip is a request the app spawns into a session of its own.
 * When that session dies before answering once — a quota limit, a disabled
 * subscription — the chip leaves a card behind that looks like every other card
 * in the sidebar, and the request inside it is simply gone. There is no
 * conversation to resume, so `rescue` is the wrong instrument: what is
 * recoverable is the prompt, and the only place it survives is the first user
 * record of the transcript.
 *
 * Measured across a live store of 9,293 session files on 05/09/2026: 1,664
 * chips, of which **12** had an error and no completed turn, 11 of them a quota
 * limit. Small, and invisible without looking — one of the twelve surfaced only
 * because its owner sent a screenshot of the sidebar and asked why a row was
 * not there.
 *
 * What this does NOT do is re-run them. Of those twelve, several were weeks old
 * and named work long since finished by other means; relaunching on a timer
 * would spend quota redoing dead requests and risk duplicating work already
 * done. The list is the product, and the decision stays with the reader.
 */

/** A request whose session died before it answered once. */
export interface UnstartedRequest {
  cliSessionId: string;
  title?: string;
  /** The directory the chip was spawned into, from the card. */
  cwd?: string;
  /** What the app recorded as the reason it stopped. */
  error?: string;
  /** When the card was created, which for these is also when it died. */
  createdAt?: number;
  /**
   * How long it lasted, in milliseconds.
   *
   * Worth its own field because it is the tell. These die in seconds: the
   * shortest of the twelve measured lasted 12 s, and a chip that ran for an
   * hour before erroring did work worth resuming rather than re-asking.
   */
  lifetimeMs?: number;
  /** The words that started it, when the transcript still has them. */
  prompt?: string;
  isArchived: boolean;
  /** The session that spawned the chip, for the reader who wants the context. */
  parentTitle?: string;
}

export interface UnstartedSelection {
  /** Only requests created at or after this instant. */
  since?: number;
  /** Archived cards were closed on purpose; listing one is opt-in. */
  includeArchived: boolean;
}

/** The seam tests replace: what the transcripts say. */
export interface UnstartedDeps {
  transcriptFor(cliSessionId: string): string | undefined;
  promptIn(file: string): string | undefined;
}

/**
 * Whether a card is a request that never started.
 *
 * All three marks are required, and each one excludes a case that looks similar
 * and is not:
 *
 * - `spawnedFrom` keeps this to chips. A session a person opened and abandoned
 *   is not a lost request; they can see it, and they closed it.
 * - `error` keeps it to sessions that were stopped. A chip sitting at zero turns
 *   with no error is one that has not started *yet*, and listing a running
 *   request as lost would be a false alarm every time.
 * - zero completed turns is what makes the prompt the whole of the loss. One
 *   completed turn means there is an answer on disk, which is `rescue`'s
 *   business and not this one.
 */
export function isUnstarted(data: CodeSessionData): boolean {
  if (!data.spawnedFrom) return false;
  if (!data.error) return false;
  return (data.completedTurns ?? 0) === 0;
}

export function findUnstarted(
  sessions: DiscoveredSession[],
  selection: UnstartedSelection,
  deps: UnstartedDeps,
): UnstartedRequest[] {
  // One row per conversation. A store that has been swept holds the same chip
  // in the account it came from and in the account it was copied to, and a
  // reader offered the same lost request twice has to work out for themselves
  // that it is one request.
  const seen = new Map<string, UnstartedRequest>();

  for (const { data } of sessions) {
    if (!isUnstarted(data)) continue;
    if (data.isArchived === true && !selection.includeArchived) continue;
    const conversation = data.cliSessionId?.toLowerCase();
    if (!conversation) continue;
    if (selection.since !== undefined) {
      // Judged on when it was created, not on last activity. For a session that
      // died in seconds the two are the same instant, and `createdAt` is the one
      // that survives the app rewriting its own bookkeeping on a click.
      const at = data.createdAt;
      if (at === undefined || at < selection.since) continue;
    }
    // Not what makes the row unique — the map does that on its own. What this
    // saves is the read: recovering a prompt opens a transcript, and a swept
    // store holds the same chip in two accounts, so without it every lost
    // request is read from disk twice to produce the one row it already had.
    if (seen.has(conversation)) continue;

    const file = deps.transcriptFor(conversation);
    seen.set(conversation, {
      cliSessionId: conversation,
      title: data.title,
      cwd: data.cwd,
      error: data.error,
      createdAt: data.createdAt,
      lifetimeMs:
        data.lastActivityAt !== undefined && data.createdAt !== undefined
          ? data.lastActivityAt - data.createdAt
          : undefined,
      // Absent when the transcript is gone, which is the one case where nothing
      // at all is recoverable. Said by omission rather than by an empty string,
      // so a caller can tell "no prompt on disk" from "the prompt was blank".
      prompt: file ? deps.promptIn(file) : undefined,
      isArchived: data.isArchived === true,
      parentTitle: data.spawnedFrom?.title,
    });
  }

  // Newest first: a request from this morning is worth re-asking and one from
  // August usually is not, and sorting says so without a rule that guesses.
  return [...seen.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
