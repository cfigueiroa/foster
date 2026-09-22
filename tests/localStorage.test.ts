import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeBatch, encodeVarint32, frameRecords } from '../src/store/format/leveldb.js';
import {
  localStorageDir,
  localStorageKey,
  readLocalStorageValue,
  writeLocalStorageValue,
} from '../src/store/localStorage.js';
import type { StoreLayout } from '../src/domain/types.js';
import { internalKey, makeTable } from './helpers/leveldb.js';
import { makeStore } from './helpers/store.js';

const LOG_NUMBER = 4;
const SCRIPT_KEY = 'dframe-store';

/** Blink's `ONE_BYTE_STRING` tag — every character of the JSON fits in Latin-1. */
function localValue(document: unknown): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(document), 'latin1')]);
}

/** Blink's `TWO_BYTES_STRING` tag — UTF-16LE, what Chromium writes for a character Latin-1 can't hold. */
function utf16Value(document: unknown): Buffer {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(document), 'utf16le')]);
}

/** A synthetic Local Storage database: a manifest naming one log, and the log itself. */
function makeDatabase(
  store: StoreLayout,
  record?: {
    document: unknown;
    sequence?: bigint;
    /** Which of Chromium's two tags to write the value under; `localValue` (latin1) by default. */
    encode?: (document: unknown) => Buffer;
  },
): string {
  const dir = localStorageDir(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');

  const edit = Buffer.concat([
    encodeVarint32(1),
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2),
    encodeVarint32(LOG_NUMBER),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));

  const logPath = path.join(dir, `${String(LOG_NUMBER).padStart(6, '0')}.log`);
  if (!record) {
    writeFileSync(logPath, Buffer.alloc(0));
    return logPath;
  }

  writeFileSync(
    logPath,
    frameRecords(
      encodeBatch(record.sequence ?? 1n, [
        { key: localStorageKey(SCRIPT_KEY), value: (record.encode ?? localValue)(record.document) },
      ]),
      0,
    ),
  );
  return logPath;
}

function writeCompacted(store: StoreLayout, document: unknown, sequence: bigint): void {
  mkdirSync(localStorageDir(store), { recursive: true });
  writeFileSync(
    path.join(localStorageDir(store), '000006.ldb'),
    makeTable([[internalKey(localStorageKey(SCRIPT_KEY), sequence), localValue(document)]]),
  );
}

describe('Local Storage: encode/decode round trip', () => {
  it('reports nothing when the key has never been written', () => {
    const store = makeStore();
    makeDatabase(store);
    expect(readLocalStorageValue(store, SCRIPT_KEY)).toBeUndefined();
  });

  it('reads back exactly what was written', () => {
    const store = makeStore();
    const logPath = makeDatabase(store);
    const before = {
      document: {},
      logPath,
      highestSequence: 0n,
      notices: [] as string[],
    };
    const document = { state: { recentsStatusFilter: 'active' }, version: 1 };
    writeLocalStorageValue(before, SCRIPT_KEY, document);

    const after = readLocalStorageValue(store, SCRIPT_KEY);
    expect(after?.document).toEqual(document);
  });

  it('round-trips latin1 bytes for a non-ASCII string', () => {
    const store = makeStore();
    makeDatabase(store, { document: { state: { groupByByMode: { code: 'Código' } } } });
    const record = readLocalStorageValue(store, SCRIPT_KEY);
    expect((record!.document.state as { groupByByMode: { code: string } }).groupByByMode.code).toBe(
      'Código',
    );
    expect(record!.encoding).toBe('latin1');
  });

  it('#11: decodes a UTF-16LE-tagged record instead of treating it as never-set', () => {
    const store = makeStore();
    makeDatabase(store, {
      document: { state: { groupByByMode: { code: 'Código 日本語' } } },
      encode: utf16Value,
    });
    const record = readLocalStorageValue(store, SCRIPT_KEY);
    expect(record).not.toBeUndefined();
    expect((record!.document.state as { groupByByMode: { code: string } }).groupByByMode.code).toBe(
      'Código 日本語',
    );
    expect(record!.encoding).toBe('utf16le');
  });
});

describe('#11: writing keeps the tag a record was read under, upgrading only when the new content needs it', () => {
  it('writes latin1 (0x01) again when the record was read as latin1 and the new content still fits', () => {
    const store = makeStore();
    makeDatabase(store, { document: { state: { a: 1 } } });
    const before = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(before.encoding).toBe('latin1');

    writeLocalStorageValue(before, SCRIPT_KEY, { state: { a: 2 } });

    const after = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(after.encoding).toBe('latin1');
    expect(after.document).toEqual({ state: { a: 2 } });
  });

  it('upgrades to utf16le (0x00) when a write needs a character latin1 cannot hold', () => {
    const store = makeStore();
    makeDatabase(store, { document: { state: { a: 1 } } });
    const before = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(before.encoding).toBe('latin1');

    writeLocalStorageValue(before, SCRIPT_KEY, { state: { label: '日本語' } });

    const after = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(after.encoding).toBe('utf16le');
    expect(after.document).toEqual({ state: { label: '日本語' } });
  });

  it('never downgrades: a record read as utf16le stays utf16le even when the new content would fit in latin1', () => {
    const store = makeStore();
    makeDatabase(store, { document: { state: { label: '日本語' } }, encode: utf16Value });
    const before = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(before.encoding).toBe('utf16le');

    writeLocalStorageValue(before, SCRIPT_KEY, { state: { a: 1 } });

    const after = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(after.encoding).toBe('utf16le');
    expect(after.document).toEqual({ state: { a: 1 } });
  });
});

describe('#15: locate keeps a notice when it reads a log other than the one the manifest names', () => {
  it('reads the newest log on disk when the manifest names one that is gone, and says so', () => {
    const store = makeStore();
    const logPath = makeDatabase(store, { document: { state: { a: 1 } } });
    // Same reasoning as `pinstate.ts`'s `locate` (see its own test of this): the
    // manifest's log number is a floor, not an address, and Chromium only
    // writes a version edit naming a log when it has another reason to.
    const newer = path.join(localStorageDir(store), '000009.log');
    renameSync(logPath, newer);

    const record = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(record.logPath).toBe(newer);
    expect(record.notices).toHaveLength(1);
    expect(record.notices[0]).toMatch(/000004\.log, which is not there/);
    expect(record.notices[0]).toMatch(/read 000009\.log instead/);
  });
});

describe('Local Storage: newest sequence wins', () => {
  it('prefers the log over an older compacted table', () => {
    const store = makeStore();
    writeCompacted(store, { state: { recentsStatusFilter: 'archived' } }, 1n);
    makeDatabase(store, { document: { state: { recentsStatusFilter: 'active' } }, sequence: 5n });

    const record = readLocalStorageValue(store, SCRIPT_KEY);
    expect((record!.document.state as { recentsStatusFilter: string }).recentsStatusFilter).toBe(
      'active',
    );
  });

  it('prefers a compacted table over a stale value still in the log', () => {
    const store = makeStore();
    makeDatabase(store, { document: { state: { recentsStatusFilter: 'active' } }, sequence: 1n });
    writeCompacted(store, { state: { recentsStatusFilter: 'archived' } }, 5n);

    const record = readLocalStorageValue(store, SCRIPT_KEY);
    expect((record!.document.state as { recentsStatusFilter: string }).recentsStatusFilter).toBe(
      'archived',
    );
  });
});

describe('Local Storage: writing preserves unrelated state keys', () => {
  it('carries every other field of the document and of state forward', () => {
    const store = makeStore();
    makeDatabase(store, {
      document: {
        state: { recentsStatusFilter: 'active', sidebarWidth: 320, collapsed: ['a'] },
        version: 1,
      },
    });
    const before = readLocalStorageValue(store, SCRIPT_KEY)!;

    const nextState = {
      ...(before.document.state as Record<string, unknown>),
      recentsStatusFilter: 'archived',
    };
    writeLocalStorageValue(before, SCRIPT_KEY, { ...before.document, state: nextState });

    const after = readLocalStorageValue(store, SCRIPT_KEY)!;
    expect(after.document.state).toEqual({
      recentsStatusFilter: 'archived',
      sidebarWidth: 320,
      collapsed: ['a'],
    });
    expect(after.document.version).toBe(1);
  });
});
