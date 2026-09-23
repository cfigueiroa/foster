import { existsSync, readFileSync } from 'node:fs';
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
import { backupDirectory, type BackupOptions } from '../util/backups.js';
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

/**
 * Whether there is a Local Storage database here at all — cheap, and read-only.
 * A store nothing has ever opened the Code sidebar's filter menu on has no
 * `CURRENT` file yet, the same "never written" case `readPinState` treats as
 * absence rather than failure. Callers that would otherwise write here (the
 * groups triple-write in `engine/layout.ts`) use this to skip gracefully
 * instead of failing a whole run over a database that simply is not there yet.
 */
export function localStoragePresent(store: StoreLayout): boolean {
  return existsSync(path.join(localStorageDir(store), 'CURRENT'));
}

/** DOM Storage's one-byte-per-character string tag — Blink's `ONE_BYTE_STRING`, reused here. */
const ONE_BYTE_STRING = 0x01;
/**
 * DOM Storage's UTF-16LE string tag — Blink's `TWO_BYTES_STRING`. Chromium writes this instead of
 * `ONE_BYTE_STRING` whenever the value holds a character Latin-1 cannot carry; before this, a
 * record tagged this way was refused outright (`record[0] !== ONE_BYTE_STRING`), which is
 * indistinguishable from "never written" to a caller like `view` that reads quietly and treats
 * every error as absence.
 */
const TWO_BYTE_STRING = 0x00;

/** Which of DOM Storage's two string tags a record was read under, and is written back under. */
export type LocalStorageEncoding = 'latin1' | 'utf16le';

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

/**
 * The page's own marker for "`dframe-store` holds a local edit the server has
 * not seen yet" — a bare string, not JSON. Measured 23/09/2026 (app 2.7032.0.0,
 * and the claude.ai bundle it loaded that day): `dframe-store` is a
 * server-synced store, and at startup the page folds the account's server copy
 * over the local one — replacing the signed-in account's list of sidebar groups
 * with the server's — *unless* this key names the signed-in identity
 * (`<accountUuid>/<orgUuid>`, or the wildcard `1`), in which case it uploads the
 * local state instead. The page sets it on every sidebar edit and deletes it
 * once the upload lands; with a `|migrate` suffix it first unions the server's
 * groups into the local ones (`mergePendingSeed`), which is what the page
 * itself writes when it migrates legacy groups into an account.
 */
export const DFRAME_SYNC_PENDING_KEY = 'ccd-sync-pending:ccd/dframe-store';

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
 *
 * When the chosen log is not the one the manifest names, `pinstate.ts`'s
 * `locate` keeps a notice about it rather than reading the substitute silently
 * — the same thing applies here, word for word, since it is the same
 * "manifest's number is a floor, not an address" reasoning.
 */
function locate(directory: string): { logPath: string; lastSequence: bigint; notice?: string } {
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
  const name = `${String(state.logNumber).padStart(6, '0')}.log`;
  const chosen = logsIn(directory).filter((log) => log.number >= floor)[0];
  if (!chosen) {
    throw new LocalStorageError(`${manifestName} names the log ${name}, which is not there.`);
  }
  return {
    logPath: path.join(directory, chosen.name),
    lastSequence: state.lastSequence ?? 0n,
    ...(chosen.name === name
      ? {}
      : {
          notice:
            `${manifestName} names the log ${name}, which is not there; ` +
            `read ${chosen.name} instead, the newest log at or above that number.`,
        }),
  };
}

/**
 * The log to append to, and a floor for the sequence number to claim — usable
 * for a key that has never been written at all, where `readLocalStorageValue`
 * has nothing to return. The manifest's own `lastSequence` is always at least
 * as high as any sequence a healthy database has actually used, which is the
 * same floor `readLocalStorageValue` starts every per-key search from.
 */
export function currentLog(store: StoreLayout): { logPath: string; highestSequence: bigint } {
  const { logPath, lastSequence } = locate(localStorageDir(store));
  return { logPath, highestSequence: lastSequence };
}

export interface LocalStorageRecord {
  document: Record<string, unknown>;
  logPath: string;
  highestSequence: bigint;
  notices: string[];
  /** The tag the record was actually read under — `writeLocalStorageEntries` writes this back. */
  encoding: LocalStorageEncoding;
}

interface RawLocalStorageRecord {
  text: string;
  logPath: string;
  highestSequence: bigint;
  notices: string[];
  encoding: LocalStorageEncoding;
}

/**
 * Read one key's value as the text the page would get back from
 * `localStorage.getItem`, or `undefined` when nothing has ever written it (or
 * the newest entry for it is a delete).
 *
 * Both halves of the database are consulted — the sorted tables first, since a
 * record folded into one is the older copy, then the log, which is where a
 * recent write lives — exactly the order `readPinState` reads them in.
 */
function readRaw(store: StoreLayout, scriptKey: string): RawLocalStorageRecord | undefined {
  const directory = localStorageDir(store);
  const { logPath, lastSequence, notice: located } = locate(directory);
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

  // Seeded with `locate`'s own notice, exactly as `readPinState` seeds it from
  // `pinstate.ts`'s `locate` — lost otherwise, since nothing else carries it
  // forward.
  const notices: string[] = located ? [located] : [];
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

  // Chromium tags a DOM Storage value with which of its two string encodings
  // the bytes that follow are: `ONE_BYTE_STRING` when every character fits in
  // Latin-1, `TWO_BYTES_STRING` (UTF-16LE) otherwise. A `\x00`-tagged record
  // used to be refused outright here — indistinguishable, to a quiet reader
  // like `view`, from a key nothing has ever written.
  let encoding: LocalStorageEncoding;
  let text: string;
  if (record[0] === ONE_BYTE_STRING) {
    encoding = 'latin1';
    text = record.subarray(1).toString('latin1');
  } else if (record[0] === TWO_BYTE_STRING) {
    encoding = 'utf16le';
    text = record.subarray(1).toString('utf16le');
  } else {
    throw new LocalStorageError(
      `${scriptKey} does not carry a string tag foster recognises (saw byte ${record[0]}).`,
    );
  }

  return { text, logPath, highestSequence: highest, notices, encoding };
}

/**
 * Read one key's JSON document, or `undefined` when nothing has ever written it.
 */
export function readLocalStorageValue(
  store: StoreLayout,
  scriptKey: string,
): LocalStorageRecord | undefined {
  const raw = readRaw(store, scriptKey);
  if (!raw) return undefined;

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(raw.text) as Record<string, unknown>;
  } catch (error) {
    throw new LocalStorageError(
      `${scriptKey}'s payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    document,
    logPath: raw.logPath,
    highestSequence: raw.highestSequence,
    notices: raw.notices,
    encoding: raw.encoding,
  };
}

/**
 * Read one key whose value the page stores as a bare string rather than a
 * JSON document — `ccd-sync-pending:*` is one — or `undefined` when nothing
 * has ever written it, or the newest entry for it is a delete.
 */
export function readLocalStorageText(store: StoreLayout, scriptKey: string): string | undefined {
  return readRaw(store, scriptKey)?.text;
}

/** Whether every character of `text` fits in one Latin-1 byte — Chromium's own test for which tag to write. */
function fitsInLatin1(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

/**
 * Tags and encodes a value the way Chromium itself decides between its two
 * string encodings: stay one-byte-per-character only while `encoding` says the
 * record was read that way *and* the new content still fits — otherwise (new
 * content needs a wider character, or the record already carried the wider
 * tag) it is written UTF-16LE. A record read as UTF-16LE is never written back
 * as Latin-1, even when the new content would fit — that would just be
 * guessing at an encoding Chromium itself did not choose.
 */
function encodeText(text: string, encoding: LocalStorageEncoding): Buffer {
  if (encoding === 'latin1' && fitsInLatin1(text)) {
    return Buffer.concat([Buffer.from([ONE_BYTE_STRING]), Buffer.from(text, 'latin1')]);
  }
  return Buffer.concat([Buffer.from([TWO_BYTE_STRING]), Buffer.from(text, 'utf16le')]);
}

/**
 * One key's write: a JSON document, or — for a key the page stores as a bare
 * string, like `ccd-sync-pending:*` — the text itself. A text write is tagged
 * by its own content alone (Chromium's rule), never by the `encoding` a
 * sibling document in the same batch was read under.
 */
export type LocalStorageWrite =
  { scriptKey: string; document: Record<string, unknown> } | { scriptKey: string; text: string };

/**
 * Replace one key's document by appending a write batch to the log — additive,
 * like `writePinState`: nothing already on disk is rewritten, so the worst an
 * interrupted write leaves behind is a trailing partial record.
 */
export function writeLocalStorageValue(
  record: Pick<LocalStorageRecord, 'logPath' | 'highestSequence'> &
    Partial<Pick<LocalStorageRecord, 'encoding'>>,
  scriptKey: string,
  document: Record<string, unknown>,
): void {
  writeLocalStorageEntries(record, [{ scriptKey, document }]);
}

/**
 * Replace several keys in **one** write batch — one sequence number, one
 * appended record, both keys advancing together. Used where two keys have to
 * agree with each other the instant either becomes visible: the sidebar's
 * groups are written to `LSS-persisted.dframe-group-scopes` and to
 * `dframe-store`'s own `state.customGroupsByScope` at once
 * (`engine/layout.ts`), and a reader that saw one updated and not the other
 * would have two disagreeing answers for "what are this account's groups".
 *
 * `encoding` is the tag every entry in the batch is written under — absent
 * (a fresh key `currentLog` supplied the write target for, never read) means
 * `'latin1'`, the only tag a value that has never existed could need.
 */
export function writeLocalStorageEntries(
  record: Pick<LocalStorageRecord, 'logPath' | 'highestSequence'> &
    Partial<Pick<LocalStorageRecord, 'encoding'>>,
  writes: LocalStorageWrite[],
): void {
  const entries: BatchEntry[] = writes.map((write) => ({
    key: localStorageKey(write.scriptKey),
    value:
      'text' in write
        ? encodeText(write.text, 'latin1')
        : encodeText(JSON.stringify(write.document), record.encoding ?? 'latin1'),
  }));

  const existing = readFileSync(record.logPath);
  const inLog = nextSequence(readLog(existing));
  const sequence = inLog > record.highestSequence ? inLog : record.highestSequence + 1n;
  appendSynced(record.logPath, frameRecords(encodeBatch(sequence, entries), existing.length));
}

/** Copy the database aside before changing it — mirrors `backupPinState`, under `~/.foster/backups`. */
export function backupLocalStorage(store: StoreLayout, options: BackupOptions = {}): string {
  return backupDirectory(localStorageDir(store), 'localStorage', options);
}
