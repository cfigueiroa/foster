import { candidateStoreRoots, directoryKey, layoutFor, storeRootOfCopy } from '../domain/paths.js';
import type { LedgerEvent } from '../ledger/types.js';
import { readProcesses, runningStores, type ProcessLister } from './desktop.js';
import { lockfileHeld } from './lockfile.js';

/**
 * Every installation foster can name without being told.
 *
 * Three sources, and all three are needed. The installed app, so switching back
 * to it from a profile does not mean typing a package path. The instances that
 * are up, because a profile announces itself nowhere but on its own command
 * line. And the stores the ledger has written into before — a stopped profile is
 * written down nowhere else, and having to retype its path on every visit was
 * the whole friction.
 *
 * Directories that have since gone are dropped rather than offered: a menu entry
 * that fails when picked is worse than one that was never there.
 */
export interface KnownStore {
  root: string;
  /**
   * How foster came to know about it. A store that only a command line names is
   * a profile by definition — nothing else could have started it that way.
   */
  hint: 'installed app' | 'profile' | 'used before';
  running: boolean;
}

/** Just the read: this takes the ledger's events, not the object holding them. */
export function knownStores(
  events: LedgerEvent[],
  env: NodeJS.ProcessEnv = process.env,
  list: ProcessLister = readProcesses,
): KnownStore[] {
  const seen = new Set<string>();
  const stores: KnownStore[] = [];

  const offer = (root: string, hint: KnownStore['hint']): void => {
    const store = layoutFor(root);
    // The filesystem decides what is the same store and what still exists. A
    // directory that has gone is dropped rather than offered — a menu entry that
    // fails when picked is worse than one that was never there — and a profile
    // with no sessions yet is kept, because that is exactly a store you would be
    // sending sessions to.
    const key = directoryKey(store.root);
    if (key === undefined || seen.has(key)) return;
    seen.add(key);
    stores.push({ root: store.root, hint, running: lockfileHeld(store) });
  };

  for (const dir of candidateStoreRoots(env)) offer(dir, 'installed app');
  for (const dir of runningStores(list)) offer(dir, 'profile');
  for (const event of events) {
    if (event.kind === 'fostered') offer(storeRootOfCopy(event.copyPath), 'used before');
  }

  return stores;
}
