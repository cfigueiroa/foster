import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZE,
  HEADER_SIZE,
  LAST,
  LevelDbFormatError,
  crc32c,
  decodeBatch,
  decodeVarint32,
  decodeVarint64,
  encodeBatch,
  encodeVarint32,
  frameRecords,
  maskCrc,
  nextSequence,
  readLog,
  scanTable,
  splitInternalKey,
  unmaskCrc,
} from '../src/store/format/leveldb.js';
import {
  internalKey,
  makeTable,
  referenceBatch,
  referenceCrc32c,
  referenceFrame,
  referenceMask,
  referenceVarint,
} from './helpers/leveldb.js';

/**
 * The format has no second implementation to check against, so a round trip
 * through foster's own encoder would only prove it agrees with itself. The
 * checksum vector and the block arithmetic below are the anchors: both come from
 * outside this code, and a wrong answer to either produces records that look
 * well-formed and that LevelDB throws away on the next open.
 */
describe('leveldb log format', () => {
  it('computes crc32c, not the CRC-32 used by zip', () => {
    // The published check value for the Castagnoli polynomial.
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
    // CRC-32 answers 0xcbf43926 for the same input; landing on it means the
    // wrong polynomial was used and every record written would be rejected.
    expect(crc32c(Buffer.from('123456789'))).not.toBe(0xcbf43926);
  });

  it('masks checksums reversibly, and does not store them raw', () => {
    for (const value of [0, 1, 0x7fffffff, 0xe3069283, 0xffffffff]) {
      expect(unmaskCrc(maskCrc(value))).toBe(value);
      if (value !== 0) expect(maskCrc(value)).not.toBe(value);
    }
  });

  it('round-trips varints, including values a 32-bit reader would truncate', () => {
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 874, 0x7fffffff]) {
      expect(decodeVarint32(encodeVarint32(value), 0).value).toBe(value);
    }
    // Sequence and file numbers are 64-bit; reading one as 32 bits is how a
    // long-lived database starts naming the wrong log file.
    const big = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    expect(decodeVarint64(big, 0).value).toBe(0xf_ffff_ffffn);
    expect(() => decodeVarint32(big, 0)).toThrow(/32-bit/);
  });

  it('round-trips a batch of puts and deletes', () => {
    const entries = [
      { key: Buffer.from('alpha'), value: Buffer.from('one') },
      { key: Buffer.from('beta') },
      { key: Buffer.from('gamma'), value: Buffer.alloc(0) },
    ];
    const decoded = decodeBatch(encodeBatch(42n, entries));

    expect(decoded.sequence).toBe(42n);
    expect(decoded.entries).toHaveLength(3);
    expect(decoded.entries[0]!.value?.toString()).toBe('one');
    // A delete carries no value at all, which is what distinguishes it from a
    // put of the empty string sitting right after it.
    expect(decoded.entries[1]!.value).toBeUndefined();
    expect(decoded.entries[2]!.value?.length).toBe(0);
  });

  it('frames a small payload as one record and reads it back', () => {
    const payload = encodeBatch(7n, [{ key: Buffer.from('k'), value: Buffer.from('v') }]);
    const batches = readLog(frameRecords(payload, 0));

    expect(batches).toHaveLength(1);
    expect(batches[0]!.payload.equals(payload)).toBe(true);
  });

  it('splits a payload too long for one block and reassembles it', () => {
    const payload = encodeBatch(1n, [
      { key: Buffer.from('big'), value: Buffer.alloc(BLOCK_SIZE * 2 + 500, 0x61) },
    ]);
    const framed = frameRecords(payload, 0);

    // More than one physical record, but still exactly one logical batch.
    expect(framed.length).toBeGreaterThan(BLOCK_SIZE * 2);
    const batches = readLog(framed);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.payload.equals(payload)).toBe(true);
    expect(decodeBatch(batches[0]!.payload).entries[0]!.value!.length).toBe(BLOCK_SIZE * 2 + 500);
  });

  it('pads rather than starting a header that would straddle a block boundary', () => {
    // Four bytes left in the block: too few for the seven-byte header.
    const start = BLOCK_SIZE - 4;
    const payload = encodeBatch(3n, [{ key: Buffer.from('k'), value: Buffer.from('v') }]);
    const framed = frameRecords(payload, start);

    expect(framed.subarray(0, 4).equals(Buffer.alloc(4, 0))).toBe(true);
    // Reading needs the padding in place, so the file is reconstructed as it
    // would exist on disk rather than as the appended fragment alone.
    const file = Buffer.concat([Buffer.alloc(start, 0), framed]);
    const batches = readLog(file);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.payload.equals(payload)).toBe(true);
  });

  it('appends after an existing log without disturbing what is there', () => {
    const first = frameRecords(
      encodeBatch(1n, [{ key: Buffer.from('a'), value: Buffer.from('1') }]),
      0,
    );
    const second = frameRecords(
      encodeBatch(2n, [{ key: Buffer.from('a'), value: Buffer.from('2') }]),
      first.length,
    );
    const file = Buffer.concat([first, second]);

    const batches = readLog(file);
    expect(batches).toHaveLength(2);
    // Later wins on replay, which is the whole basis for appending rather than
    // rewriting: the earlier record is still there and still valid.
    expect(decodeBatch(batches[0]!.payload).entries[0]!.value?.toString()).toBe('1');
    expect(decodeBatch(batches[1]!.payload).entries[0]!.value?.toString()).toBe('2');
    expect(file.subarray(0, first.length).equals(first)).toBe(true);
  });

  it('refuses a log whose checksum does not match', () => {
    const framed = frameRecords(
      encodeBatch(1n, [{ key: Buffer.from('k'), value: Buffer.from('v') }]),
      0,
    );
    const damaged = Buffer.from(framed);
    damaged.writeUInt8(damaged.readUInt8(HEADER_SIZE + 2) ^ 0xff, HEADER_SIZE + 2);

    // Fatal on purpose: this is read to decide what to append to, and appending
    // to an already-damaged log turns a recoverable database into a lost one.
    expect(() => readLog(damaged)).toThrow(LevelDbFormatError);
  });

  it('keeps the records before the damage when the caller only means to look', () => {
    const good = frameRecords(
      encodeBatch(1n, [{ key: Buffer.from('a'), value: Buffer.from('1') }]),
      0,
    );
    const torn = frameRecords(
      encodeBatch(2n, [{ key: Buffer.from('a'), value: Buffer.from('2') }]),
      good.length,
    );
    // The second record cut short, as any kill during a write leaves it.
    const file = Buffer.concat([good, torn.subarray(0, torn.length - 4)]);

    expect(() => readLog(file)).toThrow(LevelDbFormatError);
    const batches = readLog(file, { tolerant: true });
    expect(batches).toHaveLength(1);
    expect(decodeBatch(batches[0]!.payload).entries[0]!.value?.toString()).toBe('1');
  });

  it('says what a tolerant read gave up on, rather than silently reading less', () => {
    const good = frameRecords(
      encodeBatch(1n, [{ key: Buffer.from('a'), value: Buffer.from('1') }]),
      0,
    );
    const torn = frameRecords(
      encodeBatch(2n, [{ key: Buffer.from('a'), value: Buffer.from('2') }]),
      good.length,
    );
    const file = Buffer.concat([good, torn.subarray(0, torn.length - 4)]);

    const notices: string[] = [];
    const batches = readLog(file, { tolerant: true, onNotice: (m) => notices.push(m) });
    // The intact record is still read, and the caller is told the tail was lost.
    expect(batches).toHaveLength(1);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.join(' ')).toMatch(/offset/);
  });

  it('reports a record fragment it cannot join to a beginning', () => {
    // A file that starts mid-record: a single LAST fragment with no FIRST before
    // it, as a log truncated at the front would leave. Its beginning is gone, so
    // it cannot be rebuilt — but the tolerant read should say so, not swallow it.
    const data = Buffer.from('ab');
    const header = Buffer.alloc(HEADER_SIZE);
    header[6] = LAST; // a stray closing fragment with no FIRST
    header.writeUInt16LE(data.length, 4);
    header.writeUInt32LE(maskCrc(crc32c(Buffer.concat([Buffer.from([LAST]), data]))), 0);
    const file = Buffer.concat([header, data]);

    const notices: string[] = [];
    const batches = readLog(file, { tolerant: true, onNotice: (m) => notices.push(m) });
    expect(batches).toHaveLength(0);
    expect(notices.some((message) => /no beginning/.test(message))).toBe(true);
  });

  it('splits an internal key into its user key, sequence and kind', () => {
    const key = internalKey(Buffer.from('user'), 1234n);
    const split = splitInternalKey(key);

    expect(split.userKey.toString()).toBe('user');
    expect(split.sequence).toBe(1234n);
    expect(split.isDelete).toBe(false);
    expect(splitInternalKey(internalKey(Buffer.from('user'), 9n, true)).isDelete).toBe(true);
  });

  it('reports the sequence a new batch may safely use', () => {
    const file = Buffer.concat([
      frameRecords(
        encodeBatch(10n, [
          { key: Buffer.from('a'), value: Buffer.from('1') },
          { key: Buffer.from('b'), value: Buffer.from('2') },
        ]),
        0,
      ),
    ]);
    // Two entries starting at 10 consume 10 and 11, so the next free one is 12.
    expect(nextSequence(readLog(file))).toBe(12n);
  });
});

/**
 * Once a log is folded into a sorted table the log no longer holds those
 * records, so a reader that only knows about logs reports "never written" about
 * anything a database has had time to compact.
 */
describe('leveldb sorted tables', () => {
  const record = (key: string, sequence: bigint, value: string): [Buffer, Buffer] => [
    internalKey(Buffer.from(key), sequence),
    Buffer.from(value),
  ];

  it('reads records back out of a table', () => {
    const table = makeTable([record('alpha', 10n, 'one'), record('beta', 11n, 'two')]);
    const seen: [string, bigint, string][] = [];
    scanTable(table, (entry, value) => {
      seen.push([entry.userKey.toString(), entry.sequence, value.toString()]);
    });

    expect(seen).toEqual([
      ['alpha', 10n, 'one'],
      ['beta', 11n, 'two'],
    ]);
  });

  it('reconstructs keys that share a prefix with the key before them', () => {
    const table = makeTable([
      record('store:pin-state:one', 1n, 'a'),
      record('store:pin-state:two', 2n, 'b'),
    ]);

    // The second key is never written out in full, which is exactly why looking
    // for a key by searching the file for its bytes finds nothing.
    expect(table.includes(Buffer.from('store:pin-state:two'))).toBe(false);

    const keys: string[] = [];
    scanTable(table, (entry) => keys.push(entry.userKey.toString()));
    expect(keys).toEqual(['store:pin-state:one', 'store:pin-state:two']);
  });

  it('reads a table whose blocks are compressed', () => {
    const table = makeTable([record('alpha', 5n, 'compressed')], { compress: true });
    const seen: string[] = [];
    scanTable(table, (_entry, value) => seen.push(value.toString()));
    expect(seen).toEqual(['compressed']);
  });

  it('reports a deletion as such rather than as a value', () => {
    const table = makeTable([[internalKey(Buffer.from('gone'), 12n, true), Buffer.alloc(0)]]);
    const seen: boolean[] = [];
    scanTable(table, (entry) => seen.push(entry.isDelete));
    expect(seen).toEqual([true]);
  });

  it('refuses a file that is not a sorted table', () => {
    expect(() => scanTable(Buffer.alloc(64), () => {})).toThrow(LevelDbFormatError);
  });
});

/**
 * The encoders are checked against independent reimplementations written from
 * the specification, so that a symmetric bug — an encoder and decoder that
 * agree on the wrong bytes — cannot pass by round-tripping through itself.
 */
describe('leveldb encoders against independent reference implementations', () => {
  it('computes the same crc32c as a table-less bit-by-bit implementation', () => {
    // The published check value anchors the reference itself.
    expect(referenceCrc32c(Buffer.from('123456789'))).toBe(0xe3069283);

    const buffers = [
      Buffer.from(''),
      Buffer.from('a'),
      Buffer.from('hello world'),
      Buffer.from('idb_cmp1'),
      Buffer.from([0, 1, 2, 3, 0xff, 0x80]),
      Buffer.alloc(900, 0x5a),
    ];
    for (const buffer of buffers) expect(crc32c(buffer)).toBe(referenceCrc32c(buffer));
  });

  it('masks checksums the same way the reference does', () => {
    for (const value of [0, 1, 0xe3069283, 0xffffffff, 123_456_789]) {
      expect(maskCrc(value)).toBe(referenceMask(value));
      expect(unmaskCrc(maskCrc(value))).toBe(value);
    }
  });

  it('encodes varints the same way the reference does', () => {
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 0x7fffffff]) {
      expect(encodeVarint32(value).equals(referenceVarint(value))).toBe(true);
      // And either encoding decodes back to the value.
      expect(decodeVarint32(referenceVarint(value), 0).value).toBe(value);
    }
  });

  it('builds write batches the same bytes the reference does', () => {
    const entries = [
      { key: Buffer.from('alpha'), value: Buffer.from('one') },
      { key: Buffer.from('beta') },
      { key: Buffer.from('gamma'), value: Buffer.alloc(0) },
    ];
    expect(encodeBatch(42n, entries).equals(referenceBatch(42n, entries))).toBe(true);
    // And foster's decoder reads the reference's bytes.
    expect(decodeBatch(referenceBatch(42n, entries)).sequence).toBe(42n);
  });

  it('frames payloads to the same bytes the reference does', () => {
    const small = referenceBatch(7n, [{ key: Buffer.from('k'), value: Buffer.from('v') }]);
    expect(frameRecords(small, 0).equals(referenceFrame(small, 0))).toBe(true);

    // A payload too long for one block splits into FIRST/MIDDLE/LAST records.
    // Both encoders must agree on where the boundaries land.
    const big = referenceBatch(1n, [
      { key: Buffer.from('big'), value: Buffer.alloc(BLOCK_SIZE * 2 + 500, 0x61) },
    ]);
    expect(frameRecords(big, 0).equals(referenceFrame(big, 0))).toBe(true);
    expect(readLog(frameRecords(big, 0))).toHaveLength(1);
    expect(decodeBatch(readLog(frameRecords(big, 0))[0]!.payload).entries[0]!.key.toString()).toBe(
      'big',
    );

    // A non-zero start offset, which is what an appending write looks like: the
    // frame is laid out for the tail of an existing log and only makes sense once
    // prepended to it. The two encoders must agree on the padding before a record
    // crosses a block boundary.
    const start = BLOCK_SIZE - 3; // leaves fewer than seven bytes in the first block
    expect(frameRecords(small, start).equals(referenceFrame(small, start))).toBe(true);
    // And, read together with the block it attaches to, the wrapped frame is
    // recovered as one untorn record.
    const file = Buffer.concat([Buffer.alloc(start, 0), referenceFrame(small, start)]);
    expect(readLog(file)).toHaveLength(1);
    expect(decodeBatch(readLog(file)[0]!.payload).sequence).toBe(7n);
  });
});
