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
 * How far to stream while hunting for the record a conversation starts from.
 *
 * A fixed head read used to answer this from the first 64 KB alone, on the
 * assumption that the records in front of the root — a title, a mode, a
 * queued prompt — are never large. Measured on a real store: wrong for 369 of
 * 10,587 transcripts, 107 of them because that first record alone runs past
 * 64 KB (a first message someone pasted a file into), the rest because
 * several small ones — queue operations, retitles — stack up in front of it.
 * Every one of those answered "no root", which is not "there is none" but
 * "not found in the part read" — and a fork built on that miss goes ungrouped
 * rather than reporting the uncertainty. Streaming line by line until a uuid
 * turns up costs nothing extra for the ordinary case, where it is the first
 * or second line; the cap is only for a transcript that never gets one at
 * all, so the search still ends.
 */
const ROOT_CAP_BYTES = 4 * 1024 * 1024;

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
  // First one wins, which is an answer to "is there a transcript, and where do I
  // point a reader at it" and to nothing else. The copies are not mirrors — see
  // `scanConversationFiles` — so anything measuring a conversation must take
  // every path instead.
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
 * The project directory a working directory's transcripts live under.
 *
 * The app stores a conversation at `projects/<this>/<cliSessionId>.jsonl`, so
 * this is what decides which of a conversation's files a given card opens — the
 * question `scanConversationFiles` explains the need for. Every separator and
 * every `.`, `:` and `_` becomes a dash, which is why the mapping only runs this
 * way: two different directories can encode to one name, and the reverse cannot
 * be recovered at all. Measured on this store: the encoded `cwd` names a project
 * directory the conversation actually occupies for 6805 of 7597 cards, and every
 * one of the 792 misses is a card in a worktree whose conversation was never
 * written there.
 *
 * A caller that cannot find the answer here must treat it as "cannot tell"
 * rather than as "no records": a miss is far more often a card pointing
 * somewhere empty than proof about what it reaches.
 */
export function projectDirName(cwd: string): string {
  let name = '';
  for (const ch of cwd) {
    name += ch === '\\' || ch === '/' || ch === ':' || ch === '.' || ch === '_' ? '-' : ch;
  }
  return name;
}

/**
 * The one file a card opens, out of everything its conversation occupies.
 *
 * Undefined when that cannot be told: no working directory, no file under the
 * name it encodes to, or — because the encoding is lossy — more than one. The
 * refusal is deliberate; see `projectDirName`.
 */
export function fileOpenedFrom(
  files: readonly string[],
  cwd: string | undefined,
): string | undefined {
  if (cwd === undefined || cwd === '') return undefined;
  const wanted = projectDirName(cwd).toLowerCase();
  const hits = files.filter((file) => path.basename(path.dirname(file)).toLowerCase() === wanted);
  return hits.length === 1 ? hits[0] : undefined;
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
  let consumed = 0;
  for (const line of streamLines(file, 'utf8')) {
    consumed += line.length + 1;
    if (line.trim() !== '') {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (typeof record.uuid === 'string' && record.uuid !== '') return record.uuid;
      } catch {
        // Individual malformed lines are skipped; the search goes on.
      }
    }
    if (consumed >= ROOT_CAP_BYTES) break;
  }
  return undefined;
}

/**
 * Which of `wanted` this transcript mentions as a record's own id.
 *
 * Deliberately not a JSON walk for every line. The caller asks this of every
 * transcript it can see, and on a real store that is 6.7 GB: parsing every
 * record costs 118 seconds, while matching the id shape costs under 5.
 * Nothing here needs the records — only whether an id occurs — so a first
 * pass by pattern is the whole expense of the common case, which is finding
 * nothing.
 *
 * The pattern alone over-answers, though: a structured `toolUseResult` — an
 * MCP result object, say — can quote another conversation's head as a nested
 * value, at any depth, and the pattern cannot tell that from a record naming
 * itself. Read literally, that turned a borrowed id into a false alias, which
 * `deepen` then trusted enough to mark a whole conversation stale over one
 * quoted record it never wrote. A hit against `wanted` is rare on a real
 * store, so each one is confirmed with `recordFields` — the same structural
 * reader `scanConversation` uses, which only reports a key found at a
 * record's own top level — before it counts. The pattern is still what finds
 * the hit; the structural read only ever narrows what the pattern found.
 *
 * Read in chunks, not the whole file: `readFileSync` here used to hand the
 * largest transcripts to V8 as one string, and a file past its string-length
 * ceiling (today's largest is 78 MB and growing) threw, was caught, and
 * answered "mentions nothing" — the fork it belonged to simply disappeared
 * rather than erroring loudly. A chunk costs one buffer, not the file's own
 * size, however large the file grows.
 *
 * Kept at the byte level, one `matchAll` per chunk, rather than reusing
 * `streamLines` for one `matchAll` per line: an early version did that, and
 * over a real store re-deciding "is this a complete line yet" for every line
 * of a multi-million-line corpus measured slower than the few big chunk
 * reads this does instead (`SCAN_CHUNK_BYTES`) — see that constant's own
 * comment for the numbers and their noise. `SCAN_OVERLAP_BYTES` is the
 * boundary the pattern must be kept whole across: more than `"uuid":"` plus
 * 36 hex-and-dash characters plus the closing quote, so a match cut in half
 * by one read is whole again, from the carried tail, in the next. Carrying
 * means a match inside the overlap is seen twice; `found` absorbs the repeat
 * for free, and re-validating it a second time costs nothing a real hit
 * would not have paid anyway. Validating a hit needs the whole line it sits
 * in, which the chunk it was found in may not hold entirely — `ownerLine`
 * seeks around the match's own byte offset for it, growing outward only
 * because these are rare.
 *
 * `cache`, when passed, is where the chunked read and the pattern match
 * (`scanRecordIdOccurrences`) are remembered across calls — see
 * `RecordIdCache`. Without one, every call pays the read again; `deepen`
 * passes one because it is exactly the caller this exists for: the sweep
 * calls it once per round, each round asking the same already-known files
 * about whatever new ids that round brought, and re-reading every earlier
 * round's files from disk for one new id undid most of the saving the
 * rounds themselves were written to buy. Measured on a real store (2,523
 * conversations): an initial full deepen ~17 s, a next round adding exactly
 * one new id ~13 s uncached — nearly the same cost again — against
 * effectively free once that round's files are cached from the first pass.
 */
export function idsMentionedIn(
  file: string,
  wanted: ReadonlySet<string>,
  cache?: RecordIdCache,
): string[] {
  if (wanted.size === 0) return [];

  let occurrences = cache?.get(file);
  if (occurrences === undefined) {
    occurrences = scanRecordIdOccurrences(file);
    cache?.set(file, occurrences);
  }
  if (occurrences.size === 0) return [];

  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    // Unreadable says nothing about lineage, exactly as a missing root does.
    return [];
  }

  const found: string[] = [];
  try {
    const size = statSync(file).size;
    for (const id of wanted) {
      const offsets = occurrences.get(id);
      if (offsets === undefined) continue;
      for (const offset of offsets) {
        // A structured toolUseResult — an MCP result object, say — can quote
        // another conversation's head as a nested value, at any depth, and
        // the pattern cannot tell that from a record naming itself. Read
        // literally, that turned a borrowed id into a false alias, which
        // `deepen` then trusted enough to mark a whole conversation stale
        // over one quoted record it never wrote. `recordFields` — the same
        // structural reader `scanConversation` uses — only reports a key
        // found at a record's own top level, so a hit is confirmed against
        // it before it counts. A rejected offset moves on to the next one
        // this id was seen at — the same retry the scan below always did
        // inline, now against the offsets it already collected.
        const line = ownerLine(fd, size, offset);
        if (line !== undefined && recordFields(line)?.uuid === id) {
          found.push(id);
          break;
        }
      }
    }
  } catch {
    // Unreadable now, after the scan below already read it once, says
    // nothing new — treated the same as a transcript that mentions nothing.
  } finally {
    closeSync(fd);
  }

  return found;
}

/**
 * Per-file memo for `idsMentionedIn`'s own scan, owned by the caller.
 *
 * `Lineage.deepen` keeps one for the lifetime of a run (the same lifetime as
 * its other memos, one per account) and passes it to every `idsMentionedIn`
 * call it makes, so a file already scanned for one round's `wanted` answers a
 * later round's different — usually smaller, sometimes a single id —
 * `wanted` from memory instead of from disk. Nothing here is specific to
 * `deepen`; a future caller with the same "ask the same file about a
 * shifting `wanted` set, more than once" shape can share the type.
 */
export type RecordIdCache = Map<string, ReadonlyMap<string, number[]>>;

/**
 * `idsMentionedIn`'s own chunked read and pattern match, without the
 * `wanted` filter or the structural validation: every `"uuid":"…"` match the
 * pattern finds anywhere in the file, keyed by id, each id's value the byte
 * offsets it was found at — almost always one, more only when a real
 * record's id is genuinely quoted more than once.
 *
 * Split out so the expensive part — the disk read and the `matchAll` pass —
 * runs once per file no matter how many different `wanted` sets ask about it
 * afterwards (`RecordIdCache`); validating a hit is what stays cheap and
 * rare, done by `idsMentionedIn` against whichever ids a caller actually
 * wants, every time it is asked.
 */
function scanRecordIdOccurrences(file: string): ReadonlyMap<string, number[]> {
  const occurrences = new Map<string, number[]>();

  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    // Unreadable says nothing about lineage, exactly as a missing root does.
    return occurrences;
  }

  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size));
    let position = 0;
    // What the previous chunk's own tail read as latin1, carried forward so a
    // pattern split across the boundary is complete in the next chunk too.
    let carry = '';

    while (position < size) {
      const length = Math.min(SCAN_CHUNK_BYTES, size - position);
      const read = readSync(fd, buffer, 0, length, position);
      if (read <= 0) break;
      const text = carry + buffer.subarray(0, read).toString('latin1');
      const textStart = position - carry.length;

      for (const match of text.matchAll(RECORD_ID)) {
        const id = match[1]!;
        const offset = textStart + (match.index ?? 0);
        const offsets = occurrences.get(id);
        if (offsets === undefined) occurrences.set(id, [offset]);
        // The overlap carries a boundary match into the next chunk on
        // purpose, so the same physical match is seen twice, back to back,
        // at the same computed offset — kept once rather than piling up.
        else if (offsets[offsets.length - 1] !== offset) offsets.push(offset);
      }

      position += read;
      carry = text.length > SCAN_OVERLAP_BYTES ? text.slice(-SCAN_OVERLAP_BYTES) : text;
    }
  } catch {
    // A transcript that vanished or turned unreadable mid-read is treated the
    // same as one that mentions nothing found so far.
  } finally {
    closeSync(fd);
  }

  return occurrences;
}

/**
 * How much to read at once while scanning for ids. Bigger than the 1 MiB
 * `streamLines` uses, so fewer chunks pay the `matchAll` and string-
 * concatenation cost over a large transcript — this and 1 MiB were both
 * measured against one `readFileSync` per file over the real store this
 * shipped against (2,759 transcripts, 7.8 GB, 356 wanted ids, interleaved
 * runs so every version reads a warm disk cache): all three land within the
 * same run-to-run noise on this machine, roughly ±30% call to call, so
 * nothing here claims to have beaten the old whole-file read — only to not
 * have lost to it, which is what the file-size ceiling below buys. Still a
 * small fraction of that ceiling for a whole 78 MB (and growing) file.
 */
const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * More than the longest thing `RECORD_ID` can match — `"uuid":"` (8) + 36 hex
 * and dash characters + a closing quote (1) = 45 — so carrying this many
 * bytes from one chunk's tail into the next always completes a pattern the
 * boundary cut in half.
 */
const SCAN_OVERLAP_BYTES = 128;

/** How far `ownerLine` looks on each side of a match before it gives up. */
const LINE_PROBE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The whole line a byte offset falls inside, read directly off disk.
 *
 * The chunk a match was found in rarely holds its whole line — a chunk is a
 * fixed slice of bytes, not a slice of records — so this seeks around `at`
 * instead of asking the caller to carry more than the pattern needs. Starts
 * small and quadruples each retry, because every call here is already a rare
 * hit against `wanted`; growing from nothing keeps the ordinary short line
 * cheap without capping what an unusually long one can still be read as.
 *
 * Undefined when a boundary is never found within the cap, or the file
 * cannot be read — a caller that cannot confirm a hit must treat it as
 * unconfirmed, never as confirmed by default.
 */
function ownerLine(fd: number, size: number, at: number): string | undefined {
  let radius = 4096;
  for (;;) {
    const start = Math.max(0, at - radius);
    const end = Math.min(size, at + radius);
    const length = end - start;
    const buffer = Buffer.alloc(length);
    let read: number;
    try {
      read = readSync(fd, buffer, 0, length, start);
    } catch {
      return undefined;
    }
    const text = buffer.subarray(0, read).toString('latin1');
    const relative = at - start;
    const lineStart = text.lastIndexOf('\n', relative);
    const lineEnd = text.indexOf('\n', relative);
    const gotStart = lineStart !== -1 || start === 0;
    const gotEnd = lineEnd !== -1 || end === size;
    if (gotStart && gotEnd) {
      return text.slice(
        lineStart === -1 ? 0 : lineStart + 1,
        lineEnd === -1 ? text.length : lineEnd,
      );
    }
    if (radius >= LINE_PROBE_MAX_BYTES) return undefined;
    radius = Math.min(radius * 4, LINE_PROBE_MAX_BYTES);
  }
}

/** A record's own id, as the transcript writes it. */
const RECORD_ID = /"uuid":"([0-9a-fA-F-]{36})"/g;

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
 * What was asked of a conversation, in the words that started it.
 *
 * The one thing worth recovering from a conversation that never answered. A
 * request that died before its first turn has no history to resume; what it has
 * is the prompt, and that is enough to ask again somewhere healthy.
 *
 * Two things in the head are user records without being the prompt, and both
 * would win by position if this took the first one it saw. The harness injects
 * `<system-reminder>` blocks as user turns, and a tool result comes back as one
 * too — structured content with no `text` part, which is why the text is
 * gathered from the parts rather than read off the record.
 */
export function firstPrompt(file: string): string | undefined {
  for (const record of headRecords(file)) {
    if (record.type !== 'user') continue;
    const message = record.message as { content?: unknown } | undefined;
    const content = message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part): part is { type: 'text'; text: string } =>
                  typeof part === 'object' &&
                  part !== null &&
                  (part as { type?: unknown }).type === 'text' &&
                  typeof (part as { text?: unknown }).text === 'string',
              )
              .map((part) => part.text)
              .join('\n')
          : '';
    const trimmed = text.trim();
    if (trimmed === '') continue;
    // A reminder is scaffolding the harness wrote, not something anyone asked
    // for. Skipped rather than stripped: a record that is one is not also the
    // prompt, and half a reminder read as a request is worse than reading on.
    if (trimmed.startsWith('<system-reminder>')) continue;
    return trimmed;
  }
  return undefined;
}

/** How much of a transcript's tail to read when recovering where it last ran. */
const TAIL_CWD_BYTES = 256 * 1024;

/**
 * The whole lines in a transcript's last `bytes`, oldest first.
 *
 * Undefined when the file cannot be read. The first line of a truncated read
 * starts mid-record and is dropped, so every line handed back is a whole one.
 */
function tailLines(file: string, bytes = TAIL_CWD_BYTES): string[] | undefined {
  let text: string;
  let truncated: boolean;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
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
  if (truncated) lines.shift();
  return lines;
}

/** The last answer a transcript holds, as far as telling why the work stopped goes. */
export interface LastAnswer {
  /** When it was written. */
  at: number;
  /**
   * The app's own error kind when the "answer" is one it wrote in the model's
   * place — `rate_limit` for a usage limit — and undefined for a real answer.
   */
  error?: string;
  /** The text shown, for an error: "You've hit your weekly limit · resets …". */
  text?: string;
}

/**
 * The last `assistant` record in a transcript's tail.
 *
 * A conversation cut off by a usage limit ends on a record the app writes
 * itself: `model: "<synthetic>"`, `isApiErrorMessage: true`, `error:
 * "rate_limit"`, and the limit's own sentence as its text. Measured on a real
 * store, that record is the whole difference between a session that stopped
 * because its account ran out and one that finished — the card says nothing,
 * since fostering drops the card's `error` along with everything else the app
 * would show as a stale warning.
 *
 * Records after it are the app's bookkeeping (`last-prompt`, queue operations)
 * and are passed over. Undefined when the tail holds no answer at all.
 *
 * The tail read starts at `TAIL_CWD_BYTES` and widens when that window turns
 * up nothing: measured on a real store, 22 of 7,721 transcripts have more
 * than 256 KB of bookkeeping — queue operations, retitles — written after
 * their last answer, which pushed it out of a fixed window entirely and read
 * as a session that finished cleanly rather than one `revive` should offer.
 * Each retry rereads the file at a larger size rather than tailing further
 * from where the last one stopped, which costs an extra read only for the
 * rare file that needs one; `MAX_TAIL_BYTES` is where it gives up instead of
 * reading a hundreds-of-megabytes transcript for an answer that plainly is
 * not there.
 */
export function lastAnswer(file: string): LastAnswer | undefined {
  let bytes = TAIL_CWD_BYTES;
  for (;;) {
    const lines = tailLines(file, bytes);
    if (lines === undefined) return undefined;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = parseRecord(lines[index]!);
      if (!record || record.type !== 'assistant' || record.isSidechain === true) continue;
      const at = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
      if (Number.isNaN(at)) continue;
      if (record.isApiErrorMessage !== true) return { at };
      const error = typeof record.error === 'string' ? record.error : 'unknown';
      const text = textOf(record.message);
      return { at, error, ...(text === undefined ? {} : { text }) };
    }

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return undefined;
    }
    if (bytes >= size || bytes >= MAX_TAIL_BYTES) return undefined;
    bytes = Math.min(bytes * TAIL_GROWTH, MAX_TAIL_BYTES, size);
  }
}

/** How much larger each retry's window is, when the previous one found no answer. */
const TAIL_GROWTH = 4;

/** Give up widening past this many bytes rather than reading the whole file. */
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** The text blocks of a message, joined — what the app showed for it. */
function textOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block: unknown) =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((text): text is string => typeof text === 'string');
  return parts.length > 0 ? parts.join('\n') : undefined;
}

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
  const lines = tailLines(file);
  if (lines === undefined) return undefined;

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
  /**
   * The last record the assistant wrote — the last time the work moved.
   *
   * Kept apart from `lastMessageAt` because the two disagree in exactly the
   * case that matters. Opening a card whose conversation stopped a day ago
   * resumes it, and the resume appends user records — task notifications, a
   * result line — with today's timestamp and no answer after them. Measured on
   * a real store: last answer 18:10 the day before, last record 08:24 that
   * morning, from one click. A stale row stamped with the click would claim to
   * be the newest thing there.
   */
  lastAssistantAt?: number;
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
  let lastAssistantAt: number | undefined;

  // Read field by field rather than record by record: three strings out of each
  // line, and none of the graph around them. See `recordFields` for why the
  // whole-record parse this replaces was the cost, and `streamLines` for why the
  // bytes are decoded as latin1 — a uuid, an ISO timestamp and a type tag are
  // ASCII, and nothing here is shown to anybody.
  for (const line of streamLines(file, 'latin1')) {
    const record = recordFields(line);
    if (!record) continue;
    if (record.uuid !== undefined && record.uuid !== '') uuids.add(record.uuid);
    if (record.timestamp !== undefined) {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) {
        lastMessageAt = at;
        if (record.type === 'assistant') lastAssistantAt = at;
      }
    }
  }

  return {
    uuids,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastAssistantAt === undefined ? {} : { lastAssistantAt }),
  };
}

/**
 * One conversation read across every file it occupies, as one scan.
 *
 * A `cliSessionId` can name more than one transcript, and those files are not
 * copies of each other. The app finds a conversation's transcript under the
 * project directory for the card's `cwd`, so continuing one conversation from
 * two working directories — a repository and a worktree cut from it — leaves
 * two files under one id, each holding the records written while that card was
 * the one being used. Measured on a real store: 41 conversations with more than
 * one file, 24 of them with records the first file does not hold, 6070 records
 * in total that reading one file cannot see.
 *
 * Union rather than choice, because neither file is the conversation on its
 * own. Ids survive whatever copying happened, so the shared history counts once
 * and each side's own records count too — the same property `weighBranches`
 * already relies on. The timestamps are the latest either file offers: the
 * question they answer is when this work last moved, and it moved in whichever
 * file moved last.
 */
export function scanConversationFiles(files: readonly string[]): ConversationScan {
  const scans = files.map(scanConversation);
  if (scans.length === 1) return scans[0]!;

  const uuids = new Set<string>();
  let lastMessageAt: number | undefined;
  let lastAssistantAt: number | undefined;
  for (const scan of scans) {
    for (const uuid of scan.uuids) uuids.add(uuid);
    lastMessageAt = later(lastMessageAt, scan.lastMessageAt);
    lastAssistantAt = later(lastAssistantAt, scan.lastAssistantAt);
  }

  return {
    uuids,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastAssistantAt === undefined ? {} : { lastAssistantAt }),
  };
}

/** The later of two moments, when either may be missing. */
function later(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The three top-level fields a whole-file scan needs, read out of one JSONL line
 * without building the record.
 *
 * `JSON.parse` is the obvious way and was the expensive one. These records carry
 * the whole conversation — a `message` with every content block, a
 * `toolUseResult` with whatever a tool returned — and a scan wants three short
 * strings out of each. Measured 21/09/2026 by CPU-profiling a dry `foster sweep`
 * on a real store: 105.8 s of wall clock, of which **57.3 s was the garbage
 * collector** alone, collecting record graphs built and dropped one line at a
 * time.
 *
 * Deliberately not `idsMentionedIn`'s trick. That one asks whether an id occurs
 * *anywhere*, so a regex over the raw bytes is the whole answer; this one asks
 * what the record's **own** `uuid` is, and a regex cannot tell a record's id from
 * one quoted inside a tool result. The set difference between two branches is
 * what decides which of them is stale, so a borrowed id is a wrong verdict on
 * somebody's work, not a rounding error.
 *
 * So this walks the line instead — but structurally, never character by
 * character: strings are stepped over with `indexOf`, which is the native scan,
 * and the loop only turns over at a brace, a bracket or a quote. A key counts
 * only at depth 1. The cost is the number of tokens, not the number of bytes,
 * which is what makes a 10 KB text block free.
 *
 * `undefined` means the line is not one self-contained JSON object — a torn tail,
 * a fragment, a blank — and the caller skips it exactly as it skipped a line
 * `JSON.parse` threw on.
 */
export interface RecordFields {
  uuid?: string;
  timestamp?: string;
  type?: string;
}

/** The only keys this reads; everything else is stepped over unexamined. */
const SCANNED_KEYS = new Set(['uuid', 'timestamp', 'type']);

const SPACE = 0x20;
const TAB = 0x09;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const QUOTE = 0x22;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === NEWLINE || code === RETURN;
}

function skipSpace(line: string, from: number): number {
  let at = from;
  while (at < line.length && isSpace(line.charCodeAt(at))) at++;
  return at;
}

/**
 * Where the string opened at `quoteAt` ends, or -1 when it never does.
 *
 * A quote closes a string only when an even number of backslashes precedes it:
 * `"a\\"` is a complete string ending in one backslash, while `"a\""` carries a
 * quote. Counting them is the whole of JSON's escaping that matters here, since
 * every other escape is a character this never inspects.
 */
function endOfString(line: string, quoteAt: number): number {
  let from = quoteAt + 1;
  for (;;) {
    const at = line.indexOf('"', from);
    if (at === -1) return -1;
    let back = at - 1;
    let slashes = 0;
    while (back > quoteAt && line.charCodeAt(back) === BACKSLASH) {
      slashes++;
      back--;
    }
    if (slashes % 2 === 0) return at;
    from = at + 1;
  }
}

/**
 * Characters copied out of a line, as a string that does not hold on to it.
 *
 * `line.slice(from, to)` is the obvious way and it leaks here. V8 answers a
 * slice of 13 characters or more with a *sliced string*: a view that keeps the
 * whole parent alive. A uuid is 36, so every id this hands back would pin the
 * record it came from — and `scanConversation` keeps every id of the file in a
 * Set. Measured 21/09/2026 on the first build of this change: a dry `foster
 * sweep` died at `Ineffective mark-compacts near heap limit` with 3.8 GB of
 * heap, where the parse it replaced had never come near it. The parse never had
 * the problem because it builds every value fresh.
 *
 * `String.fromCharCode` over a reused buffer copies instead of viewing, and the
 * buffer is reused because allocating one per record is the allocation this
 * whole change exists to avoid. These three fields are a uuid, an ISO timestamp
 * and a short tag; anything longer than the buffer is not one of them in a shape
 * worth a fast path, so it falls back to the parse, which copies too.
 */
const COPY_LIMIT = 256;
const copied: number[] = new Array<number>(COPY_LIMIT).fill(0);

function detachedSlice(line: string, from: number, to: number): string | undefined {
  const length = to - from;
  // Under 13 characters V8 copies rather than views, so the slice is already
  // independent — which covers the timestamps and the type tags.
  if (length < 13) return line.slice(from, to);
  if (length > COPY_LIMIT) return undefined;

  copied.length = length;
  for (let at = 0; at < length; at++) copied[at] = line.charCodeAt(from + at);
  return String.fromCharCode(...copied);
}

/**
 * The text of a string body, decoded only when it has an escape in it.
 *
 * These three fields are a uuid, an ISO timestamp and a short tag, so a copy of
 * the characters is almost always the answer already. When it is not, `JSON.parse`
 * on that one string is what makes this agree with a parse of the whole record
 * rather than nearly agree — and it builds a string of its own, so it is safe in
 * the same way `detachedSlice` is.
 */
function stringValue(line: string, from: number, to: number): string | undefined {
  // Asked of the line rather than of a slice of it: taking the slice first would
  // allocate the very view this is here to avoid, on every field of every record.
  const escape = line.indexOf('\\', from);
  if (escape === -1 || escape >= to) {
    const copy = detachedSlice(line, from, to);
    if (copy !== undefined) return copy;
  }
  try {
    const text: unknown = JSON.parse(`"${line.slice(from, to)}"`);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

export function recordFields(line: string): RecordFields | undefined {
  const end = line.length;
  let at = skipSpace(line, 0);
  if (at >= end || line.charCodeAt(at) !== OPEN_BRACE) return undefined;
  at++;

  const fields: RecordFields = {};
  let depth = 1;

  while (at < end) {
    const code = line.charCodeAt(at);

    if (code === QUOTE) {
      const close = endOfString(line, at);
      if (close === -1) return undefined;

      // At depth 1 a string followed by a colon is a key of the record itself.
      // Nowhere else can a string be followed by one, so no other depth needs
      // asking, and a nested `"uuid"` never reaches this branch.
      if (depth === 1) {
        const afterKey = skipSpace(line, close + 1);
        if (line.charCodeAt(afterKey) === COLON) {
          const key = line.slice(at + 1, close);
          const valueAt = skipSpace(line, afterKey + 1);
          if (SCANNED_KEYS.has(key)) {
            const field = key as keyof RecordFields;
            if (line.charCodeAt(valueAt) === QUOTE) {
              const valueEnd = endOfString(line, valueAt);
              if (valueEnd === -1) return undefined;
              const text = stringValue(line, valueAt + 1, valueEnd);
              // A value this cannot decode is one the caller would have rejected
              // anyway; dropping the key keeps a repeated one from leaving the
              // earlier reading in place, exactly as a parse would.
              if (text === undefined) delete fields[field];
              else fields[field] = text;
              at = valueEnd + 1;
              continue;
            }
            // Not a string, so not something the callers accept — and it still
            // overrides an earlier key of the same name.
            delete fields[field];
          }
          at = valueAt;
          continue;
        }
      }

      at = close + 1;
      continue;
    }

    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      depth++;
      at++;
      continue;
    }

    if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      depth--;
      at++;
      if (depth === 0) break;
      if (depth < 0) return undefined;
      continue;
    }

    at++;
  }

  // Anything but one closed object followed by nothing is a fragment. This is
  // the line `JSON.parse` used to throw on, and skipping it here keeps a torn
  // tail from being counted as a record.
  if (depth !== 0) return undefined;
  if (skipSpace(line, at) !== end) return undefined;
  return fields;
}

/** How much of a transcript to hold in memory at once while streaming it. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * A transcript's lines, a chunk of buffer at a time.
 *
 * Read in chunks rather than whole so a large transcript costs a buffer, not its
 * own size in memory.
 *
 * The encoding is the caller's to choose because it is the second cost after the
 * parse, the same trade `idsMentionedIn` makes. `latin1` is a byte-for-byte
 * decode with nothing to validate, and it is safe for anything that only reads
 * the structure and ASCII fields out of JSON: every byte of a multi-byte UTF-8
 * character is 0x80 or above, so none of them can pass for a quote, a backslash,
 * a brace or a bracket. It also removes a hazard `utf8` has here — a character
 * split across two chunk reads decodes as replacement characters, because each
 * chunk is decoded on its own. Measured 21/09/2026 over the 40 largest
 * transcripts on this machine, 1381 MB: 10.4 s parsing utf8, 8.4 s scanning
 * utf8, 5.0 s scanning latin1.
 *
 * What it is not safe for is handing text back. A caller that wants the words of
 * a record wants `utf8`, and every caller that does asks for it.
 */
function* streamLines(file: string, encoding: BufferEncoding = 'utf8'): Generator<string> {
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

      const lines = (pending + buffer.subarray(0, read).toString(encoding)).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) yield line;
    }

    // The last line of a file that does not end in a newline is still a record.
    if (pending !== '') yield pending;
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
