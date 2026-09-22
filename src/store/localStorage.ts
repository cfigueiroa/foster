import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import {
  decodeBatch,
  encodeBatch,
  frameRecords,
  nextSequence,
  readLog,
  readManifest,
  scanTable,
  type BatchEntry,
} from './format/leveldb.js';
import { safeReaddir } from '../util/fs.js';
import { appendSynced } from '../util/fsatomic.js';
import type { StoreLayout } from '../domain/types.js';

/**
 * The Code sidebar's filter menu — the machine-wide half of it.
 *
 * Measured 22/09/2026, real MSIX store: three of the menu's seven settings live
 * in Chromium's Local Storage for the app's own origin, at
 * `<store.root>/Local Storage/leveldb/` — a second, sibling LevelDB database to
 * the one `store/pinstate.ts` reads, and encoded differently: a DOM Storage
 * record carries no Blink envelope and no separate "exists" entry, just a
 * one-byte type tag in front of the value's own bytes. `store/format/leveldb.ts`
 * is the same reader and writer `pinstate.ts` uses — the database format itself
 * does not change between the two origins' stores, only what is stored under
 * one key of it.
 *
 * Reading and writing both mirror `pinstate.ts`: both halves of the database
 * have to be read (a log LevelDB has folded into a sorted table no longer
 * mentions the record), the log tolerates a torn tail, and a write is an append
 * above every sequence number anywhere in the database — never a rewrite of
 * anything already there.
 */

const LOCAL_STORAGE_DIR = path.join('Local Storage', 'leveldb');

export function localStorageDir(store: StoreLayout): string {
  return path.join(store.root, LOCAL_STORAGE_DIR);
}

/** DOM Storage's one-byte-per-character string tag — Blink's `ONE_BYTE_STRING`, reused here. */
const ONE_BYTE_STRING = 0x01;

/**
 * A Local Storage record key: `_` + the origin, then `\x00\x01`, then the
 * script's own storage key. Measured, not derived from a spec Chromium
 * publishes — `_https://claude.ai` is the app's own origin string.
 */
export function localStorageKey(scriptKey: string, origin = 'https://claude.ai'): Buffer {
  return Buffer.concat([
    Buffer.from(`_${origin}`, 'latin1'),
    Buffer.from([0x00, 0x01]),
    Buffer.from(scriptKey, 'latin1'),
  ]);
}

export class LocalStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStorageError';
  }
}

function logsIn(directory: string): { name: string; number: number }[] {
  const logs: { name: string; number: number }[] = [];
  for (const name of safeReaddir(directory)) {
    const match = /^(\d+)\.log$/.exec(name);
    if (match) logs.push({ name, number: Number(match[1]) });
  }
  return logs.sort((a, b) => b.number - a.number);
}

/**
 * Which log to read, and to append to — the newest at or above the manifest's
 * own floor, the same reasoning `pinstate.ts`'s `locate` documents at length:
 * the manifest names a log only when it has had a reason to write one, and
 * Chromium opens these databases reusing whichever log recovery finds.
 */
function locate(directory: string): { logPath: string; lastSequence: bigint } {
  const current = path.join(directory, 'CURRENT');
  if (!existsSync(current)) {
    throw new LocalStorageError(`No Local Storage database at ${directory}.`);
  }
  const manifestName = readFileSync(current, 'utf8').trim();
  const manifest = path.join(directory, manifestName);
  if (!existsSync(manifest)) {
    throw new LocalStorageError(`${current} names ${manifestName}, which is not there.`);
  }
  const state = readManifest(readFileSync(manifest));
  if (state.logNumber === undefined) {
    throw new LocalStorageError(`Could not tell which log ${manifestName} is writing to.`);
  }
  const floor = Number(state.logNumber);
  const chosen = logsIn(directory).filter((log) => log.number >= floor)[0];
  if (!chosen) {
    const name = `${String(state.logNumber).padStart(6, '0')}.log`;
    throw new LocalStorageError(`${manifestName} names the log ${name}, which is not there.`);
  }
  return { logPath: path.join(directory, chosen.name), lastSequence: state.lastSequence ?? 0n };
}

export interface LocalStorageRecord {
  document: Record<string, unknown>;
  logPath: string;
  highestSequence: bigint;
  notices: string[];
}

/**
 * Read one key's JSON document, or `undefined` when nothing has ever written it.
 *
 * Both halves of the database are consulted — the sorted tables first, since a
 * record folded into one is the older copy, then the log, which is where a
 * recent write lives — exactly the order `readPinState` reads them in.
 */
export function readLocalStorageValue(
  store: StoreLayout,
  scriptKey: string,
): LocalStorageRecord | undefined {
  const directory = localStorageDir(store);
  const { logPath, lastSequence } = locate(directory);
  const log = readFileSync(logPath);
  const key = localStorageKey(scriptKey);

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
        if (!entry.userKey.equals(key)) return;
        consider(entry.sequence, entry.isDelete ? undefined : Buffer.from(value));
      });
    } catch {
      // A table this cannot read is skipped, not fatal — see `readPinState`.
    }
  }

  const notices: string[] = [];
  for (const batch of readLog(log, {
    tolerant: true,
    onNotice: (message) => notices.push(message),
  })) {
    const decoded = decodeBatch(batch.payload);
    decoded.entries.forEach((entry, index) => {
      if (!entry.key.equals(key)) return;
      consider(
        decoded.sequence + BigInt(index),
        entry.value ? Buffer.from(entry.value) : undefined,
      );
    });
  }

  if (!newest?.value) return undefined;
  const record = newest.value;
  if (record[0] !== ONE_BYTE_STRING) {
    throw new LocalStorageError(
      `${scriptKey} does not carry the one-byte string tag foster expects.`,
    );
  }

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(record.subarray(1).toString('latin1')) as Record<string, unknown>;
  } catch (error) {
    throw new LocalStorageError(
      `${scriptKey}'s payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { document, logPath, highestSequence: highest, notices };
}

/**
 * Replace one key's document by appending a write batch to the log — additive,
 * like `writePinState`: nothing already on disk is rewritten, so the worst an
 * interrupted write leaves behind is a trailing partial record.
 */
export function writeLocalStorageValue(
  record: Pick<LocalStorageRecord, 'logPath' | 'highestSequence'>,
  scriptKey: string,
  document: Record<string, unknown>,
): void {
  const payload = Buffer.concat([
    Buffer.from([ONE_BYTE_STRING]),
    Buffer.from(JSON.stringify(document), 'latin1'),
  ]);
  const entries: BatchEntry[] = [{ key: localStorageKey(scriptKey), value: payload }];

  const existing = readFileSync(record.logPath);
  const inLog = nextSequence(readLog(existing));
  const sequence = inLog > record.highestSequence ? inLog : record.highestSequence + 1n;
  appendSynced(record.logPath, frameRecords(encodeBatch(sequence, entries), existing.length));
}

/** Copy the database aside before changing it — mirrors `backupPinState`. */
export function backupLocalStorage(store: StoreLayout, destination: string): string {
  const directory = localStorageDir(store);
  mkdirSync(destination, { recursive: true });
  for (const name of safeReaddir(directory)) {
    const from = path.join(directory, name);
    if (name === 'LOCK') continue;
    try {
      if (statSync(from).isFile()) copyFileSync(from, path.join(destination, name));
    } catch (error) {
      throw new LocalStorageError(
        `Could not back up ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return destination;
}
