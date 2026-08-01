import { describe, expect, it } from 'vitest';
import { mintSessionId } from '../src/domain/fostering.js';
import {
  bareSessionId,
  isSessionFileName,
  isTombstoneFileName,
  sessionFileName,
  tombstoneFileName,
} from '../src/domain/naming.js';

/**
 * These tie the naming rules together. Previously the prefix was written out
 * independently in the minting, scanning, tombstone and display paths, so a
 * change to one could leave foster writing files its own scanner ignored.
 */
describe('session naming', () => {
  it('recognises the filenames it mints', () => {
    expect(isSessionFileName(sessionFileName(mintSessionId()))).toBe(true);
  });

  it('rejects files the app does not treat as sessions', () => {
    expect(isSessionFileName('notes.txt')).toBe(false);
    expect(isSessionFileName('local_abc.txt')).toBe(false);
    expect(isSessionFileName('abc.json')).toBe(false);
  });

  it('strips the prefix idempotently', () => {
    const id = mintSessionId();
    expect(bareSessionId(id)).not.toBe(id);
    expect(bareSessionId(bareSessionId(id))).toBe(bareSessionId(id));
  });

  it('builds tombstone names the scanner recognises, keyed on the bare id', () => {
    const id = mintSessionId();
    const name = tombstoneFileName(id);

    expect(isTombstoneFileName(name)).toBe(true);
    expect(name).toContain(bareSessionId(id));
    expect(name).not.toContain('local_');
  });
});
