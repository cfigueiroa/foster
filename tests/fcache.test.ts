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

/**
 * An `fcache` shaped the way the measurement this reader is built from
 * describes: an 8-byte header, then a gzip member holding
 * `{ timestamp, mode, features }`, where each feature is an object carrying
 * `value` rather than a bare boolean.
 */
function fcacheBytes(features: Record<string, unknown>): Buffer {
  return Buffer.concat([HEADER, gzipSync(JSON.stringify({ timestamp: 0, mode: '1p', features }))]);
}

/** One gate as the file holds it: the answer in `value`, with the siblings that
 * say how the server got there sitting beside it and being ignored. */
function gate(value: unknown): Record<string, unknown> {
  return { value, on: false, off: false, source: 'defaultValue', ruleId: 'r' };
}

beforeEach(() => {
  store = makeStore();
});

describe('readNativeSwitcherAvailability', () => {
  it('is "available" when the gate is present and true', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: gate(true) }));
    expect(readNativeSwitcherAvailability(store)).toBe('available');
  });

  it('is "unavailable" when the gate is present and false', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: gate(false) }));
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
    const good = fcacheBytes({ [GATE_ID]: gate(true) });
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

  it('is "unknown" when the JSON has no features object at all', () => {
    writeFcache(Buffer.concat([HEADER, gzipSync(JSON.stringify({ other: 'stuff' }))]));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  /**
   * #77. A gate that is not in the cache is a fact about the cache; a file the
   * reader can no longer parse is a fact about the reader. Both were `unknown`,
   * which made an app update indistinguishable from an ordinary Tuesday —
   * measured on a real installation where 323 gates read fine and this one was
   * simply not among them.
   */
  it('is "not-cached" when the shape held and the gate is not among the features', () => {
    writeFcache(fcacheBytes({ 'some-other-gate': gate(true) }));
    expect(readNativeSwitcherAvailability(store)).toBe('not-cached');
  });

  it('is still "unknown" when the features object itself is missing', () => {
    // The distinction only makes sense once the shape held. Without `features`
    // there is nothing to be absent from.
    writeFcache(Buffer.concat([HEADER, gzipSync(JSON.stringify({ timestamp: 1 }))]));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gate value is not a boolean', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: gate('true') }));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gate is a bare boolean rather than an object', () => {
    // The shape a single early measurement assumed, before the file was read
    // again: a map of bare booleans. Reading one now is proof the format moved,
    // which is exactly what must not be answered with a confident yes.
    writeFcache(fcacheBytes({ [GATE_ID]: true }));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('is "unknown" when the gate object carries no value at all', () => {
    writeFcache(fcacheBytes({ [GATE_ID]: { on: true, source: 'force' } }));
    expect(readNativeSwitcherAvailability(store)).toBe('unknown');
  });

  it('never throws, even on a file that is not a normal file at all', () => {
    // Nothing this reader does may escape as an exception — doctor calls it
    // unconditionally, and a throw there would be worse than any "unknown".
    expect(() => readNativeSwitcherAvailability(store)).not.toThrow();
  });
});
