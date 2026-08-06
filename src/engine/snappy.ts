/**
 * Snappy decompression — the raw block format, not the framed stream format.
 *
 * LevelDB compresses sorted-table blocks with Snappy by default, and Chromium's
 * IndexedDB takes the default. Reading a pinned-session list out of a database
 * that has been running long enough to compact therefore needs this, and only
 * this: foster never writes a sorted table, so the compressor is not required
 * and is not here.
 *
 * A compressed block is a varint holding the uncompressed length, followed by a
 * stream of elements. Each element begins with a tag byte whose low two bits say
 * what it is: a run of literal bytes, or a copy of bytes already produced. That
 * copies read from the output being built is what makes the format decompress in
 * one pass, and also why a copy may legitimately overlap the region it reads.
 */

export class SnappyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnappyError';
  }
}

/**
 * The largest block this will decompress. LevelDB blocks are kilobytes; a value
 * far past that is a corrupt length or a table this reader misparsed, and the
 * alloc it would trigger is a silent out-of-memory kill. 64 MB is orders of
 * magnitude above anything real and still safe to refuse rather than allocate.
 */
const MAX_OUTPUT = 64 * 1024 * 1024;

const LITERAL = 0;
const COPY_1_BYTE_OFFSET = 1;
const COPY_2_BYTE_OFFSET = 2;
const COPY_4_BYTE_OFFSET = 3;

export function snappyDecompress(input: Buffer): Buffer {
  let at = 0;

  // Preamble: the length of the output, so it can be allocated once.
  let expected = 0;
  let shift = 0;
  for (;;) {
    if (at >= input.length) throw new SnappyError('input ends inside the length preamble');
    const byte = input[at++]!;
    expected |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 32) throw new SnappyError('length preamble is not a valid varint');
  }

  // A declared length that is negative (a varint whose high bits set the sign) or
  // absurdly large is refused before it is allocated. A corrupt or misparsed
  // block can name a gigabyte, and `Buffer.alloc` of that either throws or — worse
  // — succeeds and exhausts the heap, which no caller can catch. Nothing foster
  // reads decompresses anywhere near this, so the cap only ever rejects garbage.
  if (expected < 0 || expected > MAX_OUTPUT) {
    throw new SnappyError(`declared length ${expected} is not a plausible block size`);
  }

  const output = Buffer.alloc(expected);
  let written = 0;

  const need = (count: number): void => {
    if (at + count > input.length) throw new SnappyError('input ends inside an element');
  };

  while (at < input.length) {
    const tag = input[at++]!;

    if ((tag & 0x03) === LITERAL) {
      let length = tag >> 2;
      // 60 and above mean the length is too big for the tag and follows it, in
      // as many bytes as the value above 59 says.
      if (length >= 60) {
        const extra = length - 59;
        need(extra);
        length = 0;
        for (let index = 0; index < extra; index++) length |= input[at + index]! << (index * 8);
        at += extra;
      }
      length += 1;
      need(length);
      if (written + length > expected)
        throw new SnappyError('literal runs past the declared length');
      input.copy(output, written, at, at + length);
      written += length;
      at += length;
      continue;
    }

    let length: number;
    let offset: number;
    if ((tag & 0x03) === COPY_1_BYTE_OFFSET) {
      need(1);
      length = 4 + ((tag >> 2) & 0x07);
      offset = ((tag >> 5) << 8) | input[at]!;
      at += 1;
    } else if ((tag & 0x03) === COPY_2_BYTE_OFFSET) {
      need(2);
      length = (tag >> 2) + 1;
      offset = input.readUInt16LE(at);
      at += 2;
    } else if ((tag & 0x03) === COPY_4_BYTE_OFFSET) {
      need(4);
      length = (tag >> 2) + 1;
      offset = input.readUInt32LE(at);
      at += 4;
    } else {
      throw new SnappyError(`unknown element tag ${tag}`);
    }

    if (offset === 0 || offset > written) {
      throw new SnappyError('copy refers to output that has not been produced');
    }
    if (written + length > expected) throw new SnappyError('copy runs past the declared length');

    // Byte at a time on purpose: a copy is allowed to overlap what it reads,
    // which is how the format encodes a repeating run, and a bulk move would
    // read the region before the earlier bytes of the run had been written.
    let from = written - offset;
    for (let index = 0; index < length; index++) output[written++] = output[from++]!;
  }

  if (written !== expected) {
    throw new SnappyError(`decompressed ${written} bytes where the preamble declared ${expected}`);
  }
  return output;
}
