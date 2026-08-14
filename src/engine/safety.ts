import { existsSync } from 'node:fs';
import { comparablePath, layoutFor, storeIdentity, storeRootOfCopy } from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import type { ActiveFostering } from '../ledger/types.js';
import {
  inspectDesktopFor,
  type DesktopState,
  type ProcessLister,
  readProcesses,
} from './desktop.js';
import { lockfileHeld } from './lockfile.js';

/**
 * When a running Claude Desktop matters, and when it does not.
 *
 * The app reads the session directory once, when it initialises its session
 * store, and holds everything it found in memory from then on. Two consequences
 * decide this whole module:
 *
 *  - **Adding** a copy is safe while the app runs. The copy carries a session id
 *    the app has never seen, so nothing in memory maps to that file: the app will
 *    not read it (it is past its one read) and will not write it (it only writes
 *    sessions it holds). It simply will not appear until the app initialises
 *    again.
 *  - **Removing** a copy is only safe if the app never loaded it. A copy the app
 *    holds in memory is one it may write back at any time — on a title change, on
 *    a focus timestamp — which would recreate the file foster just deleted.
 *
 * So fostering no longer demands a closed app, and returning demands it only for
 * the copies the app could be holding.
 */

export interface AppState {
  running: boolean;
  /** How it was detected, for an honest message to the user. */
  evidence: string[];
}

/**
 * The cheap check: lockfile first, then the same process table everything else
 * reads.
 *
 * A name scan (`Claude.exe`) cannot tell the Desktop app from the Code CLI it
 * spawns — they share the image name. The table already knows the difference
 * (the CLI lives under `claude-code`). Asking it here means a live `claude` on
 * a closed store cannot make that store look busy.
 */
export function inspectApp(
  store: StoreLayout,
  env: NodeJS.ProcessEnv = process.env,
  list: ProcessLister = readProcesses,
): AppState {
  const evidence: string[] = [];
  if (lockfileHeld(store)) evidence.push('userData lockfile is held by a running app');
  if (inspectDesktopFor(storeIdentity(store.root, env), list, env).running) {
    evidence.push('Claude Desktop is running');
  }
  return { running: evidence.length > 0, evidence };
}

export class AppRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppRunningError';
  }
}

/**
 * The fosterings a running app may be holding in memory.
 *
 * A copy written after the app started cannot have been loaded by it — the app
 * read the directory before that file existed. Anything older may be in memory,
 * and is treated as such. When the app's start time cannot be read, every copy is
 * treated as held: guessing wrong in that direction only costs a restart, while
 * guessing wrong the other way silently resurrects deleted copies.
 *
 * Switching organisation makes the app re-read the directory mid-run, which this
 * cannot see; that is why the conservative default matters.
 */
export function heldInMemory(
  fosterings: ActiveFostering[],
  desktop: DesktopState,
): ActiveFostering[] {
  if (!desktop.running) return [];
  if (desktop.startedAt === undefined) return fosterings;
  return fosterings.filter((fostering) => fostering.fosteredAt < desktop.startedAt!);
}

/**
 * Gate for removal. Injectable so tests drive a synthetic store without a real
 * app on the machine deciding whether they pass.
 */
export type RemovalGuard = (store: StoreLayout, fosterings: ActiveFostering[]) => void;

export function assertRemovable(
  store: StoreLayout,
  fosterings: ActiveFostering[],
  list: ProcessLister = readProcesses,
): void {
  // Grouped by the installation each copy actually lives in, not by the store
  // foster resolved. Copies can be written into another profile, and the ledger
  // holds them all — asking one app about a file another app is holding would
  // answer "safe to delete" about exactly the file that gets written back.
  const byStore = new Map<string, ActiveFostering[]>();
  for (const fostering of fosterings) {
    // A copy that is not on disk cannot be held in memory by anything, and the
    // app cannot write back a file it no longer has. Without this the gate turned
    // the one way out of a stale ledger entry into a dead end: the user deletes a
    // copy in the app, `return` refuses because the copy predates the app's
    // start, and closing the app changes nothing because there was never a file.
    if (!existsSync(fostering.copyPath)) continue;
    // Keyed by the comparable form so two spellings of one directory do not
    // become two groups, each asking about half the copies.
    const root = comparablePath(storeRootOfCopy(fostering.copyPath));
    byStore.set(root, [...(byStore.get(root) ?? []), fostering]);
  }

  const held: ActiveFostering[] = [];
  for (const [root, group] of byStore) {
    const owner = layoutFor(root);
    // Cheap check first: with no app holding that store there is nothing to
    // reason about, and no reason to pay for a process table.
    if (!lockfileHeld(owner)) continue;
    held.push(...heldInMemory(group, inspectDesktopFor(storeIdentity(root), list)));
  }

  if (held.length === 0) return;

  const count = held.length;
  const stores = new Set(held.map((f) => comparablePath(storeRootOfCopy(f.copyPath))));
  const where =
    stores.size === 1 && stores.has(comparablePath(store.root))
      ? 'Claude Desktop is running'
      : `Claude Desktop is running on ${stores.size === 1 ? 'the installation holding them' : `${stores.size} installations holding them`}`;

  throw new AppRunningError(
    `${where} and has ${count} of these ${count === 1 ? 'copy' : 'copies'} loaded.\n` +
      'Removing one it holds in memory only makes it write the file back. Close the app first — ' +
      'foster can do that for you.',
  );
}
