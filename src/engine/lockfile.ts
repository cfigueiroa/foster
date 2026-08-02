import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';

/**
 * Whether a running app holds the store.
 *
 * Electron keeps an exclusive handle on `lockfile` in userData for as long as it
 * runs. Renaming the file to itself fails while that handle is open and succeeds
 * once it is released — a real check, unlike trying to open the file for writing,
 * which Windows permits through its sharing modes.
 *
 * It lives alone in this module because both the safety gate and the process
 * control need it, and neither should have to depend on the other for it.
 */
export function lockfileHeld(store: StoreLayout): boolean {
  const lockfile = path.join(store.root, 'lockfile');
  if (!existsSync(lockfile)) return false;
  try {
    renameSync(lockfile, lockfile);
    return false;
  } catch {
    return true;
  }
}
