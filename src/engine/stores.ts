import { existsSync } from 'node:fs';
import {
  candidateStoreRoots,
  directoryKey,
  layoutFor,
  resolveStore,
  storeRootOfCopy,
} from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import type { LedgerEvent } from '../ledger/types.js';
import { readProcesses, runningStores, type ProcessLister } from './desktop.js';
import { lockfileHeld } from './lockfile.js';
import { readConfig } from '../store/config.js';

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
  /**
   * The account this installation last recorded, when it has one. With profiles
   * the whole point is that each holds a different account, so which one is the
   * question being asked — and a store with none has not been signed into yet,
   * which is why fostering into it refuses.
   */
  accountUuid?: string;
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
    const accountUuid = readConfig(store).lastKnownAccountUuid;
    stores.push({
      root: store.root,
      hint,
      running: lockfileHeld(store),
      ...(accountUuid ? { accountUuid } : {}),
    });
  };

  for (const dir of candidateStoreRoots(env)) offer(dir, 'installed app');
  for (const dir of runningStores(list)) offer(dir, 'profile');
  for (const event of events) {
    if (event.kind === 'fostered') offer(storeRootOfCopy(event.copyPath), 'used before');
  }

  return stores;
}

/**
 * What `--store` names: a directory, or a distinctive piece of one.
 *
 * The paths are long, and a profile's is the sort of thing nobody remembers
 * exactly — `--store work` for `D:\Claude-Work` is the same abbreviation the
 * identifier flags already allow. A path that exists is always taken as a path,
 * so this can only add meanings, never change one.
 *
 * An abbreviation matching two installations is reported rather than guessed at,
 * for the same reason `--from` refuses an ambiguous prefix: with `--store` the
 * guess decides which installation gets written to.
 */
export function resolveStoreArg(
  arg: string | undefined,
  // A thunk, not the events: the two answers that need no ledger at all are the
  // two every ordinary run takes, and reading it for them would be work done to
  // be thrown away.
  readEvents: () => LedgerEvent[],
  env: NodeJS.ProcessEnv = process.env,
  list: ProcessLister = readProcesses,
): StoreLayout {
  if (arg === undefined) return resolveStore(undefined, env);
  if (existsSync(arg)) return layoutFor(arg);

  const wanted = arg.toLowerCase();
  const stores = knownStores(readEvents(), env, list);
  const matches = stores.filter((store) => store.root.toLowerCase().includes(wanted));

  if (matches.length === 1) return layoutFor(matches[0]!.root);
  if (matches.length > 1) {
    const lines = matches.map((store) => `  ${store.root}`).join('\n');
    throw new Error(`--store "${arg}" matches ${matches.length} installations:\n${lines}`);
  }

  // Nothing on disk and nothing known: a typo, most likely, and continuing would
  // quietly report an empty store rather than say so.
  const known = stores.map((store) => `  ${store.root}`).join('\n');
  throw new Error(
    `--store "${arg}" is not a directory, and no installation foster knows about matches it.` +
      (known ? `\nKnown installations:\n${known}` : ''),
  );
}
