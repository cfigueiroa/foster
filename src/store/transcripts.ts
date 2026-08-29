import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { samePath } from '../domain/paths.js';
import { isDirectory, safeReaddir } from '../util/fs.js';
import { configDirCandidates } from './configDirs.js';

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

/**
 * How much to read to find the record a conversation starts from.
 *
 * Far less than the facts need: the answer is the first record carrying a `uuid`,
 * which is the first thing said. The budget is for the records in front of it —
 * a title, a mode, a queued prompt — none of which are large, and for the one
 * case that is, a first message someone pasted a file into.
 */
const ROOT_BYTES = 64 * 1024;

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
 * The candidates come from the shared enumeration; the check kept here is the
 * question transcripts ask of one. Siblings join by inspection, not by naming
 * convention: a directory counts only if it actually contains a `projects/`
 * tree, so an unrelated `.claude-*` folder cannot join in by name alone.
 */
export function transcriptRoots(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): string[] {
  return configDirCandidates(env, extra)
    .map((dir) => path.join(dir, 'projects'))
    .filter(isDirectory);
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
  // First one wins: the same conversation can be mirrored under a second project
  // directory, and either copy opens the same session.
  return new Map(
    [...indexAllTranscripts(projectsDirs)].map(([id, files]) => [id, files[0]!] as const),
  );
}

/**
 * Every path a conversation occupies, rather than the first one that answers.
 *
 * Reading needs one copy and does not care which. Destroying one is the opposite
 * question: a mirrored copy left behind is a conversation still on disk after
 * being reported as gone, which — for the one command whose whole promise is
 * that it cannot be undone — is the failure that matters most.
 */
export function indexAllTranscripts(projectsDirs: string | string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const projectsDir of typeof projectsDirs === 'string' ? [projectsDirs] : projectsDirs) {
    for (const project of safeReaddir(projectsDir)) {
      const dir = path.join(projectsDir, project);
      if (!isDirectory(dir)) continue;

      for (const entry of safeReaddir(dir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const id = entry.slice(0, -'.jsonl'.length);
        const file = path.join(dir, entry);
        const found = index.get(id);
        // The same roots can be reached twice — CLAUDE_CONFIG_DIR naming the
        // default directory in a different capitalisation, say — and counting
        // one file as two would report a conversation as living in more places
        // than it does. Compared the way paths are compared everywhere else,
        // because the string form is exactly what differs between the spellings.
        if (!found) index.set(id, [file]);
        else if (!found.some((seen) => samePath(seen, file))) found.push(file);
      }
    }
  }

  return index;
}

/**
 * What a conversation keeps when the app branches it.
 *
 * A branch is not a new conversation: the app copies the history into a new file
 * with a new `cliSessionId` and carries on there, so the two transcripts share
 * every record up to the moment they parted — including the first one. That
 * first `uuid` is therefore the one identifier a branch cannot change, and it is
 * what lets two rows that look unrelated by id be recognised as the same work.
 *
 * Records before it have no `uuid` at all — `ai-title`, `custom-title`, `mode`,
 * `queue-operation` are the app's own bookkeeping, rewritten on every save — so
 * the scan skips them rather than trusting the first line.
 *
 * Undefined when the file cannot be read, holds nothing with a `uuid`, or is not
 * on disk at all. Callers must treat that as "no answer" rather than as "not the
 * same": guessing either way from a missing transcript is worse than the id
 * comparison it would replace.
 */
export function conversationRoot(file: string): string | undefined {
  for (const record of headRecords(file, ROOT_BYTES)) {
    if (typeof record.uuid === 'string' && record.uuid !== '') return record.uuid;
  }
  return undefined;
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

/** How much of a transcript's tail to read when recovering where it last ran. */
const TAIL_CWD_BYTES = 256 * 1024;

/**
 * The working directory a conversation last ran in.
 *
 * The head records a cwd too, and it is wrong for exactly the conversations
 * that need this read: a session that moves between worktrees writes its first
 * records in one directory and its last in another, and `claude --resume`
 * belongs in the last one — the directory whose project folder the transcript
 * is actually filed under. Measured on a live store: three of eleven
 * crash-stranded conversations had moved, and the head named a directory the
 * work had already left.
 */
export function lastRecordedCwd(file: string): string | undefined {
  let text: string;
  let truncated: boolean;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_CWD_BYTES);
    truncated = length < size;
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }

  const lines = text.split('\n');
  // The first line of a truncated read starts mid-record.
  if (truncated) lines.shift();

  let cwd: string | undefined;
  for (const line of lines) {
    const record = parseRecord(line);
    if (record && typeof record.cwd === 'string' && record.cwd !== '') cwd = record.cwd;
  }
  return cwd;
}

/** What a whole transcript says about itself, in the terms a fork is judged by. */
export interface ConversationScan {
  /**
   * Every record's `uuid`. A branch is a copy of the history, so the records it
   * shares with its sibling carry the same ids — which makes set difference the
   * measure of what each side holds alone.
   */
  uuids: Set<string>;
  /**
   * The last record carrying a timestamp, which is the last thing *said*.
   *
   * Deliberately not the file's `mtime`. The app rewrites its own bookkeeping —
   * `custom-title`, `mode`, `last-prompt` — every time a card is opened, so mtime
   * moves for a conversation nobody added a word to. Measured on a real store: a
   * transcript whose last message was a day old had a newer mtime than the branch
   * that had been running all morning, because its card had just been clicked.
   */
  lastMessageAt?: number;
}

/**
 * Read a transcript end to end, which nothing else here does.
 *
 * Every other reader takes the head, because these files reach hundreds of
 * megabytes and the facts worth recovering are written near the start. This one
 * cannot: what it answers is which records a branch holds that its sibling never
 * got, and that is a question about the whole file. It is affordable because of
 * who asks — only conversations already known to be forked, which is a handful
 * out of thousands.
 *
 * Read in chunks rather than whole so a large transcript costs a buffer, not its
 * own size in memory.
 */
export function scanConversation(file: string): ConversationScan {
  const uuids = new Set<string>();
  let lastMessageAt: number | undefined;

  for (const record of streamRecords(file)) {
    if (typeof record.uuid === 'string' && record.uuid !== '') uuids.add(record.uuid);
    if (typeof record.timestamp === 'string') {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) lastMessageAt = at;
    }
  }

  return { uuids, ...(lastMessageAt === undefined ? {} : { lastMessageAt }) };
}

/** How much of a transcript to hold in memory at once while streaming it. */
const CHUNK_BYTES = 1024 * 1024;

function* streamRecords(file: string): Generator<Record<string, unknown>> {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return;
  }

  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    // Whatever followed the last newline of the previous chunk: a record is only
    // complete once its newline arrives, and a line can straddle any boundary.
    let pending = '';

    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;

      const lines = (pending + buffer.subarray(0, read).toString('utf8')).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const record = parseRecord(line);
        if (record) yield record;
      }
    }

    // The last line of a file that does not end in a newline is still a record.
    const record = parseRecord(pending);
    if (record) yield record;
  } catch {
    // A transcript that vanished or turned unreadable mid-read yields what it
    // gave. Callers treat a short answer as "no answer" rather than as a fork.
  } finally {
    closeSync(fd);
  }
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Individual malformed lines are skipped; the rest of the file still counts.
    return undefined;
  }
}

export interface TranscriptView {
  cliSessionId: string;
  path: string;
  title?: string;
  cwd?: string;
  createdAt?: number;
  lastActivityAt?: number;
  sizeBytes: number;
  part: 'head' | 'tail';
  /** True when the file holds more than was read. */
  truncated: boolean;
  /**
   * Raw JSONL — one record per line; on a truncated read the first or last line
   * can be a fragment.
   */
  text: string;
}

/**
 * One conversation's facts plus a readable slice of its transcript — the start,
 * or (default) the most recent part, which is where "what happened here?" is
 * usually answered.
 */
export function viewTranscript(
  cliSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  part: 'head' | 'tail' = 'tail',
  maxChars = 20_000,
): TranscriptView {
  const file = indexTranscripts(transcriptRoots(env)).get(cliSessionId);
  if (!file) {
    throw new Error(
      `No transcript found for conversation ${cliSessionId}. ` +
        'Only conversations that ran on this machine have one.',
    );
  }

  const facts = readTranscriptFacts(file, cliSessionId);
  const chars = Math.max(1000, Math.min(maxChars, 200_000));
  const { text, sizeBytes } = readPart(file, part, chars);

  return {
    cliSessionId,
    path: file,
    ...(facts.title !== undefined ? { title: facts.title } : {}),
    ...(facts.cwd !== undefined ? { cwd: facts.cwd } : {}),
    ...(facts.createdAt !== undefined ? { createdAt: facts.createdAt } : {}),
    ...(facts.lastActivityAt !== undefined ? { lastActivityAt: facts.lastActivityAt } : {}),
    sizeBytes,
    part,
    truncated: sizeBytes > chars,
    text,
  };
}

function readPart(
  file: string,
  part: 'head' | 'tail',
  maxChars: number,
): { text: string; sizeBytes: number } {
  const size = statSync(file).size;
  const length = Math.min(size, maxChars);
  const position = part === 'head' ? 0 : size - length;

  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return { text: buffer.subarray(0, read).toString('utf8'), sizeBytes: size };
  } finally {
    closeSync(fd);
  }
}

/**
 * The first records of a transcript.
 *
 * Only the head is read: these files reach hundreds of megabytes, the facts worth
 * recovering are written near the start, and a restore that had to read every
 * conversation in full would be unusable.
 */
function headRecords(file: string, bytes = HEAD_BYTES): Record<string, unknown>[] {
  let buffer: Buffer;
  let complete: boolean;

  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    buffer = buffer.subarray(0, read);
    complete = read < bytes;
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

/**
 * How much conversation sits behind each of the ids named.
 *
 * The question this answers is "is there anything there", asked of sessions the
 * sidebar will never show. An id with no transcript maps to 0 rather than being
 * left out, because "measured, and empty" is the answer that matters: it is what
 * separates a record nobody ever opened from work that ran somewhere else.
 *
 * A conversation split across installations counts as the sum of its files, the
 * same way an orphan does.
 */
export function transcriptBytes(
  ids: Iterable<string>,
  projectsDirs: string | string[],
): Map<string, number> {
  const wanted = new Set(ids);
  const out = new Map<string, number>();
  if (wanted.size === 0) return out;

  const index = indexAllTranscripts(projectsDirs);
  for (const id of wanted) {
    let total = 0;
    for (const file of index.get(id) ?? []) {
      try {
        total += statSync(file).size;
      } catch {
        // Unreadable counts as nothing rather than aborting the measurement:
        // a file that cannot be sized is one foster could not bring across.
      }
    }
    out.set(id, total);
  }
  return out;
}
