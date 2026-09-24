import { createHash } from 'node:crypto';

/**
 * The compact form the cache stores a record id in: 16 bytes instead of the
 * 36-character string the transcripts spell it as. Only a canonical, lowercase
 * uuid packs — see `uuidToBytes`; anything else means that file's entry is
 * skipped at save time (`transcriptCache.ts`) rather than corrupting the
 * format or silently losing an id.
 */
export function uuidToBytes(uuid: string): Buffer | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid))
    return undefined;
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** The reverse of `uuidToBytes`, reading 16 bytes back into the dashed spelling. */
export function bytesToUuid(buf: Buffer): string {
  const hex = buf.toString('hex', 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A short, fixed-size fingerprint of a byte range — used to tell whether the
 * bytes a transcript's cache entry was built against are still there before
 * trusting an incremental resume over them. Not cryptographic; a JSONL log
 * changing by accident in exactly the way this misses is not a threat this
 * guards against, only corruption.
 */
export function shortHash(buf: Buffer): Buffer {
  return createHash('sha1').update(buf).digest().subarray(0, 16);
}

/** A growing byte buffer, for building a binary file without knowing its size up front. */
export class ByteWriter {
  private readonly chunks: Buffer[] = [];
  private len = 0;

  u8(value: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(value & 0xff, 0);
    return this.raw(b);
  }

  u32(value: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    return this.raw(b);
  }

  f64(value: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value, 0);
    return this.raw(b);
  }

  /** Length-prefixed utf8 text. */
  str(value: string): this {
    const b = Buffer.from(value, 'utf8');
    this.u32(b.length);
    return this.raw(b);
  }

  raw(buf: Buffer): this {
    this.chunks.push(buf);
    this.len += buf.length;
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.len);
  }
}

/**
 * A sequential reader over a buffer already in memory, the mirror of
 * `ByteWriter`. Read past the end and node throws `RangeError` — deliberately
 * left uncaught here, because every caller reading a cache file wraps the
 * whole parse in one try/catch and treats any failure as "ignore and rebuild"
 * (`cardCache.ts`, `transcriptCache.ts`), which is the same answer a bounds
 * check would have given.
 */
export class ByteReader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.at;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.at);
    this.at += 1;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }

  f64(): number {
    const v = this.buf.readDoubleLE(this.at);
    this.at += 8;
    return v;
  }

  str(): string {
    const len = this.u32();
    const v = this.buf.toString('utf8', this.at, this.at + len);
    this.at += len;
    return v;
  }

  /** A copy of `len` bytes — detached from the source buffer, unlike `subarray`. */
  raw(len: number): Buffer {
    const v = Buffer.from(this.buf.subarray(this.at, this.at + len));
    this.at += len;
    return v;
  }
}
