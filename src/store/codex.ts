import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * Codex CLI rollouts — the discovery half of issue #19's first slice.
 *
 * A Codex conversation lives as a `.jsonl` rollout under `~/.codex/sessions/`,
 * one file per thread, filed by date (`sessions/<year>/<month>/<day>/`).
 * `tongtongtju/sessionbridge` also reads `~/.codex/state_5.sqlite`, a `better-
 * sqlite3` index of the same rollouts — but foster ships as one dependency-free
 * bundle (`commander` and `picocolors`, nothing native), and the index is not
 * load-bearing: `session_meta`, the first line of every rollout, already carries
 * `id`, `cwd`, `originator`, `cli_version`, `source` and the git block, and the
 * file's own mtime orders the list the sqlite `updated_at` column would have.
 * A sqlite path can be added later behind a capability check, purely to make
 * `--list` nicer (`title`, `preview`, `archived`, `is_pinned` live there and
 * nowhere else) — nothing here depends on it existing.
 */

export function codexHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CODEX_HOME ?? path.join(home, '.codex');
}

export function codexSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return path.join(codexHome(env, home), 'sessions');
}

/**
 * Every rollout file under the sessions directory.
 *
 * A single `readdir` is not enough — Codex files rollouts three directories
 * deep, by date — so this walks. Depth is not bounded: nothing here assumes
 * the date-sharding stays three levels, only that a `.jsonl` file is a rollout
 * wherever it turns up.
 */
export function findRollouts(sessionsDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry);
      if (isDirectory(full)) {
        walk(full);
      } else if (entry.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  };
  walk(sessionsDir);
  return found;
}

/**
 * How much of a rollout to read at a time when looking only for its
 * `session_meta` line, and how far to go before giving up.
 *
 * The first line is not small. `session_meta` carries `base_instructions` —
 * Codex's whole system prompt — so measured over 200 real rollouts it ran to a
 * median of 19,278 bytes and a maximum of 43,111, and only 13 of the 200 fitted
 * in the 16 KB this once budgeted. That was not a rounding error: `firstLineOf`
 * refuses a truncated line rather than parse half a record, so the corpus came
 * back unreadable — 1,484 of 1,498 rollouts on the store this was first run
 * against, with the tool honestly reporting every one of them as such.
 *
 * So it grows rather than guesses: one chunk, then doubling, until the newline
 * turns up or the ceiling does. The ceiling keeps the original promise — a
 * rollout can run to hundreds of megabytes, and nothing past its first line is
 * discovery's business.
 */
const META_CHUNK_BYTES = 64 * 1024;
const META_MAX_BYTES = 4 * 1024 * 1024;

/** The facts `session_meta` carries, plus the one fact only the filesystem has. */
export interface CodexRolloutMeta {
  file: string;
  id: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  source?: string;
  gitBranch?: string;
  /** When the thread started, as `session_meta` itself recorded it. */
  startedAt?: string;
  /** The file's own mtime — orders the list the way sqlite's `updated_at` would. */
  mtimeMs: number;
}

/**
 * Read a rollout's `session_meta` line without parsing the rest of the file.
 *
 * Discovery only reads this — a bounded prefix, not the whole rollout — so
 * listing a corpus of thousands of files stays cheap even though some of them
 * run to hundreds of megabytes. `undefined` when the file is unreadable, empty,
 * or its first line is not a `session_meta` record: every rollout is supposed
 * to open with one, and a file that does not is not safe to guess about.
 */
export function readRolloutMeta(file: string): CodexRolloutMeta | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }

  const line = firstLineOf(file);
  if (line === undefined) return undefined;

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (record.type !== 'session_meta') return undefined;

  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const fields = payload as Record<string, unknown>;
  if (typeof fields.id !== 'string' || fields.id === '') return undefined;

  const git = fields.git;
  const gitBranch =
    typeof git === 'object' &&
    git !== null &&
    typeof (git as Record<string, unknown>).branch === 'string'
      ? ((git as Record<string, unknown>).branch as string)
      : undefined;

  return {
    file,
    id: fields.id,
    ...(typeof fields.cwd === 'string' ? { cwd: fields.cwd } : {}),
    ...(typeof fields.originator === 'string' ? { originator: fields.originator } : {}),
    ...(typeof fields.cli_version === 'string' ? { cliVersion: fields.cli_version } : {}),
    ...(typeof fields.source === 'string' ? { source: fields.source } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    ...(typeof fields.timestamp === 'string' ? { startedAt: fields.timestamp } : {}),
    mtimeMs,
  };
}

/** The rollout's first line, or undefined if it does not fit in the read budget. */
function firstLineOf(file: string, maxBytes = META_MAX_BYTES): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    let budget = Math.min(META_CHUNK_BYTES, maxBytes);
    for (;;) {
      const buffer = Buffer.alloc(budget);
      const read = readSync(fd, buffer, 0, budget, 0);
      const text = buffer.subarray(0, read).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline !== -1) return text.slice(0, newline);
      // No newline yet. If the read came up short the file ended, so this is
      // the only line it has; otherwise there is more to look at, until the
      // ceiling says a file this shaped is not a rollout worth guessing about.
      if (read < budget) return text;
      if (budget >= maxBytes) return undefined;
      budget = Math.min(budget * 2, maxBytes);
    }
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** One raw JSONL record from a rollout, before any of it is interpreted. */
export interface CodexRecord {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * A rollout's records, read in full and parsed.
 *
 * Whole-file, unlike `readRolloutMeta`: turning a rollout into turn and
 * tool-call counts (`codexImport.ts`) needs every record, and there is no
 * cheaper way to get them. Rollouts run tens of KB to low hundreds of MB in
 * practice, not the multi-GB range a streaming reader like
 * `transcripts.ts#streamRecords` earns its complexity for — the corpus this
 * was measured against is 5.5 GB across 1,320 files, averaging ~4 MB each.
 */
export function readRolloutRecords(file: string): CodexRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const records: CodexRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Individual malformed lines are skipped; the rest of the file still counts.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== 'string') continue;
    const payload = record.payload;
    records.push({
      type: record.type,
      ...(typeof payload === 'object' && payload !== null
        ? { payload: payload as Record<string, unknown> }
        : {}),
    });
  }
  return records;
}
