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

/**
 * A card a repoint wants to rewrite, with what decides whether the app holds it.
 *
 * `native` — the app wrote this card, so it has always had it. `fosteredAt` is
 * present only for foster's own copies, from the ledger entry that recorded one.
 */
export interface WritableCard {
  path: string;
  native: boolean;
  fosteredAt?: number;
}

/**
 * Gate for rewriting cards in place. Injectable for the same reason as above.
 *
 * Returns the split rather than a yes or no: the answer stopped being the same
 * for every card in the batch, and a guard that could only throw forced the
 * caller to ask a second, uninjectable question to find out which ones. A guard
 * that refuses outright still may — throwing is how "none of these" is said.
 */
export type WriteGuard = (
  store: StoreLayout,
  cards: WritableCard[],
) => { writable: WritableCard[]; held: WritableCard[] };

/**
 * Whether a running app has this card in memory.
 *
 * The hazard is the one removal has: a card the app holds is one it may write
 * back at any time — a focus timestamp is enough — carrying the pointer the app
 * remembers and quietly undoing the write.
 *
 * This used to be asked of the installation rather than the card, on the
 * reasoning that a row being repointed is "one the user can see, which means the
 * app read it at startup". That is true of a card the app wrote, and false of a
 * copy foster wrote after the app started: the app is past its one read of the
 * directory, so that file is not in memory at all — which is why it takes a
 * restart to appear, and why it cannot be opened, retitled or refocused in the
 * meantime. It is the same fact `heldInMemory` uses to let `return` remove such
 * a copy while the app runs, applied to a write instead of a delete.
 *
 * The conservative answers stay conservative: a native card is held for as long
 * as the app runs, and so is any copy when the app's start time cannot be read.
 */
export function appHolds(card: WritableCard, desktop: DesktopState): boolean {
  if (card.native || card.fosteredAt === undefined) return true;
  if (desktop.startedAt === undefined) return true;
  return card.fosteredAt < desktop.startedAt;
}

/**
 * Split the batch into what can be written now and what the app is holding.
 *
 * Grouped by the installation each card lives in, not by the store foster
 * resolved: cards can sit in another profile, and asking this app about a file
 * another app is holding answers about the wrong process.
 */
export function partitionWritable(
  cards: WritableCard[],
  list: ProcessLister = readProcesses,
): { writable: WritableCard[]; held: WritableCard[] } {
  const writable: WritableCard[] = [];
  const held: WritableCard[] = [];
  const desktops = new Map<string, DesktopState | undefined>();

  for (const card of cards) {
    // A path with no file is nothing to protect; the write itself will report it.
    if (!existsSync(card.path)) {
      writable.push(card);
      continue;
    }
    const root = comparablePath(storeRootOfCopy(card.path));
    if (!desktops.has(root)) {
      desktops.set(
        root,
        lockfileHeld(layoutFor(root)) ? inspectDesktopFor(storeIdentity(root), list) : undefined,
      );
    }
    const desktop = desktops.get(root);
    if (desktop?.running && appHolds(card, desktop)) held.push(card);
    else writable.push(card);
  }

  return { writable, held };
}

/**
 * The same split, refusing outright when none of it can be written.
 *
 * Throwing is how "none of these" is said — that is the case the message was
 * written for, and it belongs at the top of the run rather than repeated under
 * every row. With something to do, the caller reports the held ones beside the
 * ones that moved: one native card in a batch of fifteen used to refuse the
 * other fourteen, which is a whole tidy-up abandoned for the one part of it that
 * has to wait.
 */
export function assertCardsWritable(
  store: StoreLayout,
  cards: WritableCard[],
  list: ProcessLister = readProcesses,
): { writable: WritableCard[]; held: WritableCard[] } {
  const split = partitionWritable(cards, list);
  if (split.writable.length > 0 || split.held.length === 0) return split;

  const busy = new Set(split.held.map((card) => comparablePath(storeRootOfCopy(card.path))));
  const count = split.held.length;
  const where =
    busy.size === 1 && busy.has(comparablePath(store.root))
      ? 'Claude Desktop is running'
      : `Claude Desktop is running on ${busy.size === 1 ? 'the installation holding them' : `${busy.size} installations holding them`}`;

  throw new AppRunningError(
    `${where} and has ${count} of these ${count === 1 ? 'card' : 'cards'} loaded.
` +
      'A card it holds is one it will write back from memory, pointer and all, so the change ' +
      'would not survive. Close the app first — foster can do that for you.',
  );
}

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
