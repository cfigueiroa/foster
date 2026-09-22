import { mkdirSync, writeFileSync } from 'node:fs';
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

function localValue(document: unknown): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(document), 'latin1')]);
}

/** A synthetic Local Storage database: a manifest naming one log, and the log itself. */
function makeDatabase(
  store: StoreLayout,
  record?: { document: unknown; sequence?: bigint },
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
        { key: localStorageKey(SCRIPT_KEY), value: localValue(record.document) },
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
