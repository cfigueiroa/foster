import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * The conversation transcripts, which live outside the account tree.
 *
 * A session file is only a pointer: the conversation itself is a JSONL log under
 * ~/.claude/projects, keyed by cliSessionId and account-agnostic. Deleting a
 * session in the app removes the pointer and leaves this behind — which is what
 * makes a deleted session recoverable at all.
 *
 * Nothing here writes. The app's own import rewrites transcripts in place; foster
 * reads them and never touches them.
 */

/** How much of a transcript to read when recovering its facts. */
const HEAD_BYTES = 256 * 1024;

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  return path.join(configDir, 'projects');
}

/**
 * Every directory that might hold transcripts.
 *
 * `CLAUDE_CONFIG_DIR` is how the CLI is pointed at a different account — a second
 * subscription is run by giving it its own config directory — and each of those
 * keeps its own `projects/`. Looking only at the one this process happens to be
 * running under would quietly miss conversations belonging to the others, which
 * for a recovery tool is the worst kind of wrong: a shorter list that looks
 * complete.
 *
 * Siblings are found by inspection, not by naming convention: a directory counts
 * only if it actually contains a `projects/` tree, so an unrelated `.claude-*`
 * folder cannot join in by name alone.
 */
export function transcriptRoots(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): string[] {
  const home = homedir();
  const roots = new Set<string>();

  for (const dir of [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), ...extra]) {
    if (dir) roots.add(path.join(dir, 'projects'));
  }
  for (const entry of safeReaddir(home)) {
    if (!entry.startsWith('.claude')) continue;
    roots.add(path.join(home, entry, 'projects'));
  }

  return [...roots].filter(isDirectory);
}

/**
 * Every transcript on disk, keyed by the session id that points at it.
 *
 * Built by listing directories only — no transcript is opened. The directory name
 * encodes the working directory, but lossily (both separators and hyphens become
 * dashes), so the cwd is read from the file itself rather than decoded from the
 * path.
 */
export function indexTranscripts(projectsDirs: string | string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const projectsDir of typeof projectsDirs === 'string' ? [projectsDirs] : projectsDirs) {
    for (const project of safeReaddir(projectsDir)) {
      const dir = path.join(projectsDir, project);
      if (!isDirectory(dir)) continue;

      for (const entry of safeReaddir(dir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const id = entry.slice(0, -'.jsonl'.length);
        // First one wins: the same conversation can be mirrored under a second
        // project directory, and either copy opens the same session.
        if (!index.has(id)) index.set(id, path.join(dir, entry));
      }
    }
  }

  return index;
}

export interface TranscriptFacts {
  path: string;
  cliSessionId: string;
  cwd?: string;
  /** The title Claude gave the conversation, when it got far enough to have one. */
  title?: string;
  createdAt?: number;
  /** Last write to the transcript — a better answer than the last line, and free. */
  lastActivityAt?: number;
}

export function readTranscriptFacts(file: string, cliSessionId: string): TranscriptFacts {
  const facts: TranscriptFacts = { path: file, cliSessionId };

  try {
    facts.lastActivityAt = statSync(file).mtimeMs;
  } catch {
    // A transcript that vanished between listing and reading is simply skipped.
    return facts;
  }

  for (const record of headRecords(file)) {
    if (facts.title === undefined && typeof record.aiTitle === 'string') {
      facts.title = record.aiTitle;
    }
    if (facts.cwd === undefined && typeof record.cwd === 'string') facts.cwd = record.cwd;
    if (facts.createdAt === undefined && typeof record.timestamp === 'string') {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) facts.createdAt = at;
    }
    if (facts.title !== undefined && facts.cwd !== undefined && facts.createdAt !== undefined) {
      break;
    }
  }

  return facts;
}

/**
 * The first records of a transcript.
 *
 * Only the head is read: these files reach hundreds of megabytes, the facts worth
 * recovering are written near the start, and a restore that had to read every
 * conversation in full would be unusable.
 */
function headRecords(file: string): Record<string, unknown>[] {
  let buffer: Buffer;
  let complete: boolean;

  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    buffer = buffer.subarray(0, read);
    complete = read < HEAD_BYTES;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }

  const lines = buffer.toString('utf8').split('\n');
  // The last line of a truncated read is a fragment, not a record.
  if (!complete) lines.pop();

  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Individual malformed lines are skipped; the rest of the file still counts.
    }
  }
  return records;
}
