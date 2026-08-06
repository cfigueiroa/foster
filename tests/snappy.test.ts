import { describe, expect, it } from 'vitest';
import { SnappyError, snappyDecompress } from '../src/engine/snappy.js';

/**
 * The vectors here are written by hand from the format description rather than
 * produced by a compressor, which is the point: a round trip against foster's
 * own encoder would prove nothing, and foster has no encoder to round-trip
 * against. Each one exercises a different element type.
 */
describe('snappy', () => {
  it('reads a run of literal bytes', () => {
    // Length 5, then a literal element of five bytes: (5-1) << 2 == 16.
    const input = Buffer.from([5, 16, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(snappyDecompress(input).toString()).toBe('hello');
  });

  it('reads a copy with a two-byte offset', () => {
    // "abc" as a literal, then six bytes copied from three back.
    const input = Buffer.from([9, 8, 0x61, 0x62, 0x63, ((6 - 1) << 2) | 2, 3, 0]);
    expect(snappyDecompress(input).toString()).toBe('abcabcabc');
  });

  it('reads a copy with a one-byte offset', () => {
    // This form always copies at least four bytes, so three literals plus one
    // copy produce seven — the copy runs one character into a repeat.
    const length = 4;
    const offset = 3;
    const tag = ((offset >> 8) << 5) | ((length - 4) << 2) | 1;
    const input = Buffer.from([7, 8, 0x78, 0x79, 0x7a, tag, offset & 0xff]);
    expect(snappyDecompress(input).toString()).toBe('xyzxyzx');
  });

  it('lets a copy overlap what it is reading, which is how runs are encoded', () => {
    // One literal byte, then ten bytes copied from one back: the copy consumes
    // bytes it is itself producing. Moving the region in bulk would read zeros.
    const input = Buffer.from([11, 0, 0x61, ((10 - 1) << 2) | 2, 1, 0]);
    expect(snappyDecompress(input).toString()).toBe('a'.repeat(11));
  });

  it('reads a literal whose length does not fit in the tag', () => {
    const body = Buffer.alloc(300, 0x7a);
    // Tag 61 means the length-1 follows in two little-endian bytes.
    const header = Buffer.from([0xac, 0x02, (61 << 2) | 0, (300 - 1) & 0xff, (300 - 1) >> 8]);
    expect(snappyDecompress(Buffer.concat([header, body])).length).toBe(300);
  });

  it('refuses a stream that does not produce what it promised', () => {
    // Declares nine bytes, supplies five.
    expect(() => snappyDecompress(Buffer.from([9, 16, 0x68, 0x65, 0x6c, 0x6c, 0x6f]))).toThrow(
      SnappyError,
    );
    // A copy reaching back further than anything written yet.
    expect(() => snappyDecompress(Buffer.from([4, ((4 - 1) << 2) | 2, 9, 0]))).toThrow(
      /has not been produced/,
    );
  });

  it('refuses an implausibly large declared length instead of allocating it', () => {
    // A misparsed or corrupt block can name a gigabyte; allocating it is a silent
    // out-of-memory kill, so the length is rejected before the buffer is made.
    // 0xffffffff0f as a varint decodes to a length beyond the cap.
    const bomb = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00]);
    expect(() => snappyDecompress(bomb)).toThrow(SnappyError);
    expect(() => snappyDecompress(bomb)).toThrow(/plausible block size/);
  });
});
