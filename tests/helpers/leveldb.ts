import { encodeVarint32 } from '../../src/store/format/leveldb.js';

/**
 * Builds LevelDB sorted tables for tests.
 *
 * foster never writes one — it only ever appends to a log — so this lives here
 * rather than in the source. Written from the format description so that the
 * reader is checked against the specification rather than against itself.
 */

/**
 * Reference implementations of the log format, deliberately *not* built on the
 * source's own encoders.
 *
 * The framing, write-batch and variable-length-integer encoders are otherwise
 * exercised only by round-tripping through themselves: a symmetric bug (an
 * encoder and decoder that agree on the wrong bytes) would pass every such test
 * while corrupting a real Claude Desktop database. These are written straight
 * from db/log_format.h and db/write_batch.cc with different structure (a
 * bit-by-bit checksum, byte-at-a-time varints, a hand-rolled batch builder), so
 * two independent readings of the same specification have to agree. Combined
 * with the published crc32c check vector in leveldb.test.ts, a wrong answer on
 * either side is caught.
 */

/** crc32c, Castagnoli, computed a bit at a time with no table at all. */
export function referenceCrc32c(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    let c = (crc ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? ((c >>> 1) ^ 0x82f63b78) >>> 0 : c >>> 1;
    crc = c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The masked form LevelDB rotates an offset checksum into. */
export function referenceMask(crc: number): number {
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

/** A 32-bit varint, written one byte at a time by hand. */
export function referenceVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value >>> 0;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** A write batch, built independently of encodeBatch. */
export function referenceBatch(
  sequence: bigint,
  entries: { key: Buffer; value?: Buffer }[],
): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(sequence, 0);
  header.writeUInt32LE(entries.length, 8);

  const bytes: number[] = [...header];
  for (const entry of entries) {
    bytes.push(entry.value === undefined ? 0 : 1);
    bytes.push(...referenceVarint(entry.key.length), ...entry.key);
    if (entry.value !== undefined) {
      bytes.push(...referenceVarint(entry.value.length), ...entry.value);
    }
  }
  return Buffer.from(bytes);
}

/** Log records wrapping a payload, built independently of frameRecords. */
export function referenceFrame(payload: Buffer, startOffset: number): Buffer {
  const BLOCK = 32_768;
  const HEADER = 7;
  const out: Buffer[] = [];
  let offset = startOffset;
  let remaining = payload;
  let first = true;

  for (;;) {
    let room = BLOCK - (offset % BLOCK);
    if (room < HEADER) {
      out.push(Buffer.alloc(room, 0));
      offset += room;
      room = BLOCK;
    }
    const capacity = room - HEADER;
    const chunk = remaining.subarray(0, Math.min(capacity, remaining.length));
    const last = chunk.length === remaining.length;
    const type = first && last ? 1 : first ? 2 : last ? 4 : 3;

    const header = Buffer.alloc(HEADER);
    header.writeUInt16LE(chunk.length, 4);
    header[6] = type;
    header.writeUInt32LE(
      referenceMask(referenceCrc32c(Buffer.concat([Buffer.from([type]), chunk]))),
      0,
    );
    out.push(header, chunk);

    offset += HEADER + chunk.length;
    remaining = remaining.subarray(chunk.length);
    first = false;
    if (last) break;
  }
  return Buffer.concat(out);
}

const MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const FOOTER_SIZE = 48;

export function internalKey(userKey: Buffer, sequence: bigint, isDelete = false): Buffer {
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64LE((sequence << 8n) | (isDelete ? 0n : 1n));
  return Buffer.concat([userKey, trailer]);
}

/** One block, with keys prefix-compressed against their predecessor as LevelDB does. */
export function makeBlock(entries: [Buffer, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);

  for (const [key, value] of entries) {
    let shared = 0;
    const limit = Math.min(previous.length, key.length);
    while (shared < limit && previous[shared] === key[shared]) shared++;
    parts.push(
      encodeVarint32(shared),
      encodeVarint32(key.length - shared),
      encodeVarint32(value.length),
      key.subarray(shared),
      value,
    );
    previous = key;
  }

  // A single restart point at the start, then the restart count.
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(0, 0);
  restarts.writeUInt32LE(1, 4);
  return Buffer.concat([...parts, restarts]);
}

/**
 * A literal-only Snappy stream. Valid output for any input — the format does not
 * require a compressor to find any matches — which is what makes it a usable
 * stand-in without shipping one.
 */
export function literalSnappy(raw: Buffer): Buffer {
  const header: number[] = [];
  let length = raw.length;
  while (length >= 0x80) {
    header.push((length & 0x7f) | 0x80);
    length >>>= 7;
  }
  header.push(length);

  const lengthMinusOne = raw.length - 1;
  const tag =
    lengthMinusOne < 60
      ? [lengthMinusOne << 2]
      : [61 << 2, lengthMinusOne & 0xff, (lengthMinusOne >> 8) & 0xff];

  return Buffer.concat([Buffer.from(header), Buffer.from(tag), raw]);
}

function handle(offset: number, size: number): Buffer {
  return Buffer.concat([encodeVarint32(offset), encodeVarint32(size)]);
}

function withTrailer(block: Buffer, compression: number): Buffer {
  // One byte of compression type, four of checksum.
  return Buffer.concat([block, Buffer.from([compression]), Buffer.alloc(4)]);
}

export function makeTable(records: [Buffer, Buffer][], { compress = false } = {}): Buffer {
  const dataBlock = compress ? literalSnappy(makeBlock(records)) : makeBlock(records);
  const chunks: Buffer[] = [withTrailer(dataBlock, compress ? 1 : 0)];
  const dataHandle = handle(0, dataBlock.length);
  let offset = chunks[0]!.length;

  const metaindex = makeBlock([]);
  const metaindexHandle = handle(offset, metaindex.length);
  chunks.push(withTrailer(metaindex, 0));
  offset += metaindex.length + 5;

  // The index block maps a separator key to the block holding everything up to it.
  const index = makeBlock([[Buffer.from([0xff]), dataHandle]]);
  const indexHandle = handle(offset, index.length);
  chunks.push(withTrailer(index, 0));

  const handles = Buffer.concat([metaindexHandle, indexHandle]);
  const footer = Buffer.concat([handles, Buffer.alloc(FOOTER_SIZE - 8 - handles.length), MAGIC]);
  return Buffer.concat([...chunks, footer]);
}
