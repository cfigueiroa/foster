import { uniquePrefix } from '../domain/prefix.js';
import { endProcess } from '../engine/desktop.js';
import {
  endableWriter,
  isSelfHostedBy,
  isSelfSession,
  pidAlive,
  type LiveCliSession,
} from '../store/liveSessions.js';
import { readProcesses, type ProcessLister } from '../util/processes.js';

/**
 * Ending the processes that hold conversations open.
 *
 * The only way to release a conversation from outside the session holding it,
 * and the reason it exists: a copy cannot be opened without branching while a
 * writer is there, and "finish in the other window" is not always possible — the
 * window may be one you cannot get back to.
 *
 * It is a kill, and says so. There is no polite signal to send: the CLI has no
 * message loop to close, so ending it is `taskkill /F` and whatever the session
 * had not yet written is gone. What is already in the transcript stays — the file
 * is append-only, and a torn final line is what every tolerant reader here
 * expects.
 *
 * Three things stand between a request and a kill, and they are here rather than
 * in the command so that each can be put to the test on its own:
 *
 *  - one prefix names one conversation, or the request is refused;
 *  - the session foster is running inside is never ended, for the same reason it
 *    refuses to close the app it runs in — the kill would take the command with
 *    it, part-way through, leaving nobody to report what happened;
 *  - the pid must still belong to the process the registry named. Windows
 *    reissues pids, and `taskkill /F /T` against a recycled one takes a
 *    stranger's process tree.
 */

export type StopOutcome =
  /** The session foster is running inside. */
  | 'refused-self'
  /** The pid is not, or cannot be shown to be, the process the record named. */
  | 'refused-unidentified'
  /** A dry run: this is what would be ended. */
  | 'would-end'
  | 'ended'
  /** The kill was asked for and the pid still answers. */
  | 'still-running';

export interface StopResult {
  session: LiveCliSession;
  outcome: StopOutcome;
  /** Why foster would not end it, in the words the refusal has to be given in. */
  reason?: string;
}

export interface StopOptions {
  /** Without this nothing is killed; every endable writer comes back as `would-end`. */
  apply: boolean;
  /** Injected so a test decides what is running, and so nothing spawns PowerShell. */
  processes?: ProcessLister;
  /** Injected so a test never reaches taskkill. */
  end?: (pid: number) => void;
  alive?: (pid: number) => boolean;
  selfPid?: number;
  /** Where the session foster runs in identifies itself. */
  env?: NodeJS.ProcessEnv;
  settleMs?: number;
}

/**
 * The sessions a list of prefixes names, one conversation per prefix.
 *
 * Refused rather than quietly narrowed, the rule every other identifier in
 * foster follows, and the one this command needs most: a prefix that matched
 * several used to end all of them, so a short id typed for the session someone
 * had in mind killed the others silently, and a kill is not an operation anyone
 * gets to take back. Two registry entries for one conversation are one answer,
 * not an ambiguity — both are writers of the same transcript, and releasing it
 * means both.
 */
export function selectWriters(sessions: LiveCliSession[], wanted: string[]): LiveCliSession[] {
  const selected = new Map<string, LiveCliSession>();

  for (const prefix of wanted) {
    const found = uniquePrefix(sessions, prefix, (session) => session.sessionId);
    if (found.kind === 'none') {
      throw new Error(
        `No live session matches ${prefix}.\nRun "foster live" to see what is running.`,
      );
    }
    if (found.kind === 'ambiguous') {
      throw new Error(
        `"${prefix}" is ambiguous: it matches ${found.ids.length} live sessions.\n` +
          found.ids
            .map((id) => `  ${id}  ${sessions.find((s) => s.sessionId === id)?.cwd ?? ''}`)
            .join('\n'),
      );
    }
    for (const session of found.items) selected.set(session.registryFile, session);
  }

  return [...selected.values()];
}

/** What ending each of them did, or why it was not attempted. */
export async function stopWriters(
  sessions: LiveCliSession[],
  options: StopOptions,
): Promise<StopResult[]> {
  const {
    apply,
    processes = readProcesses,
    end = endProcess,
    alive = pidAlive,
    selfPid = process.pid,
    env = process.env,
    settleMs = 3_000,
  } = options;

  // Read once, however many writers there are: the same table answers "which of
  // these is me" and "is this pid still the process the record named".
  const rows = processes();
  const results: StopResult[] = [];

  for (const session of sessions) {
    // Asked both ways round. The environment is exact when the session set it,
    // and the ancestry walk covers a CLI that did not — but only while every
    // process between the two is still alive, which is not something a command
    // launched from a script can count on.
    if (isSelfSession(session, env) || isSelfHostedBy(session.pid, () => rows, selfPid)) {
      results.push({ session, outcome: 'refused-self' });
      continue;
    }

    const endable = endableWriter(session.identity, rows);
    if (!endable.ok) {
      results.push({ session, outcome: 'refused-unidentified', reason: endable.reason });
      continue;
    }

    if (!apply) {
      results.push({ session, outcome: 'would-end' });
      continue;
    }

    end(session.pid);
    // Waited for rather than asked once. `taskkill /F` returns when termination
    // has been requested, not when the process object is gone, so the pid can
    // still answer for a moment afterwards — and reporting a kill that worked as
    // "did not end" sends someone hunting for a window that has already closed.
    // `quitDesktop` waits for the same reason.
    const gone = await settles(() => !alive(session.pid), settleMs);
    results.push({ session, outcome: gone ? 'ended' : 'still-running' });
  }

  return results;
}

/** Polls a condition briefly, for a state change that is requested rather than immediate. */
async function settles(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
