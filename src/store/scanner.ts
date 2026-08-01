import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { unfosterableReasons } from '../domain/fostering.js';
import { accountDir, listAccountDirs } from '../domain/paths.js';
import type {
  AccountRef,
  CodeSessionData,
  DiscoveredSession,
  StoreLayout,
} from '../domain/types.js';

/**
 * Read-only view of the Claude Desktop store.
 *
 * Nothing in this module writes. All mutation lives in the engine, so that the
 * scanner can always be run against a live install without risk.
 */

const SESSION_PREFIX = 'local_';
const TOMBSTONE_PREFIX = 'deleted_';

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
    if (!entry.startsWith(SESSION_PREFIX) || !entry.endsWith('.json')) continue;

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
  return listAccountDirs(store).map((account) => {
    const sessions = scanAccount(store, account);
    return {
      account,
      nativeCount: sessions.filter((s) => !s.isCopy).length,
      copyCount: sessions.filter((s) => s.isCopy).length,
      isCurrent: account.accountUuid === currentAccountUuid,
    };
  });
}

/** Ids the app has tombstoned in a given account directory. */
export function listTombstones(store: StoreLayout, account: AccountRef): Set<string> {
  const out = new Set<string>();
  for (const entry of safeReaddir(accountDir(store, account))) {
    if (entry.startsWith(TOMBSTONE_PREFIX)) out.add(entry.slice(TOMBSTONE_PREFIX.length));
  }
  return out;
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

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
