import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeBatch,
  encodeBatch,
  encodeVarint32,
  frameRecords,
  readLog,
} from '../src/store/format/leveldb.js';
import {
  PIN_STATE_KEY,
  PinStateError,
  backupPinState,
  indexedDbDir,
  readPinState,
  recordKey,
  writePinState,
} from '../src/store/pinstate.js';
import type { StoreLayout } from '../src/domain/types.js';
import { internalKey, makeTable } from './helpers/leveldb.js';
import { makeStore } from './helpers/store.js';

/**
 * Blink's envelope, byte for byte as the installed app writes it: a serialiser
 * version, a padded header, and the tag for a string of one-byte characters.
 * foster never constructs this in production — it carries forward whatever the
 * app wrote — but a fixture has to start somewhere, and starting from the real
 * bytes is what keeps these tests about the format rather than about themselves.
 */
const ENVELOPE = Buffer.from([
  0xff, 0x15, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x0f, 0x22,
]);

const LOG_NUMBER = 4;

function pinValue(version: number, document: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(document), 'latin1');
  return Buffer.concat([
    encodeVarint32(version),
    ENVELOPE,
    encodeVarint32(payload.length),
    payload,
  ]);
}

function encodeExistsVersion(version: number): Buffer {
  const bytes: number[] = [];
  let rest = version;
  do {
    bytes.push(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** A synthetic IndexedDB: a manifest naming one log, and the log itself. */
function makeDatabase(
  store: StoreLayout,
  record?: {
    ids: string[];
    version?: number;
    extra?: Record<string, unknown>;
    sequence?: bigint;
  },
): string {
  const dir = indexedDbDir(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');

  const edit = Buffer.concat([
    encodeVarint32(1), // comparator name, which is the field foster must step over
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2), // the log number, which is the field it is after
    encodeVarint32(LOG_NUMBER),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));

  const logPath = path.join(dir, `${String(LOG_NUMBER).padStart(6, '0')}.log`);
  if (!record) {
    writeFileSync(logPath, Buffer.alloc(0));
    return logPath;
  }

  const version = record.version ?? 25_585;
  const document = { state: { starredIds: record.ids }, version: 0, updatedAt: 1, ...record.extra };
  writeFileSync(
    logPath,
    frameRecords(
      encodeBatch(record.sequence ?? 1n, [
        { key: recordKey(1, PIN_STATE_KEY), value: pinValue(version, document) },
        { key: recordKey(2, PIN_STATE_KEY), value: encodeExistsVersion(version) },
      ]),
      0,
    ),
  );
  return logPath;
}

/**
 * The same record as LevelDB leaves it after compaction: in a sorted table, with
 * the log no longer mentioning it at all.
 */
function writeCompacted(
  store: StoreLayout,
  record: { ids: string[]; version?: number; sequence: bigint; isDelete?: boolean },
): void {
  const version = record.version ?? 25_585;
  const document = { state: { starredIds: record.ids }, version: 0, updatedAt: 1 };
  writeFileSync(
    path.join(indexedDbDir(store), '000006.ldb'),
    makeTable([
      [
        internalKey(recordKey(1, PIN_STATE_KEY), record.sequence, record.isDelete),
        record.isDelete ? Buffer.alloc(0) : pinValue(version, document),
      ],
      [
        internalKey(recordKey(2, PIN_STATE_KEY), record.sequence, record.isDelete),
        record.isDelete ? Buffer.alloc(0) : encodeExistsVersion(version),
      ],
    ]),
  );
}

function rowsInLog(logPath: string): Map<number, Buffer> {
  const rows = new Map<number, Buffer>();
  for (const batch of readLog(readFileSync(logPath))) {
    for (const entry of decodeBatch(batch.payload).entries) {
      // The index id is the fourth byte of the key; later writes win.
      if (entry.value) rows.set(entry.key[3]!, Buffer.from(entry.value));
    }
  }
  return rows;
}

const ID_A = 'local_00000000-0000-4000-8000-00000000000a';
const ID_B = 'local_00000000-0000-4000-8000-00000000000b';

describe('pin state', () => {
  /**
   * The one assertion here that is not self-referential. These bytes were read
   * out of a real Claude Desktop database; if the key encoding drifts, foster
   * writes a record the app never looks at and reports success for it.
   */
  it('builds the record key the app itself uses', () => {
    const data = recordKey(1, PIN_STATE_KEY);
    const exists = recordKey(2, PIN_STATE_KEY);

    expect(PIN_STATE_KEY).toHaveLength(0x23);
    expect(data).toHaveLength(6 + PIN_STATE_KEY.length * 2);
    // Prefix, then the string type byte, then the length in characters.
    expect([...data.subarray(0, 6)]).toEqual([0x00, 0x01, 0x01, 0x01, 0x01, 0x23]);
    expect([...exists.subarray(0, 6)]).toEqual([0x00, 0x01, 0x01, 0x02, 0x01, 0x23]);
    // UTF-16 big-endian: the high byte first, which is the opposite of every
    // other multi-byte field in the file.
    expect([...data.subarray(6, 10)]).toEqual([0x00, 0x73, 0x00, 0x74]);
  });

  it('refuses an index id that the one-byte key encoding cannot hold', () => {
    // The header packs each id as a single byte. A wider id means this encoding
    // no longer matches the app's format; writing on would append a record that
    // is never read, so it is refused instead of silently not sticking.
    expect(() => recordKey(0x100, PIN_STATE_KEY)).toThrow(PinStateError);
    expect(() => recordKey(-1, PIN_STATE_KEY)).toThrow(PinStateError);
    expect(() => recordKey(1.5, PIN_STATE_KEY)).toThrow(PinStateError);
  });

  it('reports nothing rather than an empty list when the app has never pinned', () => {
    const store = makeStore();
    makeDatabase(store);
    // The difference matters: with no record there is no envelope to copy, so
    // foster must decline to write rather than invent one.
    expect(readPinState(store)).toBeUndefined();
  });

  it('reads the pinned ids out of the log', () => {
    const store = makeStore();
    makeDatabase(store, { ids: [ID_A, ID_B] });

    const state = readPinState(store)!;
    expect(state.ids).toEqual([ID_A, ID_B]);
    expect(state.version).toBe(25_585);
    expect(state.envelope.equals(ENVELOPE)).toBe(true);
  });

  it('takes the newest record when the log holds several', () => {
    const store = makeStore();
    const logPath = makeDatabase(store, { ids: [ID_A] });

    const first = readPinState(store)!;
    writePinState(first, [ID_A, ID_B]);

    expect(readPinState(store)!.ids).toEqual([ID_A, ID_B]);
    // Both records are still in the file; the later one simply wins.
    expect(readLog(readFileSync(logPath))).toHaveLength(2);
  });

  it('appends without rewriting anything already in the log', () => {
    const store = makeStore();
    const logPath = makeDatabase(store, { ids: [ID_A] });
    const before = readFileSync(logPath);

    writePinState(readPinState(store)!, [ID_A, ID_B]);

    const after = readFileSync(logPath);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
  });

  it('bumps the version and keeps both rows agreeing on it', () => {
    const store = makeStore();
    const logPath = makeDatabase(store, { ids: [ID_A], version: 41 });

    writePinState(readPinState(store)!, [ID_A, ID_B]);

    const rows = rowsInLog(logPath);
    // The data row leads with the version as a varint; the exists row stores the
    // same number little-endian. Writing one without the other leaves the app's
    // index bookkeeping disagreeing with its data.
    expect(rows.get(1)![0]).toBe(42);
    expect([...rows.get(2)!]).toEqual([42]);
    expect(readPinState(store)!.version).toBe(42);
  });

  it('carries forward the envelope and any fields it does not understand', () => {
    const store = makeStore();
    makeDatabase(store, { ids: [ID_A], extra: { futureField: { nested: true } } });

    writePinState(readPinState(store)!, []);

    const state = readPinState(store)!;
    expect(state.ids).toEqual([]);
    expect(state.envelope.equals(ENVELOPE)).toBe(true);
    // A field foster has never heard of must survive, or a newer app loses
    // settings every time foster changes a pin.
    expect(state.document.futureField).toEqual({ nested: true });
  });

  /**
   * The failure this was written for: against a real installation foster read
   * only the log, found nothing, and reported that the app had never pinned
   * anything — while ten sessions sat pinned in the sidebar. LevelDB had folded
   * the log into a sorted table, which is what it does to every log eventually.
   */
  it('finds the record after LevelDB has compacted the log away', () => {
    const store = makeStore();
    makeDatabase(store); // an empty log, exactly as it is left after a rotation
    writeCompacted(store, { ids: [ID_A, ID_B], sequence: 690_625n });

    const state = readPinState(store)!;
    expect(state.ids).toEqual([ID_A, ID_B]);
    expect(state.highestSequence).toBeGreaterThanOrEqual(690_625n);
  });

  it('prefers whichever copy carries the higher sequence number', () => {
    const store = makeStore();
    makeDatabase(store, { ids: [ID_A], sequence: 900n });
    writeCompacted(store, { ids: [ID_A, ID_B], sequence: 100n });

    // The table is older here despite holding more, so the log wins.
    expect(readPinState(store)!.ids).toEqual([ID_A]);
  });

  it('honours a deletion that supersedes the record', () => {
    const store = makeStore();
    makeDatabase(store);
    writeCompacted(store, { ids: [ID_A], sequence: 500n, isDelete: true });

    expect(readPinState(store)).toBeUndefined();
  });

  it('writes above every sequence in the database, not just those in the log', () => {
    const store = makeStore();
    makeDatabase(store, { ids: [ID_A], sequence: 2n });
    writeCompacted(store, { ids: [ID_A], sequence: 900n });

    const state = readPinState(store)!;
    writePinState(state, [ID_A, ID_B]);

    // A batch numbered from the log alone would land below the table's records
    // and be read as the older of the two — a write that silently does nothing.
    expect(readPinState(store)!.ids).toEqual([ID_A, ID_B]);
  });

  it('reads what came before a record the end of the log cuts in half', () => {
    const store = makeStore();
    const logPath = makeDatabase(store, { ids: [ID_A] });
    writePinState(readPinState(store)!, [ID_A, ID_B]);

    // A kill during a write leaves exactly this, and LevelDB opens such a log by
    // discarding the fragment. Refusing it outright would leave the app working
    // and foster unable to list anything.
    const log = readFileSync(logPath);
    writeFileSync(logPath, log.subarray(0, log.length - 8));

    const state = readPinState(store)!;
    // The intact record is still read, and the cut tail is surfaced rather than
    // silently dropped.
    expect(state.ids).toEqual([ID_A]);
    expect(state.notices.length).toBeGreaterThan(0);
    expect(state.notices.join(' ')).toMatch(/offset/);
  });

  it('skips a sorted table it cannot read rather than giving up on the database', () => {
    const store = makeStore();
    makeDatabase(store, { ids: [ID_A] });
    // LevelDB leaves half-written tables behind when a compaction is killed, and
    // ignores them afterwards because the manifest never names them.
    writeFileSync(path.join(indexedDbDir(store), '000099.ldb'), Buffer.alloc(2048, 0x41));

    expect(readPinState(store)!.ids).toEqual([ID_A]);
  });

  it('refuses a database it cannot find its way around', () => {
    const store = makeStore();
    // No CURRENT at all: there is nothing to read and nothing to write to.
    expect(() => readPinState(store)).toThrow(PinStateError);

    const dir = indexedDbDir(store);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000009\n');
    expect(() => readPinState(store)).toThrow(/MANIFEST-000009/);
  });

  it('copies the database aside, leaving the lock behind', () => {
    const store = makeStore();
    makeDatabase(store, { ids: [ID_A] });
    writeFileSync(path.join(indexedDbDir(store), 'LOCK'), '');

    const destination = path.join(store.root, 'backup');
    backupPinState(store, destination);

    expect(existsSync(path.join(destination, 'CURRENT'))).toBe(true);
    expect(existsSync(path.join(destination, '000004.log'))).toBe(true);
    // LOCK is recreated by the database and cannot be copied on Windows while
    // anything holds it; copying it would turn a good backup into a failure.
    expect(existsSync(path.join(destination, 'LOCK'))).toBe(false);
  });
});
