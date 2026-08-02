import { readFileSync } from 'node:fs';
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

export function scanAccount(store: StoreLayout, account: AccountRef): DiscoveredSession[] {
  const dir = accountDir(store, account);
  const out: DiscoveredSession[] = [];

  for (const entry of safeReaddir(dir)) {
    if (!isSessionFileName(entry)) continue;

    const file = path.join(dir, entry);
    const data = readSession(file);
    if (!data) continue;

    // A file carrying the marker is a copy foster wrote, not a session the app
    // created. Classifying before recording is what keeps a rescan from
    // "discovering" copies as new sessions and attributing them to the wrong origin.
    const isCopy = data._foster !== undefined;

    out.push({ path: file, account, data, isCopy, reasons: unfosterableReasons(data) });
  }

  return out;
}

export function scanStore(store: StoreLayout): DiscoveredSession[] {
  return listAccountDirs(store).flatMap((account) => scanAccount(store, account));
}

export function summarise(
  store: StoreLayout,
  currentAccountUuid: string | undefined,
): AccountSummary[] {
  return listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account), currentAccountUuid),
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

function readSession(file: string): CodeSessionData | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
    return typeof parsed?.sessionId === 'string' ? parsed : undefined;
  } catch {
    // A malformed or half-written file is skipped rather than crashing a scan.
    return undefined;
  }
}
