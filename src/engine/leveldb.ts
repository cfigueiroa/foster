/**
 * Enough of LevelDB's on-disk format to read one record and append another.
 *
 * Claude Desktop keeps the sidebar's pinned sessions in Chromium's IndexedDB,
 * which is a LevelDB database — not a JSON file like everything else foster
 * touches. Reaching it needs the format itself, because the database declares
 * the comparator `idb_cmp1` and every stock LevelDB binding refuses to open a
 * database whose comparator name it does not recognise. A native dependency
 * would not have solved this; implementing the pieces actually needed does.
 *
 * **Reading** has to cover both halves of the database. New writes go to a log;
 * once that log grows, LevelDB folds it into a sorted table and the log stops
 * mentioning those records at all. Reading only the log therefore answers
 * "never written" about anything a database has had time to compact, which for
 * a long-lived one is nearly everything. Whichever copy carries the higher
 * sequence number is the current one.
 *
 * **Writing** is only ever an append to the log, and only of a whole record.
 * LevelDB replays the log in order when it opens, so a later Put supersedes an
 * earlier one: adding a record at the end changes what the database says without
 * rewriting a single existing byte. Compaction, and the manifest's edit history,
 * are left entirely to the app.
 *
 * Format (db/log_format.h, db/log_writer.cc, db/write_batch.cc, table/format.cc):
 *
 *   file    32768-byte blocks
 *   record  crc32c(4, LE, masked) | length(2, LE) | type(1) | data
 *   type    1 FULL, 2 FIRST, 3 MIDDLE, 4 LAST — a payload too long for what is
 *           left of a block is split across records rather than moved
 *   crc     masked crc32c over the type byte followed by the data
 *   payload a write batch: sequence(8, LE) | count(4, LE) | entries
 *   entry   0x01 varint(keyLen) key varint(valueLen) value   (a put)
 *           0x00 varint(keyLen) key                          (a delete)
 */

import { snappyDecompress } from './snappy.js';

export const BLOCK_SIZE = 32_768;
export const HEADER_SIZE = 7;

export const FULL = 1;
export const FIRST = 2;
export const MIDDLE = 3;
export const LAST = 4;

/**
 * crc32c — the Castagnoli polynomial, not the CRC-32 used by zip and PNG.
 * Reflected form 0x82f63b78. Getting this wrong produces records that look
 * perfectly well-formed and that LevelDB rejects on the next open.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * LevelDB stores a rotated and offset checksum rather than the checksum itself,
 * so that a record whose payload happens to be a valid checksum cannot be
 * mistaken for a header.
 */
const MASK_DELTA = 0xa282ead8;

export function maskCrc(crc: number): number {
  return (((crc >>> 15) | (crc << 17)) + MASK_DELTA) >>> 0;
}

export function unmaskCrc(masked: number): number {
  const rotated = (masked - MASK_DELTA) >>> 0;
  return ((rotated >>> 17) | (rotated << 15)) >>> 0;
}

export function encodeVarint32(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

export interface Varint {
  value: number;
  next: number;
}

export function decodeVarint32(buffer: Buffer, position: number): Varint {
  let value = 0;
  let shift = 0;
  let at = position;
  for (;;) {
    if (at >= buffer.length) throw new Error('varint runs past the end of the buffer');
    const byte = buffer[at++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('varint is too long to be a 32-bit value');
  }
  return { value: value >>> 0, next: at };
}

/**
 * File numbers and sequence numbers are 64-bit. Reading them as 32-bit values
 * works right up until a database has been open long enough to matter, and then
 * silently yields the wrong log file.
 */
export function decodeVarint64(buffer: Buffer, position: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let at = position;
  for (;;) {
    if (at >= buffer.length) throw new Error('varint runs past the end of the buffer');
    const byte = buffer[at++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint is too long to be a 64-bit value');
  }
  return { value, next: at };
}

export interface LogBatch {
  /** Where the batch's first record starts, for reporting. */
  offset: number;
  payload: Buffer;
}

export class LevelDbFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LevelDbFormatError';
  }
}

export interface ReadLogOptions {
  /**
   * Stop at the first damaged record and return what came before it, rather than
   * throwing. Everything already collected is complete and checksummed; only the
   * remainder of the file is given up.
   */
  tolerant?: boolean;
}

/**
 * Read every record in a log, verifying checksums, and reassemble the batches.
 *
 * Damage is fatal by default, because the usual reason to read a log is to
 * decide what to append to it, and appending onto a log that is already broken
 * would turn a database the app might still recover into one it certainly
 * cannot.
 *
 * Reading to *report* is the other case, and there the same strictness is wrong.
 * A half-written record at the end of a log is ordinary — it is what any kill
 * during a write leaves behind, and the format exists so that LevelDB can drop
 * it and open anyway. Refusing to read such a log at all would leave the app
 * working and foster unable to so much as list what is there, which is why
 * callers that only look pass `tolerant`.
 */
export function readLog(buffer: Buffer, { tolerant = false }: ReadLogOptions = {}): LogBatch[] {
  const batches: LogBatch[] = [];
  let pending: Buffer[] | undefined;
  let pendingOffset = 0;

  for (let base = 0; base < buffer.length; base += BLOCK_SIZE) {
    const limit = Math.min(base + BLOCK_SIZE, buffer.length);
    let at = base;

    while (at + HEADER_SIZE <= limit) {
      const storedCrc = buffer.readUInt32LE(at);
      const length = buffer.readUInt16LE(at + 4);
      const type = buffer[at + 6]!;

      // A block is padded with zeros once too little room is left for a header.
      if (type === 0 && length === 0 && storedCrc === 0) break;

      if (at + HEADER_SIZE + length > limit) {
        if (tolerant) return batches;
        throw new LevelDbFormatError(
          `record at ${at} claims ${length} bytes, which runs past the end of its block`,
        );
      }

      const data = buffer.subarray(at + HEADER_SIZE, at + HEADER_SIZE + length);
      const expected = crc32c(Buffer.concat([Buffer.from([type]), data]));
      if (unmaskCrc(storedCrc) !== expected) {
        if (tolerant) return batches;
        throw new LevelDbFormatError(`checksum mismatch in the record at offset ${at}`);
      }

      if (type === FULL) {
        batches.push({ offset: at, payload: Buffer.from(data) });
      } else if (type === FIRST) {
        pending = [Buffer.from(data)];
        pendingOffset = at;
      } else if (type === MIDDLE) {
        if (pending) pending.push(Buffer.from(data));
      } else if (type === LAST) {
        if (pending) {
          pending.push(Buffer.from(data));
          batches.push({ offset: pendingOffset, payload: Buffer.concat(pending) });
          pending = undefined;
        }
      } else {
        if (tolerant) return batches;
        throw new LevelDbFormatError(`unknown record type ${type} at offset ${at}`);
      }

      at += HEADER_SIZE + length;
    }
  }

  return batches;
}

export interface BatchEntry {
  key: Buffer;
  /** Absent for a delete. */
  value?: Buffer;
}

export interface DecodedBatch {
  sequence: bigint;
  entries: BatchEntry[];
}

export function decodeBatch(payload: Buffer): DecodedBatch {
  if (payload.length < 12) {
    throw new LevelDbFormatError(`write batch is ${payload.length} bytes, too short for a header`);
  }

  const sequence = payload.readBigUInt64LE(0);
  const count = payload.readUInt32LE(8);
  const entries: BatchEntry[] = [];
  let at = 12;

  for (let index = 0; index < count && at < payload.length; index++) {
    const tag = payload[at++]!;
    const keyLength = decodeVarint32(payload, at);
    const key = payload.subarray(keyLength.next, keyLength.next + keyLength.value);
    at = keyLength.next + keyLength.value;

    if (tag === 1) {
      const valueLength = decodeVarint32(payload, at);
      const value = payload.subarray(valueLength.next, valueLength.next + valueLength.value);
      at = valueLength.next + valueLength.value;
      entries.push({ key, value });
    } else {
      entries.push({ key });
    }
  }

  return { sequence, entries };
}

export function encodeBatch(sequence: bigint, entries: BatchEntry[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(sequence, 0);
  header.writeUInt32LE(entries.length, 8);

  const parts: Buffer[] = [header];
  for (const entry of entries) {
    parts.push(Buffer.from([entry.value === undefined ? 0 : 1]));
    parts.push(encodeVarint32(entry.key.length), entry.key);
    if (entry.value !== undefined) {
      parts.push(encodeVarint32(entry.value.length), entry.value);
    }
  }
  return Buffer.concat(parts);
}

/** One past the highest sequence number any batch in the log uses. */
export function nextSequence(batches: LogBatch[]): bigint {
  let highest = 0n;
  for (const batch of batches) {
    const decoded = decodeBatch(batch.payload);
    const end = decoded.sequence + BigInt(decoded.entries.length);
    if (end > highest) highest = end;
  }
  return highest;
}

/**
 * Wrap a payload in log records suitable for appending at `startOffset`.
 *
 * Records never straddle a block boundary, so a payload that does not fit in
 * what is left of the current block is split. When fewer than seven bytes
 * remain — too few for a header — the block is padded with zeros first, which is
 * what LevelDB itself writes and what `readLog` skips.
 */
export function frameRecords(payload: Buffer, startOffset: number): Buffer {
  const output: Buffer[] = [];
  let offset = startOffset;
  let remaining = payload;
  let isFirst = true;

  for (;;) {
    let room = BLOCK_SIZE - (offset % BLOCK_SIZE);
    if (room < HEADER_SIZE) {
      output.push(Buffer.alloc(room, 0));
      offset += room;
      room = BLOCK_SIZE;
    }

    const capacity = room - HEADER_SIZE;
    const chunk = remaining.subarray(0, Math.min(capacity, remaining.length));
    const isLast = chunk.length === remaining.length;
    const type = isFirst && isLast ? FULL : isFirst ? FIRST : isLast ? LAST : MIDDLE;

    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt16LE(chunk.length, 4);
    header[6] = type;
    header.writeUInt32LE(maskCrc(crc32c(Buffer.concat([Buffer.from([type]), chunk]))), 0);
    output.push(header, chunk);

    offset += HEADER_SIZE + chunk.length;
    remaining = remaining.subarray(chunk.length);
    isFirst = false;
    if (isLast) break;
  }

  return Buffer.concat(output);
}

/**
 * A key as it is stored inside a sorted table: the user's key with an eight-byte
 * trailer holding the sequence number and whether the entry is a put or a delete.
 */
export interface InternalKey {
  userKey: Buffer;
  sequence: bigint;
  isDelete: boolean;
}

export function splitInternalKey(key: Buffer): InternalKey {
  if (key.length < 8) throw new LevelDbFormatError('internal key is too short to carry a trailer');
  const trailer = key.readBigUInt64LE(key.length - 8);
  return {
    userKey: key.subarray(0, key.length - 8),
    sequence: trailer >> 8n,
    isDelete: (trailer & 0xffn) === 0n,
  };
}

/** offset and length of a block, as stored in a footer or an index entry. */
function readBlockHandle(
  buffer: Buffer,
  position: number,
): { offset: number; size: number; next: number } {
  const offset = decodeVarint64(buffer, position);
  const size = decodeVarint64(buffer, offset.next);
  return { offset: Number(offset.value), size: Number(size.value), next: size.next };
}

/**
 * Walk the entries of one block.
 *
 * Keys are prefix-compressed against the key before them: each entry says how
 * many leading bytes it shares with its predecessor and supplies only the rest.
 * That is why the full key of a record never appears contiguously in the file,
 * and why searching a table for one finds nothing.
 */
function eachBlockEntry(block: Buffer, visit: (key: Buffer, value: Buffer) => void): void {
  if (block.length < 4) throw new LevelDbFormatError('block is too short to hold a restart count');
  const restartCount = block.readUInt32LE(block.length - 4);
  const entriesEnd = block.length - 4 - restartCount * 4;
  if (entriesEnd < 0) throw new LevelDbFormatError('block declares more restarts than it can hold');

  let at = 0;
  let previous = Buffer.alloc(0);
  while (at < entriesEnd) {
    const shared = decodeVarint32(block, at);
    const unshared = decodeVarint32(block, shared.next);
    const valueLength = decodeVarint32(block, unshared.next);
    at = valueLength.next;

    if (shared.value > previous.length) {
      throw new LevelDbFormatError('block entry shares more bytes than the previous key has');
    }
    const key = Buffer.concat([
      previous.subarray(0, shared.value),
      block.subarray(at, at + unshared.value),
    ]);
    at += unshared.value;
    const value = block.subarray(at, at + valueLength.value);
    at += valueLength.value;

    visit(key, value);
    previous = key;
  }
}

/** LevelDB's table magic, at the very end of every sorted table. */
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const FOOTER_SIZE = 48;

function readBlock(table: Buffer, offset: number, size: number): Buffer {
  const contents = table.subarray(offset, offset + size);
  // One byte of compression type and four of checksum follow every block.
  const compression = table[offset + size];
  if (compression === 0) return contents;
  if (compression === 1) return snappyDecompress(contents);
  throw new LevelDbFormatError(
    `sorted table block uses compression type ${compression}, which foster cannot read`,
  );
}

/**
 * Visit every record in a sorted table.
 *
 * Once LevelDB folds a log into a table, the log no longer holds those records —
 * so reading only the log answers "never written" about anything the database has
 * had time to compact, which for a long-running app is nearly everything.
 */
export function scanTable(table: Buffer, visit: (entry: InternalKey, value: Buffer) => void): void {
  if (table.length < FOOTER_SIZE || !table.subarray(-8).equals(TABLE_MAGIC)) {
    throw new LevelDbFormatError('not a LevelDB sorted table: the trailing magic does not match');
  }

  const footer = table.subarray(table.length - FOOTER_SIZE);
  // The metaindex handle comes first and is stepped over; the index handle is
  // the one that names the block listing every data block.
  const metaindex = readBlockHandle(footer, 0);
  const index = readBlockHandle(footer, metaindex.next);

  eachBlockEntry(readBlock(table, index.offset, index.size), (_separator, handle) => {
    const dataBlock = readBlockHandle(handle, 0);
    eachBlockEntry(readBlock(table, dataBlock.offset, dataBlock.size), (key, value) => {
      visit(splitInternalKey(key), value);
    });
  });
}

/**
 * The log file a database is currently writing to, named by its manifest.
 *
 * Taking the highest-numbered `.log` in the directory instead would be right
 * most of the time and wrong exactly when it matters: LevelDB leaves older logs
 * in place until it decides to remove them, and appending to one that has already
 * been folded into a sorted table changes nothing that will ever be read again —
 * a write that reports success and quietly does not happen.
 */
export interface ManifestState {
  /** The log the database is writing to now. */
  logNumber?: bigint;
  /** The highest sequence number in use as of the last time state was recorded. */
  lastSequence?: bigint;
}

export function readManifest(manifest: Buffer): ManifestState {
  let logNumber: bigint | undefined;
  let lastSequence: bigint | undefined;

  for (const { payload } of readLog(manifest)) {
    let at = 0;
    while (at < payload.length) {
      let tag: Varint;
      try {
        tag = decodeVarint32(payload, at);
      } catch {
        break;
      }
      at = tag.next;

      // Tags come from db/version_edit.cc. Anything unrecognised means this
      // decoder is out of step with the file, and skipping ahead blindly would
      // read a later field as a log number.
      if (tag.value === 1 || tag.value === 5 || tag.value === 8) {
        // Comparator name, compact pointer, and (unused) a length-prefixed slice.
        if (tag.value === 5) {
          const level = decodeVarint32(payload, at);
          at = level.next;
        }
        const slice = decodeVarint32(payload, at);
        at = slice.next + slice.value;
      } else if (tag.value === 2 || tag.value === 3 || tag.value === 4 || tag.value === 9) {
        const value = decodeVarint64(payload, at);
        at = value.next;
        if (tag.value === 2) logNumber = value.value;
        if (tag.value === 4) lastSequence = value.value;
      } else if (tag.value === 6) {
        const level = decodeVarint32(payload, at);
        const number = decodeVarint64(payload, level.next);
        at = number.next;
      } else if (tag.value === 7) {
        const level = decodeVarint32(payload, at);
        const number = decodeVarint64(payload, level.next);
        const size = decodeVarint64(payload, number.next);
        at = size.next;
        for (let bound = 0; bound < 2; bound++) {
          const key = decodeVarint32(payload, at);
          at = key.next + key.value;
        }
      } else {
        break;
      }
    }
  }

  return { logNumber, lastSequence };
}
