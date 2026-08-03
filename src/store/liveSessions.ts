import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDirectory, safeReaddir } from '../util/fs.js';

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
 * directory, mirroring how transcripts are discovered: `CLAUDE_CONFIG_DIR`, the
 * default `~/.claude`, and any `~/.claude*` sibling a second subscription uses.
 */
export function sessionRegistryRoots(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): string[] {
  const home = homedir();
  const roots = new Set<string>();

  for (const dir of [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), ...extra]) {
    if (dir) roots.add(path.join(dir, 'sessions'));
  }
  for (const entry of safeReaddir(home)) {
    if (!entry.startsWith('.claude')) continue;
    roots.add(path.join(home, entry, 'sessions'));
  }

  return [...roots].filter(isDirectory);
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
