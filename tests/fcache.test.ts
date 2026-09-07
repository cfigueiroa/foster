import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { fcachePath, readNativeSwitcherAvailability } from '../src/store/fcache.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore } from './helpers/store.js';

/** The gate id `fcache.ts` looks for — kept in step with the module under test
 * rather than re-typed, so a rename there fails this file loudly instead of
 * leaving it passing against a key nothing reads any more. */
const GATE_ID = '96101707';
const HEADER = Buffer.alloc(8, 0);

let store: StoreLayout;

/** Writes bytes to the fixture's own `fcache`, the way the app would. */
function writeFcache(bytes: Buffer): void {
  writeFileSync(fcachePath(store), bytes);
}

/** An `fcache` shaped the way the one measurement this reader is built from
 * describes: an 8-byte header, then a gzip member holding `{ gates: {...} }`. */
function fcacheBytes(gates: Record<string, unknown>): Buffer {
  return Buffer.concat([HEADER, gzipSync(JSON.stringify({ gates }))]);
}

beforeEach(() => {
  store = makeStore();
});

describe('readNativeSwitcherAvailability', () => {
  it('is "available" when the gate is present and true', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: true }));
    expect(readNativeSwitcherAvailability(store)).toBe('available');
  });

  it('is "unavailable" when the gate is present and false', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: false }));
    expect(readNativeSwitcherAvailability(store)).toBe('unavailable');
  });

  it('is "unknown" when there is no fcache at all', () => {
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" for a header shorter than the reader expects', () => {
    // Three bytes total: nowhere near the 8-byte header plus the gzip magic
    // that has to follow it, so this must fail before ever touching zlib.
    writeFcache(Buffer.from([0x00, 0x01, 0x02]));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the bytes after the header are not a gzip member', () => {
    // Right length, wrong magic — a header that grew by a byte on some future
    // app version would look exactly like this until re-measured.
    writeFcache(Buffer.concat([HEADER, Buffer.from([0xff, 0xff, 0xff, 0xff])]));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gzip member is corrupt', () => {
    const good = fcacheBytes({ [GATE_ID]: true });
    // Keep the gzip magic (so the header check passes) but mangle the member
    // that follows it, which is what a torn write leaves behind.
    const corrupt = Buffer.from(good);
    corrupt.fill(0, 12, corrupt.length - 4);
    writeFcache(corrupt);
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the decompressed body is not valid JSON', () => {
    writeFcache(Buffer.concat([HEADER, gzipSync('not json at all')]));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the JSON has no gates object at all', () => {
    writeFcache(Buffer.concat([HEADER, gzipSync(JSON.stringify({ other: 'stuff' }))]));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gate key is absent from the gates object', () => {
    writeFcache(fcacheBytes({ 'some-other-gate': true }));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gate value is not a boolean', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: 'true' }));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gate value is an object rather than a boolean', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: { value: true } }));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('never throws, even on a file that is not a normal file at all', () => {
    // Nothing this reader does may escape as an exception — doctor calls it
    // unconditionally, and a throw there would be worse than any "unknown".
    expect(() => readNativeSwitcherAvailability(store)).not.toThrow();
  });
});
