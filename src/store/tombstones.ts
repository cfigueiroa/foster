import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isTombstoneFileName, TOMBSTONE_PREFIX } from '../domain/naming.js';
import { accountDir, listAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { safeReaddir } from '../util/fs.js';

/**
 * What the app leaves behind when a session is deleted.
 *
 * Deleting removes the session file and writes one `deleted_<id>` marker per
 * identifier the session carried — its own id, its cliSessionId, and the
 * unarchived one if it had it — each containing only the time of the deletion.
 *
 * The markers exist to stop the app's own recovery scan from offering a
 * conversation the user deliberately threw away. They do not stop the app
 * *loading* a session file that exists, which is the difference that makes an
 * accidental deletion recoverable: the pointer is gone, the conversation is not.
 */

export interface Tombstone {
  path: string;
  account: AccountRef;
  /** The identifier that was deleted, without the app's `local_` prefix. */
  id: string;
  deletedAt?: number;
}

export function scanTombstones(store: StoreLayout, account: AccountRef): Tombstone[] {
  const dir = accountDir(store, account);
  const out: Tombstone[] = [];

  for (const entry of safeReaddir(dir)) {
    if (!isTombstoneFileName(entry)) continue;

    const file = path.join(dir, entry);
    const tombstone: Tombstone = {
      path: file,
      account,
      id: entry.slice(TOMBSTONE_PREFIX.length),
    };

    const deletedAt = readTimestamp(file);
    if (deletedAt !== undefined) tombstone.deletedAt = deletedAt;
    out.push(tombstone);
  }

  return out;
}

export function scanAllTombstones(store: StoreLayout): Tombstone[] {
  return listAccountDirs(store).flatMap((account) => scanTombstones(store, account));
}

function readTimestamp(file: string): number | undefined {
  try {
    const at = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(at) && at > 0 ? at : undefined;
  } catch {
    return undefined;
  }
}
