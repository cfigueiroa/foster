import { encodeVarint32 } from '../../src/engine/leveldb.js';

/**
 * Builds LevelDB sorted tables for tests.
 *
 * foster never writes one — it only ever appends to a log — so this lives here
 * rather than in the source. Written from the format description so that the
 * reader is checked against the specification rather than against itself.
 */

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
