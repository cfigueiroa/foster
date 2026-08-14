import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  decodeBatch,
  decodeVarint32,
  encodeBatch,
  encodeVarint32,
  frameRecords,
  nextSequence,
  readLog,
  readManifest,
  scanTable,
  type BatchEntry,
} from './format/leveldb.js';
import { appendSynced } from '../util/fsatomic.js';
import { safeReaddir } from '../util/fs.js';
import type { StoreLayout } from '../domain/types.js';

/**
 * The sidebar's pinned sessions.
 *
 * Every other thing foster touches is a JSON file in a directory the app reads
 * at startup. This one is not: pinning is state of the window rather than of the
 * session store, and it lives in Chromium's IndexedDB under a single key. The
 * session file has no field for it, and the app's config does not mention it —
 * a copy therefore arrives unpinned however carefully it is written, because the
 * pin is keyed on the session id and foster mints a fresh one for every copy.
 *
 * The list is stored as the persisted state of a small store the app calls
 * `dframe-starred-code`, which is to say: a JSON string, wrapped in Blink's
 * serialisation envelope, as the value of one IndexedDB record.
 */

/** The IndexedDB key the app persists the pin list under. */
export const PIN_STATE_KEY = 'store:pin-state:dframe-starred-code';

/** Chromium's database for the app's own origin. */
const DATABASE_DIRECTORY = 'https_claude.ai_0.indexeddb.leveldb';

/**
 * Chromium writes two rows for one IndexedDB record: the value itself, and a
 * small "exists" entry holding the same version number, which its index
 * bookkeeping consults. Writing only the first leaves the two disagreeing.
 */
const OBJECT_STORE_DATA = 0x01;
const EXISTS_ENTRY = 0x02;

/** Blink's tag for a string whose characters all fit in one byte. */
const ONE_BYTE_STRING = 0x22;

export class PinStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinStateError';
  }
}

export function indexedDbDir(store: StoreLayout): string {
  return path.join(store.root, 'IndexedDB', DATABASE_DIRECTORY);
}

/**
 * An IndexedDB record key: which database, object store and index, then the key
 * itself. The key is a string, and IndexedDB encodes strings as UTF-16 in **big**
 * endian — the opposite of everything else in the file — with a length counted in
 * characters rather than bytes.
 *
 * The first five bytes are hardcoded against the format the app writes today
 * (`[0x00, 0x01, 0x01, indexId, 0x01]`): a leading byte packing the byte-lengths
 * of the three ids that follow, all of which are a single byte here. This is the
 * one thing in this module that cannot be re-derived, and the exact bytes are
 * locked by `pinstate.test.ts` against values captured from a real database. If
 * an upgrade ever needs a wider id, this guard turns what would otherwise
 * *silently* append a record under a key the app never reads — a pin that looks
 * like it stuck and does not — into a clear refusal instead.
 */
export function recordKey(indexId: number, name: string): Buffer {
  // The header packs each of the three ids as a one-byte length. Any of them
  // exceeding a byte means this encoding no longer reflects the app's format,
  // and writing on would produce a record the app never looks at.
  if (!Number.isInteger(indexId) || indexId < 0 || indexId > 0xff) {
    throw new PinStateError(
      `object-store index id ${indexId} cannot be encoded in the database's one-byte key ids.`,
    );
  }
  const characters = Buffer.alloc(name.length * 2);
  for (let index = 0; index < name.length; index++) {
    characters.writeUInt16BE(name.charCodeAt(index), index * 2);
  }
  // The leading byte packs the byte-lengths of the three ids that follow; all
  // three are one byte here, which the app has never been observed to exceed.
  return Buffer.concat([
    Buffer.from([0x00, 0x01, 0x01, indexId, 0x01]),
    encodeVarint32(name.length),
    characters,
  ]);
}

/** The exists entry stores its version little-endian, in as few bytes as it needs. */
function encodeVersion(version: number): Buffer {
  const bytes: number[] = [];
  let rest = version;
  do {
    bytes.push(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

export interface PinState {
  /** Session ids the sidebar shows pinned, in the order it holds them. */
  ids: string[];
  /** The log this was read out of, which is the one a write must append to. */
  logPath: string;
  /** Bumped on every write; the app's own bookkeeping, carried forward. */
  version: number;
  /**
   * Blink's envelope, taken verbatim from the record already there rather than
   * reconstructed. It encodes a serialiser version, and inventing one that the
   * installed app does not read is the difference between a pin and a crash.
   */
  envelope: Buffer;
  /** Everything the persisted store holds, so a write preserves what it does not understand. */
  document: Record<string, unknown>;
  /**
   * The highest sequence number anywhere in the database, log and sorted tables
   * and manifest alike. A write has to claim a number above it, or LevelDB reads
   * the older record as the newer one and the change appears to do nothing.
   */
  highestSequence: bigint;
  /**
   * Anything the tolerant read decided to look past rather than fail on — a
   * fragmented or torn tail of the log — that the caller may want to surface.
   * Empty when the database read cleanly.
   */
  notices: string[];
}

function locate(directory: string): { logPath: string; lastSequence: bigint } {
  const current = path.join(directory, 'CURRENT');
  if (!existsSync(current)) {
    throw new PinStateError(
      `No IndexedDB database at ${directory}.\n` +
        'Pinning is stored there, so there is nothing for foster to read or change.',
    );
  }

  const manifestName = readFileSync(current, 'utf8').trim();
  const manifest = path.join(directory, manifestName);
  if (!existsSync(manifest)) {
    throw new PinStateError(`${current} names ${manifestName}, which is not there.`);
  }

  const state = readManifest(readFileSync(manifest));
  if (state.logNumber === undefined) {
    throw new PinStateError(`Could not tell which log ${manifestName} is writing to.`);
  }

  const name = `${String(state.logNumber).padStart(6, '0')}.log`;
  const logPath = path.join(directory, name);
  if (!existsSync(logPath)) {
    throw new PinStateError(`${manifestName} names the log ${name}, which is not there.`);
  }
  return { logPath, lastSequence: state.lastSequence ?? 0n };
}

/**
 * Read the pin list, or `undefined` when the app has never pinned anything.
 *
 * Nothing pinned is not the same as an empty list, and the difference decides
 * whether foster may write at all: the record carries Blink's envelope, and with
 * no record there is nothing to copy it from.
 *
 * Both halves of the database are consulted, which is not optional. LevelDB
 * folds a log into a sorted table once it grows, and after that the log no
 * longer holds those records — so reading only the log reports "never pinned"
 * about a database that has simply been running for a while, which is every
 * database that has been running for a while.
 */
export function readPinState(store: StoreLayout): PinState | undefined {
  const directory = indexedDbDir(store);
  const { logPath, lastSequence } = locate(directory);
  const dataKey = recordKey(OBJECT_STORE_DATA, PIN_STATE_KEY);

  let highest = lastSequence;
  let newest: { sequence: bigint; value?: Buffer } | undefined;
  const consider = (sequence: bigint, value: Buffer | undefined): void => {
    if (sequence > highest) highest = sequence;
    if (!newest || sequence >= newest.sequence) newest = { sequence, value };
  };

  for (const name of safeReaddir(directory)) {
    if (!name.endsWith('.ldb')) continue;
    try {
      scanTable(readFileSync(path.join(directory, name)), (entry, value) => {
        if (!entry.userKey.equals(dataKey)) return;
        // A delete carries no value, and one at a higher sequence than the record
        // means the record is gone however many older copies of it survive.
        consider(entry.sequence, entry.isDelete ? undefined : Buffer.from(value));
      });
    } catch {
      // A table foster cannot read is skipped rather than fatal, because the
      // directory is not a curated list: LevelDB leaves half-written tables
      // behind when a process is killed during a compaction and simply ignores
      // them afterwards, since the manifest never names them. Treating one of
      // those as an error would let a file the app itself disregards stop foster
      // from reading a database that is otherwise perfectly intact — and the
      // same would happen to a healthy database the first time these tables use
      // a compression this does not implement.
    }
  }

  // Tolerant on purpose: a torn record at the end of a log is what any kill
  // during a write leaves, and LevelDB opens such a log by discarding it. Every
  // record before the damage is still checksummed and still read. Anything the
  // tolerant read gives up on is collected so the caller can say so instead of
  // quietly reporting a shorter list.
  const notices: string[] = [];
  for (const batch of readLog(readFileSync(logPath), {
    tolerant: true,
    onNotice: (message) => notices.push(message),
  })) {
    const decoded = decodeBatch(batch.payload);
    decoded.entries.forEach((entry, index) => {
      if (!entry.key.equals(dataKey)) return;
      consider(
        decoded.sequence + BigInt(index),
        entry.value ? Buffer.from(entry.value) : undefined,
      );
    });
  }

  if (!newest?.value) return undefined;
  const record = newest.value;

  // Walked field by field rather than searched for. Both the version varint and
  // the length varint can legitimately contain the bytes the envelope starts and
  // ends with, so scanning for a marker finds the wrong offset for values that
  // are perfectly ordinary — and only for some of them, which is the kind of bug
  // that survives every test written against one sample.
  const version = decodeVarint32(record, 0);
  const tag = record.indexOf(ONE_BYTE_STRING, version.next);
  if (tag === -1) {
    throw new PinStateError('The pin record does not carry the string envelope foster expects.');
  }

  const length = decodeVarint32(record, tag + 1);
  const body = record.subarray(length.next, length.next + length.value);
  if (body.length !== length.value) {
    throw new PinStateError(
      `The pin record declares ${length.value} bytes of payload but carries ${body.length}.`,
    );
  }

  let document: Record<string, unknown>;
  try {
    // latin1, matching the one-byte-per-character string the envelope declares.
    document = JSON.parse(body.toString('latin1')) as Record<string, unknown>;
  } catch (error) {
    throw new PinStateError(
      `The pin record's payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state = document.state as { starredIds?: unknown } | undefined;
  const ids = Array.isArray(state?.starredIds)
    ? state.starredIds.filter((id): id is string => typeof id === 'string')
    : [];

  return {
    ids,
    logPath,
    version: version.value,
    envelope: Buffer.from(record.subarray(version.next, tag + 1)),
    document,
    highestSequence: highest,
    notices,
  };
}

/**
 * Replace the pin list by appending one write batch to the log.
 *
 * Nothing already in the file is rewritten. LevelDB replays the log in order
 * when it next opens, so the appended record simply wins — which means the worst
 * an interrupted write can leave behind is a trailing partial record, the one
 * kind of damage the log format is built to discard.
 */
export function writePinState(state: PinState, ids: string[]): void {
  const document = {
    ...state.document,
    state: { ...(state.document.state as object), starredIds: ids },
    updatedAt: Date.now(),
  };

  // latin1 throughout: the envelope declares a one-byte-per-character string, so
  // the length that follows counts bytes and characters at once. Session ids and
  // JSON punctuation are ASCII, so nothing here can exceed it.
  const payload = Buffer.from(JSON.stringify(document), 'latin1');
  const version = state.version + 1;

  const entries: BatchEntry[] = [
    {
      key: recordKey(OBJECT_STORE_DATA, PIN_STATE_KEY),
      value: Buffer.concat([
        encodeVarint32(version),
        state.envelope,
        encodeVarint32(payload.length),
        payload,
      ]),
    },
    { key: recordKey(EXISTS_ENTRY, PIN_STATE_KEY), value: encodeVersion(version) },
  ];

  const existing = readFileSync(state.logPath);
  // Above everything the database already holds, and re-derived from the file
  // rather than trusted from the read, so that writing twice from one PinState
  // cannot hand the same number out twice.
  //
  // Strict here, unlike the read: a damaged log is something to report and stop
  // on when the next act is to append to it, however readable it was for
  // listing.
  const inLog = nextSequence(readLog(existing));
  const sequence = inLog > state.highestSequence ? inLog : state.highestSequence + 1n;
  // Read-then-append is not atomic against another writer in between. That is
  // deliberate: the app must be closed to reach here (its unflushed writes would
  // be put back on top of the log), so the only other writer is a second `foster
  // pin --yes` running at the same moment. Two concurrent invocations could lose
  // one update; a personal CLI with an explicit write flag accepts that far more
  // cheaply than an exclusive lock would cost.
  appendSynced(state.logPath, frameRecords(encodeBatch(sequence, entries), existing.length));
}

/**
 * Copy the database aside before changing it.
 *
 * The append is additive and the format tolerates a torn tail, but this is the
 * app's own database and it holds more than pins. A copy costs a few megabytes
 * and turns every remaining failure mode into an inconvenience.
 */
export function backupPinState(store: StoreLayout, destination: string): string {
  const directory = indexedDbDir(store);
  mkdirSync(destination, { recursive: true });

  for (const name of safeReaddir(directory)) {
    const from = path.join(directory, name);
    // LOCK is an empty file the database recreates, and copying it on Windows
    // fails while anything holds it — which would turn a healthy backup into an error.
    if (name === 'LOCK') continue;
    try {
      if (statSync(from).isFile()) copyFileSync(from, path.join(destination, name));
    } catch (error) {
      throw new PinStateError(
        `Could not back up ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return destination;
}
