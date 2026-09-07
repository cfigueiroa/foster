import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';

/**
 * Whether Claude Desktop's own multi-account switcher is available on this
 * installation, read from `<userData>/fcache` — the app's cache of the remote
 * feature gates it was served.
 *
 * `fcache` is not a foster format and not a documented one: it is a private
 * cache file the app writes for itself, with no schema published anywhere foster
 * can read. Every offset, magic byte and JSON shape this module assumes came
 * from ONE measurement, on one machine, on 05/09/2026 (dossier in the owner's
 * private notes) — see `FCACHE_LAYOUT` below, the one place all of it lives.
 * There is no vendor guarantee any of it survives the next app update, so this
 * reader is built to go quiet instead of wrong: anything it did not expect —
 * a short file, a missing gzip member, JSON that will not parse, a gate key
 * that is not there, a value that is not a boolean — comes back `'unknown'`,
 * never a guessed `'available'` or `'unavailable'`. `foster doctor` is the one
 * caller, and a wrong confident answer there is worse than no answer at all.
 */
export type NativeSwitcherAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * The single measurement this reader is built from. Re-verify every field here
 * after a Claude Desktop update before trusting a changed answer from it — an
 * app that reshapes any of these silently is indistinguishable, from here, from
 * one that still matches: both a real change and a misread come back as an
 * `'unknown'` line in `doctor`, and only re-measuring tells them apart.
 */
const FCACHE_LAYOUT = {
  /** Bytes before the gzip member begins. Never inspected beyond its length. */
  headerLength: 8,
  /**
   * gzip's own magic and deflate method byte (RFC 1952), checked at the offset
   * above — not a proprietary marker of the app's, just proof the header ends
   * where this reader assumes it does.
   */
  gzipMagic: [0x1f, 0x8b, 0x08],
  /**
   * Numeric id the server used for the native multi-account switcher's remote
   * feature gate on 05/09/2026. A renamed or renumbered gate is exactly the
   * drift this reader must not paper over — it reads as the key being absent,
   * which is `'unknown'`, not `'unavailable'`.
   */
  gateId: '96101707',
} as const;

/** Largest `fcache` this will read. A cache of feature gates is kilobytes; a
 * file far past that is not one, and reading it in whole would be the one way
 * this module could turn a bad guess into real memory pressure. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function fcachePath(store: StoreLayout): string {
  return path.join(store.root, 'fcache');
}

/**
 * Read whether the native switcher's gate is on, or `'unknown'` when anything
 * about the read did not go exactly as the one measurement above describes.
 *
 * Never throws: every failure this can anticipate is handled explicitly, and
 * the outer `try` exists for the ones it cannot (a `fcache` that is a
 * directory, a permissions error, anything else `readFileSync` can raise) —
 * both kinds end the same way.
 */
export function readNativeSwitcherAvailability(store: StoreLayout): NativeSwitcherAvailability {
  try {
    const file = fcachePath(store);
    const bytes = readFileSync(file);
    if (bytes.length > MAX_FILE_BYTES) return 'unknown';

    const { headerLength, gzipMagic, gateId } = FCACHE_LAYOUT;
    if (bytes.length < headerLength + gzipMagic.length) return 'unknown';
    for (let index = 0; index < gzipMagic.length; index++) {
      if (bytes[headerLength + index] !== gzipMagic[index]) return 'unknown';
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(gunzipSync(bytes.subarray(headerLength)).toString('utf8'));
    } catch {
      // Covers both a gunzip failure (a truncated or corrupted member) and a
      // decompressed body that is not valid JSON — neither tells foster
      // anything the other does not: the assumed shape did not hold.
      return 'unknown';
    }

    if (typeof parsed !== 'object' || parsed === null) return 'unknown';
    const gates = (parsed as Record<string, unknown>).gates;
    if (typeof gates !== 'object' || gates === null) return 'unknown';

    const value = (gates as Record<string, unknown>)[gateId];
    if (typeof value !== 'boolean') return 'unknown';
    return value ? 'available' : 'unavailable';
  } catch {
    return 'unknown';
  }
}
