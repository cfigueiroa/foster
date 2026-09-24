import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeBatch, nextSequence, readLog, readManifest, scanTable } from './format/leveldb.js';
import { safeReaddir } from '../util/fs.js';

/**
 * What `pinstate.ts` (IndexedDB) and `localStorage.ts` (DOM Storage) share:
 * both are Chromium LevelDB databases opened the same way, and until this was
 * extracted `localStorage.ts` carried a byte-for-byte copy of `pinstate.ts`'s
 * own `logsIn`, `locate` and the tables-then-log scan for one key's newest
 * value. The two databases differ only in what key they look for and how they
 * decode the record they find — never in how the directory itself is opened,
 * so that part lives here once.
 */

/**
 * The log files a LevelDB directory holds, newest number first.
 *
 * LevelDB names them `NNNNNN.log`, and the number orders them: a higher number
 * was opened later, so it holds the later records.
 */
export function logsIn(directory: string): { name: string; number: number }[] {
  const logs: { name: string; number: number }[] = [];
  for (const name of safeReaddir(directory)) {
    const match = /^(\d+)\.log$/.exec(name);
    if (match) logs.push({ name, number: Number(match[1]) });
  }
  return logs.sort((a, b) => b.number - a.number);
}

export interface LocatedLog {
  logPath: string;
  lastSequence: bigint;
  notice?: string;
}

/**
 * Which log to read, and to append to — the newest at or above the manifest's
 * own floor.
 *
 * The manifest's log number is a floor, not an address. LevelDB appends a new
 * version edit naming its log only when it has a reason to write one, and
 * Chromium opens these databases with log reuse — recovery is defined over
 * every log from that number up, so the log to read (and the one a write must
 * append to, since it is the one the app replays) is the highest-numbered of
 * those actually on disk. Measured 21/09/2026 on a real install: `foster pin`
 * refused a perfectly healthy database with `MANIFEST-000001 names the log
 * 000000.log, which is not there`, because 000003.log was the only log there.
 *
 * When the chosen log is not the one the manifest names, a notice is kept
 * about it rather than reading the substitute silently.
 */
export function locateLog(
  directory: string,
  makeError: (message: string) => Error,
  noDatabaseMessage: string,
): LocatedLog {
  const current = path.join(directory, 'CURRENT');
  if (!existsSync(current)) {
    throw makeError(noDatabaseMessage);
  }
  const manifestName = readFileSync(current, 'utf8').trim();
  const manifest = path.join(directory, manifestName);
  if (!existsSync(manifest)) {
    throw makeError(`${current} names ${manifestName}, which is not there.`);
  }
  const state = readManifest(readFileSync(manifest));
  if (state.logNumber === undefined) {
    throw makeError(`Could not tell which log ${manifestName} is writing to.`);
  }
  const floor = Number(state.logNumber);
  const name = `${String(state.logNumber).padStart(6, '0')}.log`;
  const chosen = logsIn(directory).filter((log) => log.number >= floor)[0];
  if (!chosen) {
    throw makeError(`${manifestName} names the log ${name}, which is not there.`);
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

export interface NewestValueResult {
  logPath: string;
  /** The highest sequence number anywhere in the database — log, tables and manifest alike. */
  highestSequence: bigint;
  /** The value at the highest sequence number found for the key, or `undefined` for a delete. */
  value?: Buffer;
  notices: string[];
  /**
   * Sorted tables that could not be read at all — a compression this does not
   * implement, a corrupt block, anything `scanTable` does not tolerate.
   *
   * Not simply skipped the way LevelDB's own compaction leaves a half-written
   * table behind: a caller building a write from this read needs to know,
   * because the newest copy of the key could be sitting in exactly the table
   * that failed. Reading one of those and reporting the older value found
   * elsewhere as current is how a write starts from stale state and erases
   * whatever the unreadable table actually held (#leveldb-integrity).
   */
  tablesUnreadable: string[];
}

/**
 * Find the newest value for one key across a LevelDB directory: every sorted
 * table, then the log — the order both `readPinState` and `readLocalStorageValue`
 * read them in, since a record folded into a table is the older copy and the
 * log is where a recent write lives.
 *
 * `matches` is asked of the *internal* key read out of a sorted table (the
 * user key with its sequence/delete trailer already split off) for tables, and
 * of the write batch's own key for the log — callers that need the sequence or
 * delete flag from a table entry get it through their own `scanTable` call
 * instead; this is only for locating one key's current value.
 */
export function newestValue(
  directory: string,
  makeError: (message: string) => Error,
  noDatabaseMessage: string,
  matches: (key: Buffer) => boolean,
): NewestValueResult {
  const {
    logPath,
    lastSequence,
    notice: located,
  } = locateLog(directory, makeError, noDatabaseMessage);
  const log = readFileSync(logPath);

  let highest = lastSequence;
  let newest: { sequence: bigint; value?: Buffer } | undefined;
  const consider = (sequence: bigint, value: Buffer | undefined): void => {
    if (sequence > highest) highest = sequence;
    if (!newest || sequence >= newest.sequence) newest = { sequence, value };
  };

  const tablesUnreadable: string[] = [];
  for (const name of safeReaddir(directory)) {
    if (!name.endsWith('.ldb')) continue;
    try {
      scanTable(readFileSync(path.join(directory, name)), (entry, value) => {
        if (!matches(entry.userKey)) return;
        consider(entry.sequence, entry.isDelete ? undefined : Buffer.from(value));
      });
    } catch {
      // LevelDB leaves half-written tables behind when a compaction is killed
      // and the manifest never names them, so most read failures here are
      // harmless — but this module cannot tell that case apart from one where
      // the table is real and simply unreadable (an unimplemented compression,
      // a flipped bit), so it is recorded rather than assumed harmless.
      tablesUnreadable.push(name);
    }
  }

  const notices: string[] = located ? [located] : [];
  if (tablesUnreadable.length > 0) {
    notices.push(
      `${tablesUnreadable.length === 1 ? 'a sorted table' : `${tablesUnreadable.length} sorted tables`} ` +
        `could not be read (${tablesUnreadable.join(', ')}); the value found here may be older than ` +
        'one that table held.',
    );
  }

  // Tolerant on purpose: a torn record at the end of a log is what any kill
  // during a write leaves, and LevelDB opens such a log by discarding it.
  for (const batch of readLog(log, {
    tolerant: true,
    onNotice: (message) => notices.push(message),
  })) {
    const decoded = decodeBatch(batch.payload);
    decoded.entries.forEach((entry, index) => {
      if (!matches(entry.key)) return;
      consider(
        decoded.sequence + BigInt(index),
        entry.value ? Buffer.from(entry.value) : undefined,
      );
    });
  }

  return { logPath, highestSequence: highest, value: newest?.value, notices, tablesUnreadable };
}

/** Whether every character of `text` fits in one Latin-1 byte — Chromium's own test for which string tag to write. */
export function fitsInLatin1(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

/**
 * Append one write batch to a log — additive, never rewriting anything already
 * there, so the worst an interrupted write leaves behind is a trailing partial
 * record. Shared by `writePinState` and `writeLocalStorageEntries`; kept here
 * because the sequencing rule (claim a number above *both* what the log holds
 * and what the read that produced `highestSequence` found in the tables) is
 * the one piece of writing logic the two formats agree on byte for byte — the
 * batch encoding and framing themselves stay in `format/leveldb.ts`, since a
 * caller with entries already in hand still needs them directly.
 */
export function nextWriteSequence(existing: Buffer, highestSequence: bigint): bigint {
  const inLog = nextSequence(readLog(existing));
  return inLog > highestSequence ? inLog : highestSequence + 1n;
}
