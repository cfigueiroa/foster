import { existsSync } from 'node:fs';
import type { DiscoveredSession } from '../domain/types.js';
import { liveConversationIds } from '../ops/foster.js';
import {
  fileOpenedFrom,
  indexAllTranscripts,
  lastAnswer,
  transcriptRoots,
  type LastAnswer,
} from '../store/transcripts.js';

/**
 * Sessions a usage limit stopped — or that were cut off mid-turn — and that the
 * account they now sit in can carry on.
 *
 * The sweep moves every conversation into the account signed in now, and the
 * ones that were working when their old account ran out arrive exactly where
 * they stopped: mid-task, ending on the app's own "You've hit your limit" line,
 * waiting for a turn nobody is going to give them. Reviving them is one message
 * each — the quota is back, carry on — and that message can only be delivered
 * from inside Claude Desktop, with the app's own session tools: a headless
 * `claude --resume` runs the turn but never reattaches the card, and the row
 * would go on showing the stop.
 *
 * So this half only answers "which ones": the work list the `/retoma` skill
 * reads and delivers to. Nothing here writes anything.
 */

/** One session to revive: the row to message, and what stopped it. */
export interface StoppedSession {
  /** The card's own id — what a message is addressed to. */
  sessionId: string;
  cliSessionId: string;
  title?: string;
  cwd?: string;
  branch?: string;
  /**
   * What stopped it: `limit`, the app's own usage-limit record; `cut-off`, a
   * turn that never closed — the app quit, restarted or switched account under it.
   */
  why: 'limit' | 'cut-off';
  /** When it stopped: the stopping record's own time. */
  stoppedAt: number;
  /** The app's sentence for it — "You've hit your weekly limit · resets …". */
  limit?: string;
}

/** A card that was looked at and left out, and why — so a gap is never silent. */
export interface PassedOver {
  sessionId: string;
  title?: string;
  reason: 'live' | 'same-conversation' | 'same-branch' | 'no-folder';
  /** The row kept in its place, for the two duplicate reasons. */
  keptSessionId?: string;
  /** The working directory that is not on disk, for `no-folder`. */
  cwd?: string;
}

export interface ReviveSelection {
  /** Only limits hit at or after this instant. */
  since: number;
  /** Archived sessions were put away on purpose; reviving one is opt-in. */
  includeArchived: boolean;
}

/** The seams tests replace: what is live, and what the transcripts say. */
export interface ReviveDeps {
  /** Every file a conversation occupies. */
  filesOf(cliSessionId: string): readonly string[];
  lastAnswer(file: string): LastAnswer | undefined;
  /** Lowercased conversation ids that have a live writer right now. */
  liveIds: ReadonlySet<string>;
  /**
   * Whether a card's working directory is on disk. The app refuses to deliver a
   * message to a session whose folder is gone, so a row there is named rather than
   * listed. Left out, every folder counts as there.
   */
  folderExists?(dir: string): boolean;
}

export function defaultReviveDeps(env: NodeJS.ProcessEnv = process.env): ReviveDeps {
  const index = indexAllTranscripts(transcriptRoots(env));
  const lower = new Map<string, string[]>();
  for (const [id, files] of index) lower.set(id.toLowerCase(), files);
  return {
    filesOf: (id) => lower.get(id.toLowerCase()) ?? [],
    lastAnswer,
    liveIds: liveConversationIds(env),
    folderExists: existsSync,
  };
}

/** The error kind the app writes on the record that ends a conversation at its limit. */
export const USAGE_LIMIT = 'rate_limit';

export function findStopped(
  sessions: DiscoveredSession[],
  selection: ReviveSelection,
  deps: ReviveDeps,
): { stopped: StoppedSession[]; passedOver: PassedOver[] } {
  const found: { session: DiscoveredSession; row: StoppedSession }[] = [];
  const passedOver: PassedOver[] = [];

  for (const session of sessions) {
    const { data } = session;
    const cliSessionId = data.cliSessionId;
    if (!cliSessionId) continue;
    if (!selection.includeArchived && data.isArchived === true) continue;
    // A schedule runs again on its own, and a task nobody opened has no row to
    // carry on in; neither is waiting on a message.
    if (session.reasons.includes('scheduled-task') || session.reasons.includes('spawned-task')) {
      continue;
    }

    const answer = answerOpenedBy(cliSessionId, data.cwd, deps);
    if (answer === undefined || answer.at < selection.since) continue;
    const why = answer.error === USAGE_LIMIT ? 'limit' : answer.cutOff ? 'cut-off' : undefined;
    if (why === undefined) continue;

    // Something is writing it right now: whatever stopped it, it is not stopped.
    if (deps.liveIds.has(cliSessionId.toLowerCase())) {
      passedOver.push(skipped(session, 'live'));
      continue;
    }
    // Measured 26/09/2026: four copies opened in a folder since moved, and the app
    // answered each message with "The project folder … no longer exists".
    if (data.cwd && deps.folderExists && !deps.folderExists(data.cwd)) {
      passedOver.push({ ...skipped(session, 'no-folder'), cwd: data.cwd });
      continue;
    }

    found.push({
      session,
      row: {
        sessionId: data.sessionId,
        cliSessionId,
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.cwd !== undefined ? { cwd: data.cwd } : {}),
        ...(data.branch ? { branch: data.branch } : {}),
        why,
        stoppedAt: answer.at,
        ...(answer.text !== undefined ? { limit: answer.text } : {}),
      },
    });
  }

  // Most recent stop first, so the row each duplicate check keeps is the one
  // the work was last going on in.
  found.sort((a, b) => b.row.stoppedAt - a.row.stoppedAt);

  const stopped: StoppedSession[] = [];
  const byConversation = new Map<string, string>();
  const byBranch = new Map<string, string>();
  for (const { session, row } of found) {
    // Two rows for one conversation — a copy and the card it was made from, or
    // one file per working directory — would be two agents resuming the same
    // work. One message is enough.
    const conversation = row.cliSessionId.toLowerCase();
    const sameConversation = byConversation.get(conversation);
    if (sameConversation !== undefined) {
      passedOver.push(skipped(session, 'same-conversation', sameConversation));
      continue;
    }
    // Two conversations on one git branch in one repository would commit over
    // each other. Keeping the fresher one is the same rule the sweep applies to
    // branches: the work was last going on there.
    const branch = branchKey(session);
    const sameBranch = branch === undefined ? undefined : byBranch.get(branch);
    if (sameBranch !== undefined) {
      passedOver.push(skipped(session, 'same-branch', sameBranch));
      continue;
    }

    byConversation.set(conversation, row.sessionId);
    if (branch !== undefined) byBranch.set(branch, row.sessionId);
    stopped.push(row);
  }

  return { stopped, passedOver };
}

/**
 * The last answer in the file this card opens.
 *
 * A conversation can occupy one file per working directory, and a card opens
 * only the one its own `cwd` encodes to — the one whose ending is the ending
 * this row shows. When that cannot be told, the file whose last answer is the
 * latest stands in: it is where the work was last going on.
 */
function answerOpenedBy(
  cliSessionId: string,
  cwd: string | undefined,
  deps: ReviveDeps,
): LastAnswer | undefined {
  const files = deps.filesOf(cliSessionId);
  if (files.length === 0) return undefined;
  const opened = files.length === 1 ? files[0] : fileOpenedFrom(files, cwd);
  if (opened !== undefined) return deps.lastAnswer(opened);

  let latest: LastAnswer | undefined;
  for (const file of files) {
    const answer = deps.lastAnswer(file);
    if (answer && (!latest || answer.at > latest.at)) latest = answer;
  }
  return latest;
}

/** Repository and branch, when the card names a branch; case folded, as paths are here. */
function branchKey(session: DiscoveredSession): string | undefined {
  const { branch, originCwd, cwd } = session.data;
  const repository = originCwd ?? cwd;
  if (!branch || !repository) return undefined;
  return `${repository.toLowerCase()}\n${branch}`;
}

function skipped(
  session: DiscoveredSession,
  reason: PassedOver['reason'],
  keptSessionId?: string,
): PassedOver {
  return {
    sessionId: session.data.sessionId,
    ...(session.data.title !== undefined ? { title: session.data.title } : {}),
    reason,
    ...(keptSessionId !== undefined ? { keptSessionId } : {}),
  };
}
