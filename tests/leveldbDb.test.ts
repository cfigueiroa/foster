import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeBatch, encodeVarint32, frameRecords } from '../src/store/format/leveldb.js';
import { fitsInLatin1, locateLog, newestValue, nextWriteSequence } from '../src/store/leveldbDb.js';
import { internalKey, makeTable } from './helpers/leveldb.js';

/**
 * `pinstate.ts` and `localStorage.ts` both build a LevelDB directory on top of
 * this module — those tests exercise it end to end through the two callers'
 * own formats. These are the direct unit tests of the shared pieces
 * themselves: the "no database" refusal is caller-supplied wording, and
 * `newestValue`/`nextWriteSequence`/`fitsInLatin1` have no caller-specific
 * decoding to get in the way of testing the directory-opening logic on its
 * own.
 */

class TestDbError extends Error {}
const makeError = (message: string): TestDbError => new TestDbError(message);

/** A minimal LevelDB directory: a manifest naming one log, and the log itself. */
function makeDirectory(entries: { key: Buffer; value?: Buffer }[] = [], sequence = 1n): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'foster-leveldbdb-'));
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  const edit = Buffer.concat([
    encodeVarint32(1),
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2),
    encodeVarint32(4),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));
  const logPath = path.join(dir, '000004.log');
  writeFileSync(
    logPath,
    entries.length === 0 ? Buffer.alloc(0) : frameRecords(encodeBatch(sequence, entries), 0),
  );
  return dir;
}

describe('leveldbDb: opening a directory', () => {
  it('uses the caller-supplied message and error class when there is no database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-leveldbdb-empty-'));
    expect(() => locateLog(dir, makeError, 'nothing here')).toThrow(TestDbError);
    expect(() => locateLog(dir, makeError, 'nothing here')).toThrow('nothing here');
  });

  it('finds the log the manifest names', () => {
    const dir = makeDirectory();
    const { logPath, notice } = locateLog(dir, makeError, 'nothing here');
    expect(logPath).toBe(path.join(dir, '000004.log'));
    expect(notice).toBeUndefined();
  });
});

describe('leveldbDb: newestValue', () => {
  const key = Buffer.from('the-key');

  it('finds a value written in the log', () => {
    const dir = makeDirectory([{ key, value: Buffer.from('hello') }]);
    const found = newestValue(dir, makeError, 'nothing here', (candidate) => candidate.equals(key));
    expect(found.value?.toString()).toBe('hello');
    expect(found.tablesUnreadable).toEqual([]);
  });

  it('prefers whichever copy carries the higher sequence number, table or log', () => {
    const dir = makeDirectory([{ key, value: Buffer.from('from-log') }], 900n);
    writeFileSync(
      path.join(dir, '000006.ldb'),
      makeTable([[internalKey(key, 100n), Buffer.from('from-table')]]),
    );
    const found = newestValue(dir, makeError, 'nothing here', (candidate) => candidate.equals(key));
    expect(found.value?.toString()).toBe('from-log');
  });

  it('records a table it could not read instead of silently preferring an older value', () => {
    const dir = makeDirectory([{ key, value: Buffer.from('from-log') }], 1n);
    // A table with a higher sequence than the log, but unreadable — the real
    // newest value is out of reach, and `from-log` is not actually current.
    writeFileSync(path.join(dir, '000006.ldb'), Buffer.alloc(1024, 0x41));

    const found = newestValue(dir, makeError, 'nothing here', (candidate) => candidate.equals(key));
    expect(found.tablesUnreadable).toEqual(['000006.ldb']);
    expect(found.notices.join(' ')).toMatch(/000006\.ldb/);
  });

  it('reports nothing for a key never written', () => {
    const dir = makeDirectory();
    const found = newestValue(dir, makeError, 'nothing here', (candidate) => candidate.equals(key));
    expect(found.value).toBeUndefined();
    expect(found.tablesUnreadable).toEqual([]);
  });
});

describe('leveldbDb: nextWriteSequence', () => {
  it('claims one past whatever the log itself holds', () => {
    const log = frameRecords(
      encodeBatch(10n, [
        { key: Buffer.from('a'), value: Buffer.from('1') },
        { key: Buffer.from('b'), value: Buffer.from('2') },
      ]),
      0,
    );
    expect(nextWriteSequence(log, 0n)).toBe(12n);
  });

  it('claims one past the read highestSequence when that is higher than the log', () => {
    // The case a compacted table produces: its records never appear in the log
    // at all, so only the read's own tracked highest sequence knows about them.
    const log = frameRecords(
      encodeBatch(2n, [{ key: Buffer.from('a'), value: Buffer.from('1') }]),
      0,
    );
    expect(nextWriteSequence(log, 900n)).toBe(901n);
  });
});

describe('leveldbDb: fitsInLatin1', () => {
  it('accepts ASCII and Latin-1 text', () => {
    expect(fitsInLatin1('plain ascii')).toBe(true);
    expect(fitsInLatin1('café')).toBe(true);
  });

  it('rejects a character above 0xFF', () => {
    expect(fitsInLatin1('日本語')).toBe(false);
    expect(fitsInLatin1('emoji 🎉')).toBe(false);
  });
});
