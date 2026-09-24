import { createHash } from 'node:crypto';

/** What a canonical, lowercase, dashed uuid looks like — the only shape this format packs. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Packs a whole set of ids into one 16-bytes-per-id buffer, validating and
 * converting every id in a single pass — `undefined` the moment one does not
 * pack (a canonical, lowercase, dashed uuid is the only shape that does;
 * nothing real writes anything else), the same "skip this file's entry"
 * signal a validate-then-convert pair of passes gave.
 *
 * `transcriptCache.ts` used to build this one id at a time — a small
 * `uuidToBytes(id)` `Buffer` allocated per id, each pushed as its own
 * `ByteWriter.raw` chunk. Profiled 24/09/2026 on a warm sweep of a real store
 * (tens of thousands of transcripts, most holding hundreds of records): that
 * turned every `save()` into millions of tiny allocations, one pair per id
 * across *every* cached entry, not only the handful a warm run actually
 * rescanned — warm ran slower than `--no-cache`, which pays for none of this.
 * Packing straight into one pre-sized buffer per file turns that into one
 * allocation per *file*; `TranscriptCache.save()` also now reuses the exact
 * bytes a loaded entry was never asked to change, skipping this function for
 * it entirely (see `ScanEntry.packedUuids`).
 */
export function packUuidSet(ids: ReadonlySet<string>): Buffer | undefined {
  const buf = Buffer.alloc(ids.size * 16);
  let offset = 0;
  for (const id of ids) {
    if (!CANONICAL_UUID.test(id)) return undefined;
    buf.write(id.replace(/-/g, ''), offset, 16, 'hex');
    offset += 16;
  }
  return buf;
}

/** Hex digit for each nibble value, built once — `HEX_DIGIT[b]` is `b`'s low nibble as a char code. */
const HEX_DIGIT = (() => {
  const table = new Array<number>(16);
  for (let n = 0; n < 16; n += 1) table[n] = '0123456789abcdef'.charCodeAt(n);
  return table;
})();
const DASH = 0x2d;

/**
 * A reused scratch buffer for the 36 character codes of one dashed uuid —
 * the same technique `detachedSlice` (`store/transcripts.ts`) uses: filled
 * and read immediately, never retained, so one array serves every id a call
 * decodes instead of allocating a fresh one per id.
 */
const uuidChars: number[] = new Array<number>(36).fill(0);

/**
 * One id, read straight from `buf`'s bytes into the dashed spelling, without
 * `Buffer.toString('hex', …)` plus four `String.slice` calls plus a template
 * literal — six short-lived strings this codebase already measured as the
 * expensive way to build one of these (`detachedSlice`'s own doc comment).
 * `String.fromCharCode` over the reused `uuidChars` copies once, the same
 * trade that comment describes.
 */
function idAt(buf: Buffer, start: number): string {
  let at = 0;
  for (let byteIndex = 0; byteIndex < 16; byteIndex += 1) {
    const byte = buf[start + byteIndex]!;
    uuidChars[at++] = HEX_DIGIT[byte >> 4]!;
    uuidChars[at++] = HEX_DIGIT[byte & 0xf]!;
    if (byteIndex === 3 || byteIndex === 5 || byteIndex === 7 || byteIndex === 9)
      uuidChars[at++] = DASH;
  }
  return String.fromCharCode(...uuidChars);
}

/**
 * The reverse of `packUuidSet`: `count` ids read back out of `buf` starting
 * at `at`, without `ByteReader.raw`'s defensive per-id copy — `idAt` reads
 * straight from `buf`, so there is nothing to detach a copy from — and
 * without the six-allocations-per-id cost `bytesToUuid` pays when it is
 * called this many times in a row (see `idAt`'s own doc). Profiled
 * 24/09/2026 on a warm run over ~2.4M ids: this was 8% of the run's own time
 * before `idAt`, on top of the garbage-collector time all those short-lived
 * strings caused — reading is the far more common case (`save()` is skipped
 * whenever nothing changed; a load never is), so this is the one the count
 * matters for.
 */
export function unpackUuidSet(buf: Buffer, at: number, count: number): Set<string> {
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    ids.add(idAt(buf, at + index * 16));
  }
  return ids;
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

  /**
   * A *view* of `len` bytes, still backed by the source buffer — no copy.
   * Only safe for a caller that outlives the source buffer's own owner and
   * never mutates it, which a cache load is: `TranscriptCache.ensureLoaded`
   * keeps the whole decoded file resident as long as the cache instance
   * lives, and nothing here writes back into it.
   */
  rawView(len: number): Buffer {
    const v = this.buf.subarray(this.at, this.at + len);
    this.at += len;
    return v;
  }
}
