import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomicBinary } from '../../util/fsatomic.js';
import { VERSION } from '../../version.js';
import {
  idsMentionedIn,
  recordFields,
  scanConversation,
  scanConversationFiles,
  type ConversationScan,
} from '../transcripts.js';
import { ByteReader, ByteWriter, bytesToUuid, shortHash, uuidToBytes } from './binary.js';
import { CACHE_SCHEMA } from './schema.js';

/** Bytes at the tail of the already-scanned region a resume verifies before trusting it. */
const TAIL_BYTES = 4096;

const MAGIC = 'FCTC';

/** A growth-resumable entry shared by both caches below, minus the payload each one adds. */
interface GrowthEntry {
  size: number;
  mtimeMs: number;
  /** How far into the file this entry has been scanned — always `size`, kept as its own field for clarity. */
  offset: number;
  /** A fingerprint of the `TAIL_BYTES` before `offset`, as they read when this entry was built. */
  tailHash: Buffer;
}

interface ScanEntry extends GrowthEntry {
  lastMessageAt?: number;
  lastAssistantAt?: number;
  /** Each record's own `uuid` — what `ConversationScan.uuids` answers with. */
  uuids: Set<string>;
}

interface MentionEntry extends GrowthEntry {
  /** Every id-shaped string the file mentions anywhere — what `idsMentionedIn` answers with. */
  uuids: Set<string>;
}

interface OwnScanRange {
  uuids: Set<string>;
  lastMessageAt?: number;
  lastAssistantAt?: number;
}

/** A record id occurring anywhere in the text, own-record or quoted inside another one. */
const MENTIONED_ID = /"uuid":"([0-9a-fA-F-]{36})"/g;

/**
 * `scanConversation` and `idsMentionedIn`, kept across runs — as two entirely
 * separate caches sharing one file, not one combined entry.
 *
 * They read the same bytes for different reasons, but a sweep asks them of
 * very different populations: `scanConversation` (through `Lineage.scanOf` /
 * `reachOf`) runs over every card it looks at, thousands of files on a real
 * store; `idsMentionedIn` (through `Lineage.deepen`) runs only over
 * conversations already known to be forked — "a handful", per
 * `engine/lineage.ts`. Measured 24/09/2026: computing and retaining the
 * mentioned-id superset for every file `scanConversation` touched, not only
 * the handful that ever asked for it, ran a real store's dry-run sweep out of
 * the default heap — `Ineffective mark-compacts near heap limit` — where the
 * uncached sweep finished in 78 s. Splitting the two back into independent,
 * independently-grown entries is what keeps a `scanConversation`-only run
 * paying for exactly what it always paid for.
 *
 * Both are still growth-resumable the same way: a transcript only grows, so on
 * a size increase the bytes an entry was built against are checked with a
 * hash of the `TAIL_BYTES` immediately before its stored offset — read fresh
 * from the file now, not assumed — and only a match trusts that appending is
 * all that happened; a mismatch means the file was rewritten in place, and the
 * whole thing is read again. `scanConversation`'s resumed read does not start
 * `TAIL_BYTES` before the old offset and trust that to be a line boundary —
 * `lineStartAtOrBefore` walks backward from the old offset to the nearest
 * real newline instead, however far back that is. A record still being
 * written when the entry was last saved is routinely longer than
 * `TAIL_BYTES` (a big tool result, a long assistant turn), and starting a
 * fixed `TAIL_BYTES` back can then land *inside* that record rather than
 * before it; `linesInRange` used to drop whatever came before the first
 * newline in the resumed range unconditionally, on the assumption that a
 * fragment there was already-counted leftovers — for a record longer than
 * `TAIL_BYTES` that assumption is false, and the drop silently discarded the
 * whole completed record, uuid included. Resuming from a genuine line
 * boundary instead means there is never a leading fragment to drop; every id
 * lands in a `Set`, so reading a stretch of already-known bytes twice costs
 * work, not correctness.
 *
 * Ids are stored as 16 raw bytes rather than the 36-character string a
 * transcript spells one as (`uuidToBytes`/`bytesToUuid`). A string that does
 * not pack — anything not a canonical lowercase uuid, which nothing real
 * writes — is never asked to: `save()` skips persisting that file's entry
 * rather than lose or mangle the id, and the next run reads it live again.
 */
export class TranscriptCache {
  private readonly scans = new Map<string, ScanEntry>();
  private readonly mentions = new Map<string, MentionEntry>();
  private dirty = false;
  private loaded = false;

  constructor(private readonly file: string) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    let buf: Buffer;
    try {
      buf = readFileSync(this.file);
    } catch {
      return;
    }

    try {
      const reader = new ByteReader(buf);
      if (reader.remaining < 4 || reader.raw(4).toString('ascii') !== MAGIC) return;
      if (reader.u8() !== CACHE_SCHEMA) return;
      if (reader.str() !== VERSION) return;

      const scanCount = reader.u32();
      for (let index = 0; index < scanCount; index += 1) {
        const entryPath = reader.str();
        const size = reader.f64();
        const mtimeMs = reader.f64();
        const offset = reader.f64();
        const tailHash = reader.raw(16);
        const lastMessageAtRaw = reader.f64();
        const lastAssistantAtRaw = reader.f64();
        const uuids = readUuidSet(reader);
        this.scans.set(entryPath, {
          size,
          mtimeMs,
          offset,
          tailHash,
          ...(lastMessageAtRaw < 0 ? {} : { lastMessageAt: lastMessageAtRaw }),
          ...(lastAssistantAtRaw < 0 ? {} : { lastAssistantAt: lastAssistantAtRaw }),
          uuids,
        });
      }

      const mentionCount = reader.u32();
      for (let index = 0; index < mentionCount; index += 1) {
        const entryPath = reader.str();
        const size = reader.f64();
        const mtimeMs = reader.f64();
        const offset = reader.f64();
        const tailHash = reader.raw(16);
        const uuids = readUuidSet(reader);
        this.mentions.set(entryPath, { size, mtimeMs, offset, tailHash, uuids });
      }
    } catch {
      // A torn or foreign file is not a cache; start empty and rebuild it.
      this.scans.clear();
      this.mentions.clear();
    }
  }

  /**
   * `scanConversation`, refreshing the cached entry first when the file has
   * grown or changed. Never throws: a file that vanished or turned unreadable
   * answers empty, the same as the live function.
   */
  scanConversation(file: string): ConversationScan {
    this.ensureLoaded();

    const stat = statSafe(file);
    if (!stat) return { uuids: new Set() };

    const existing = this.scans.get(file);
    if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
      return ownResult(existing);
    }

    if (
      existing &&
      stat.size > existing.size &&
      tailStillMatches(file, existing.offset, existing.tailHash)
    ) {
      const from = lineStartAtOrBefore(file, existing.offset);
      const grown = scanOwnRange(file, from, stat.size);
      if (grown) {
        const lastMessageAt = later(existing.lastMessageAt, grown.lastMessageAt);
        const lastAssistantAt = later(existing.lastAssistantAt, grown.lastAssistantAt);
        const merged: ScanEntry = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset: stat.size,
          tailHash: hashTail(file, stat.size),
          ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
          ...(lastAssistantAt === undefined ? {} : { lastAssistantAt }),
          uuids: unionOf(existing.uuids, grown.uuids),
        };
        this.scans.set(file, merged);
        this.dirty = true;
        return ownResult(merged);
      }
    }

    // No entry, the file shrank or was rewritten, or the resumed read failed:
    // the only answer left that is still correct is to read all of it.
    const full = scanOwnRange(file, 0, stat.size);
    if (!full) {
      this.scans.delete(file);
      return { uuids: new Set() };
    }
    const entry: ScanEntry = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: stat.size,
      tailHash: hashTail(file, stat.size),
      ...(full.lastMessageAt === undefined ? {} : { lastMessageAt: full.lastMessageAt }),
      ...(full.lastAssistantAt === undefined ? {} : { lastAssistantAt: full.lastAssistantAt }),
      uuids: full.uuids,
    };
    this.scans.set(file, entry);
    this.dirty = true;
    return ownResult(entry);
  }

  /**
   * `idsMentionedIn`, refreshing the cached entry first when the file has
   * grown or changed. Independent of `scanConversation`'s own cache — see the
   * class doc — so a caller that only ever wants this for a handful of
   * conversations never grows the far larger population `scanConversation`
   * sees.
   */
  idsMentionedIn(file: string, wanted: ReadonlySet<string>): string[] {
    if (wanted.size === 0) return [];
    this.ensureLoaded();

    const stat = statSafe(file);
    if (!stat) return [];

    let entry = this.mentions.get(file);
    if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
      if (entry && stat.size > entry.size && tailStillMatches(file, entry.offset, entry.tailHash)) {
        const from = Math.max(0, entry.offset - TAIL_BYTES);
        const grown = scanMentionedRange(file, from, stat.size);
        entry = grown
          ? {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              offset: stat.size,
              tailHash: hashTail(file, stat.size),
              uuids: unionOf(entry.uuids, grown),
            }
          : undefined;
      } else {
        entry = undefined;
      }

      if (!entry) {
        const full = scanMentionedRange(file, 0, stat.size);
        if (!full) {
          this.mentions.delete(file);
          return [];
        }
        entry = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset: stat.size,
          tailHash: hashTail(file, stat.size),
          uuids: full,
        };
      }

      this.mentions.set(file, entry);
      this.dirty = true;
    }

    const found: string[] = [];
    for (const id of entry.uuids) if (wanted.has(id)) found.push(id);
    return found;
  }

  get hasChanges(): boolean {
    return this.dirty;
  }

  save(): void {
    this.ensureLoaded();
    if (!this.dirty) return;

    const scanRows: Array<[string, ScanEntry]> = [];
    for (const [entryPath, entry] of this.scans) {
      if (setPacks(entry.uuids)) scanRows.push([entryPath, entry]);
    }
    const mentionRows: Array<[string, MentionEntry]> = [];
    for (const [entryPath, entry] of this.mentions) {
      if (setPacks(entry.uuids)) mentionRows.push([entryPath, entry]);
    }

    const writer = new ByteWriter();
    writer.raw(Buffer.from(MAGIC, 'ascii'));
    writer.u8(CACHE_SCHEMA);
    writer.str(VERSION);

    writer.u32(scanRows.length);
    for (const [entryPath, entry] of scanRows) {
      writer.str(entryPath);
      writer.f64(entry.size);
      writer.f64(entry.mtimeMs);
      writer.f64(entry.offset);
      writer.raw(entry.tailHash);
      writer.f64(entry.lastMessageAt ?? -1);
      writer.f64(entry.lastAssistantAt ?? -1);
      writeUuidSet(writer, entry.uuids);
    }

    writer.u32(mentionRows.length);
    for (const [entryPath, entry] of mentionRows) {
      writer.str(entryPath);
      writer.f64(entry.size);
      writer.f64(entry.mtimeMs);
      writer.f64(entry.offset);
      writer.raw(entry.tailHash);
      writeUuidSet(writer, entry.uuids);
    }

    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomicBinary(this.file, writer.toBuffer());
      this.dirty = false;
    } catch {
      // Same convention as SlimCardCache.save(): a failed write costs the next
      // run its head start, nothing this run already answered.
    }
  }
}

function ownResult(entry: ScanEntry): ConversationScan {
  return {
    uuids: new Set(entry.uuids),
    ...(entry.lastMessageAt === undefined ? {} : { lastMessageAt: entry.lastMessageAt }),
    ...(entry.lastAssistantAt === undefined ? {} : { lastAssistantAt: entry.lastAssistantAt }),
  };
}

function unionOf(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set(a);
  for (const id of b) out.add(id);
  return out;
}

function later(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function setPacks(ids: ReadonlySet<string>): boolean {
  for (const id of ids) if (!uuidToBytes(id)) return false;
  return true;
}

function writeUuidSet(writer: ByteWriter, ids: ReadonlySet<string>): void {
  writer.u32(ids.size);
  for (const id of ids) writer.raw(uuidToBytes(id)!);
}

function readUuidSet(reader: ByteReader): Set<string> {
  const count = reader.u32();
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) ids.add(bytesToUuid(reader.raw(16)));
  return ids;
}

function statSafe(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function hashTail(file: string, offset: number): Buffer {
  const from = Math.max(0, offset - TAIL_BYTES);
  const length = offset - from;
  if (length <= 0) return shortHash(Buffer.alloc(0));
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return shortHash(Buffer.alloc(0));
  }
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, from);
    return shortHash(buf.subarray(0, read));
  } catch {
    return shortHash(Buffer.alloc(0));
  } finally {
    closeSync(fd);
  }
}

function tailStillMatches(file: string, offset: number, tailHash: Buffer): boolean {
  return hashTail(file, offset).equals(tailHash);
}

const BACKSCAN_CHUNK = 64 * 1024;

/**
 * The start of the line that contains (or immediately follows) `offset` —
 * the position right after the nearest `\n` at or before `offset`, or `0`
 * when none is found scanning all the way back to the start of the file.
 *
 * Unlike a fixed `TAIL_BYTES` lookback, this always lands on a genuine line
 * boundary, however far back that is — the one property `scanOwnRange`'s
 * resumed read needs to never have to guess whether the bytes before its
 * start position belong to an already-counted line. A record longer than
 * `TAIL_BYTES` costs more than one backward chunk read here; a normal
 * transcript, with a newline every few hundred bytes, costs at most one.
 */
function lineStartAtOrBefore(file: string, offset: number): number {
  if (offset <= 0) return 0;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return 0;
  }
  try {
    let end = offset;
    const buffer = Buffer.alloc(BACKSCAN_CHUNK);
    while (end > 0) {
      const chunkSize = Math.min(BACKSCAN_CHUNK, end);
      const start = end - chunkSize;
      const read = readSync(fd, buffer, 0, chunkSize, start);
      const slice = buffer.subarray(0, read);
      const newlineAt = slice.lastIndexOf(0x0a);
      if (newlineAt !== -1) return start + newlineAt + 1;
      end = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}

const CHUNK_BYTES = 1024 * 1024;

/**
 * A file's lines between two byte offsets, oldest first.
 *
 * `from` must already be a genuine line boundary — `0`, or a position a
 * caller found with `lineStartAtOrBefore` — never an arbitrary byte offset
 * that might land inside a line. With that guarantee there is never a
 * leading fragment to drop: earlier versions of this function assumed the
 * text before the first newline in the range was always already-counted
 * leftovers and discarded it unconditionally, which silently dropped a
 * whole record — uuid included — whenever `from` landed inside a record
 * still being written when it was last cached (see the class doc). A
 * trailing line with no newline at `to` is yielded anyway, exactly as
 * `scanConversation`'s own reader does with the true end of file; a record
 * this cuts off mid-write fails to parse and is skipped by the caller, not
 * miscounted.
 */
function* linesInRange(file: string, from: number, to: number): Generator<string> {
  if (to <= from) return;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return;
  }
  try {
    let position = from;
    let pending = '';
    const buffer = Buffer.alloc(CHUNK_BYTES);

    while (position < to) {
      const want = Math.min(CHUNK_BYTES, to - position);
      const read = readSync(fd, buffer, 0, want, position);
      if (read <= 0) break;
      position += read;

      const text = pending + buffer.subarray(0, read).toString('latin1');
      const lines = text.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) yield line;
    }

    if (pending !== '') yield pending;
  } catch {
    // A file that vanished or turned unreadable mid-read yields what it gave.
  } finally {
    closeSync(fd);
  }
}

/** Everything `scanConversation` needs — own-record uuids and the two timestamps — no more. */
function scanOwnRange(file: string, from: number, to: number): OwnScanRange | undefined {
  if (to < from) return undefined;
  const uuids = new Set<string>();
  let lastMessageAt: number | undefined;
  let lastAssistantAt: number | undefined;

  try {
    for (const line of linesInRange(file, from, to)) {
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
  } catch {
    return undefined;
  }

  return {
    uuids,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastAssistantAt === undefined ? {} : { lastAssistantAt }),
  };
}

/**
 * Everything `idsMentionedIn` needs — every id-shaped string the range holds,
 * own record or quoted copy alike.
 *
 * A raw match over the range's text rather than a per-line one: the pattern
 * (`[0-9a-fA-F-]{36}`) cannot match a newline, so a match can never straddle
 * two lines and reading the range as one block finds exactly what reading it
 * line by line would.
 */
function scanMentionedRange(file: string, from: number, to: number): Set<string> | undefined {
  if (to < from) return undefined;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const length = to - from;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from);
    const text = buffer.subarray(0, read).toString('latin1');
    const uuids = new Set<string>();
    for (const match of text.matchAll(MENTIONED_ID)) uuids.add(match[1]!);
    return uuids;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** `scanConversation`, consulting and then filling the cache. No cache: exactly the live function. */
export function cachedScanConversation(
  file: string,
  cache: TranscriptCache | undefined,
): ConversationScan {
  return cache ? cache.scanConversation(file) : scanConversation(file);
}

/** `scanConversationFiles`, one cached `scanConversation` per file, unioned the same way. */
export function cachedScanConversationFiles(
  files: readonly string[],
  cache: TranscriptCache | undefined,
): ConversationScan {
  if (!cache) return scanConversationFiles(files);
  const scans = files.map((file) => cache.scanConversation(file));
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

/** `idsMentionedIn`, consulting and then filling the cache. No cache: exactly the live function. */
export function cachedIdsMentionedIn(
  file: string,
  wanted: ReadonlySet<string>,
  cache: TranscriptCache | undefined,
): string[] {
  return cache ? cache.idsMentionedIn(file, wanted) : idsMentionedIn(file, wanted);
}
