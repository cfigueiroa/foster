import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readProcesses, type ProcessLister } from '../util/processes.js';
import { isDirectory, safeReaddir } from '../util/fs.js';
import { configDirCandidates } from './configDirs.js';

/**
 * The CLI's registry of running sessions.
 *
 * Every live `claude` process registers itself as a JSON file under
 * `<configDir>/sessions/` — pid, session id, working directory — and removes it
 * on exit. A crash leaves the file behind, so an entry only counts when its pid
 * still answers.
 *
 * This is the gate in front of anything that would write to a conversation from
 * outside: a transcript with a live writer must not get a second one, and the
 * registry is the only place that says whether one exists right now.
 */

/** A process holding a conversation open, as a warning needs to describe it. */
export interface LiveWriter {
  pid: number;
  cwd?: string;
  /** True for the session foster itself is running inside. */
  isSelf?: boolean;
}

export interface LiveCliSession {
  /** The registry file the entry came from. */
  registryFile: string;
  pid: number;
  /** The conversation the process is holding open. */
  sessionId: string;
  cwd?: string;
}

/**
 * Every directory that might register live sessions — one per Claude config
 * directory, from the same enumeration transcripts are discovered by:
 * `CLAUDE_CONFIG_DIR`, the default `~/.claude`, and any `~/.claude*` sibling a
 * second subscription uses.
 */
export function sessionRegistryRoots(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): string[] {
  return configDirCandidates(env, extra)
    .map((dir) => path.join(dir, 'sessions'))
    .filter(isDirectory);
}

/** Whether a pid names a process that exists. EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The sessions whose processes are still running.
 *
 * The liveness check is injectable so tests can decide which fixture pids are
 * "alive" without depending on the machine's process table.
 */
export function liveSessions(
  roots: string[],
  alive: (pid: number) => boolean = pidAlive,
): LiveCliSession[] {
  const out: LiveCliSession[] = [];

  for (const root of roots) {
    for (const entry of safeReaddir(root)) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(root, entry);
      const record = readRegistryFile(file);
      if (!record) continue;
      if (!alive(record.pid)) continue;
      out.push({ ...record, registryFile: file });
    }
  }

  return out;
}

/**
 * Whether foster is running inside this session.
 *
 * The registry gives a pid; the question is whether that process is an ancestor
 * of this one. It matters wherever ending a writer is offered: the session foster
 * was started from is the one it must never end, for the same reason it refuses
 * to close the app it runs inside — the kill would take the command with it,
 * part-way through, and the user would be left guessing what ran.
 */
export function isSelfHostedBy(
  pid: number,
  list: ProcessLister = readProcesses,
  selfPid: number = process.pid,
): boolean {
  const rows = list();
  if (rows.length === 0) return false;

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let current = byPid.get(selfPid);
  for (let depth = 0; current && depth < 64; depth++) {
    if (current.pid === pid) return true;
    const parent = byPid.get(current.parentPid);
    // A recycled pid can point at a process younger than its supposed child.
    if (parent && current.startedAt !== undefined && parent.startedAt !== undefined) {
      if (parent.startedAt > current.startedAt) return false;
    }
    current = parent;
  }
  return false;
}

/**
 * The writers behind a set of conversations, described for a warning.
 *
 * Shared by the command and the menu so the same fostering is reported the same
 * way in both, and so "which of these is me" is answered once — the process table
 * is read a single time however many writers there are.
 */
export function describeWriters(
  cliSessionIds: string[],
  roots: string[],
  list: ProcessLister = readProcesses,
  alive: (pid: number) => boolean = pidAlive,
): LiveWriter[] {
  const wanted = new Set(cliSessionIds.map((id) => id.toLowerCase()));
  const sessions = liveSessions(roots, alive).filter((s) => wanted.has(s.sessionId.toLowerCase()));
  if (sessions.length === 0) return [];

  const rows = list();
  return sessions.map((session) => ({
    pid: session.pid,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(isSelfHostedBy(session.pid, () => rows) ? { isSelf: true as const } : {}),
  }));
}

/** The live process holding this conversation open, if any. */
export function liveSessionFor(
  cliSessionId: string,
  roots: string[],
  alive: (pid: number) => boolean = pidAlive,
): LiveCliSession | undefined {
  const wanted = cliSessionId.toLowerCase();
  return liveSessions(roots, alive).find((session) => session.sessionId.toLowerCase() === wanted);
}

function readRegistryFile(file: string): Omit<LiveCliSession, 'registryFile'> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pid = parsed.pid;
    const sessionId = parsed.sessionId;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    return {
      pid,
      sessionId,
      ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
    };
  } catch {
    // A torn or foreign file is not a live session.
    return undefined;
  }
}
