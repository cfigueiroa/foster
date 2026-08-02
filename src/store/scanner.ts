import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { unfosterableReasons } from '../domain/fostering.js';
import { isSessionFileName } from '../domain/naming.js';
import { accountDir, listAccountDirs } from '../domain/paths.js';
import type {
  AccountRef,
  CodeSessionData,
  DiscoveredSession,
  StoreLayout,
} from '../domain/types.js';
import { safeReaddir } from '../util/fs.js';

/**
 * Read-only view of the Claude Desktop store.
 *
 * Nothing in this module writes. All mutation lives in the engine, so that the
 * scanner can always be run against a live install without risk.
 */

export interface AccountSummary {
  account: AccountRef;
  /** Sessions the app itself created. */
  nativeCount: number;
  /** Sessions foster copied in. */
  copyCount: number;
  isCurrent: boolean;
}

/**
 * What foster wrote, according to the ledger.
 *
 * Needed because the marker on the file is not durable. `activeToPersisted` in
 * the app builds the object it saves from an explicit list of fields, so the
 * first time the app writes a copy back — a title change, a focus, any activity —
 * `_foster` is dropped and the copy becomes indistinguishable from a session the
 * app made itself. Measured on a live store: of 364 copies, 21 had lost the
 * marker, and they were exactly the 21 that had been opened.
 */
export type KnownCopies = ReadonlySet<string>;

const NOTHING_KNOWN: KnownCopies = new Set<string>();

export function scanAccount(
  store: StoreLayout,
  account: AccountRef,
  copies: KnownCopies = NOTHING_KNOWN,
): DiscoveredSession[] {
  const dir = accountDir(store, account);
  const out: DiscoveredSession[] = [];

  for (const entry of safeReaddir(dir)) {
    if (!isSessionFileName(entry)) continue;

    const file = path.join(dir, entry);
    const data = readSession(file);
    if (!data) continue;

    // A copy foster wrote, not a session the app created. Classifying before
    // recording is what keeps a rescan from "discovering" copies as new sessions
    // and attributing them to the wrong origin — and the ledger is consulted
    // because the marker on the file does not survive the app saving it.
    const isCopy = data._foster !== undefined || copies.has(data.sessionId);

    const reasons = unfosterableReasons(data, isCopy);
    // The app skips any session file over its size limit while loading, with only
    // a line in its log to show for it. Copying one would write a file that never
    // appears and never explains why, so it is excluded here instead.
    if (sizeOf(file) > SESSION_FILE_MAX_BYTES) reasons.push('too-large');

    out.push({ path: file, account, data, isCopy, reasons });
  }

  return out;
}

export function scanStore(
  store: StoreLayout,
  copies: KnownCopies = NOTHING_KNOWN,
): DiscoveredSession[] {
  return listAccountDirs(store).flatMap((account) => scanAccount(store, account, copies));
}

export function summarise(
  store: StoreLayout,
  currentAccountUuid: string | undefined,
  copies: KnownCopies = NOTHING_KNOWN,
): AccountSummary[] {
  return listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account, copies), currentAccountUuid),
  );
}

/** Counts an already-scanned account, so callers that need both do not re-read every file. */
export function summariseAccount(
  account: AccountRef,
  sessions: DiscoveredSession[],
  currentAccountUuid: string | undefined,
): AccountSummary {
  let copyCount = 0;
  for (const session of sessions) if (session.isCopy) copyCount += 1;
  return {
    account,
    nativeCount: sessions.length - copyCount,
    copyCount,
    isCurrent: account.accountUuid === currentAccountUuid,
  };
}

/**
 * The largest session file Claude Desktop will load. Mirrored from the app, which
 * skips anything bigger and carries on.
 */
export const SESSION_FILE_MAX_BYTES = 10 * 1024 * 1024;

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readSession(file: string): CodeSessionData | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
    return typeof parsed?.sessionId === 'string' ? parsed : undefined;
  } catch {
    // A malformed or half-written file is skipped rather than crashing a scan.
    return undefined;
  }
}
