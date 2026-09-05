import { existsSync } from 'node:fs';
import { worktreeClaim } from '../domain/fostering.js';
import { comparablePath, samePath, storeRootOfCopy } from '../domain/paths.js';
import type { CodeSessionData, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, listWorktreeReleased, project, type LedgerState } from '../ledger/project.js';
import type { LedgerEvent } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import { errorMessage } from '../util/fs.js';
import { writeFileAtomic } from '../util/fsatomic.js';
import { assertCardsWritable, type WritableCard, type WriteGuard } from './safety.js';

/**
 * Releasing the worktree claim a copy inherited when it was written, before
 * `buildFosterCopy` learned to drop it (0.38.0, #27). That fix only reaches a
 * copy being minted from here on; issue #26's second half is what is already on
 * disk — measured at 807 copies naming a worktree, 109 of those directories
 * claimed by more than one live card.
 *
 * The write is the same one `buildFosterCopy` would have made at the time: the
 * three claim fields removed, `cwd` moved to `originCwd` when that is somewhere
 * else. Everything else on the card — its identity, its title, its dates,
 * whatever keys the app has added since — is carried through verbatim, the
 * discipline `repointCards` and `retitleCards` both keep.
 *
 * Only copies are ever candidates. `worktreeClaim` cannot tell a copy from a
 * card the app wrote — the fields look the same either way — so the ledger
 * decides instead: a candidate is one of the active fosterings it already
 * tracks, never a card discovered by scanning the store. A native card keeping
 * a stale claim is #26's first left-open follow-up, not this one's to touch.
 */

export interface UnclaimItem {
  path: string;
  sessionId: string;
  title: string;
  worktreePath?: string;
  worktreeName?: string;
  worktreeLazy?: unknown;
  /** The `cwd` the card wears now. */
  cwdFrom: string | undefined;
  /** Where `cwd` would move to; undefined when it is already there. */
  cwdTo?: string;
}

export interface PlanUnclaimSkipped {
  /** An active fostering whose copy is no longer on disk. */
  gone: number;
  /** A copy on disk that could not be parsed as a session. */
  unreadable: number;
  /** A copy read fine and carries no worktree claim at all. */
  noClaim: number;
}

export interface PlanUnclaimResult {
  items: UnclaimItem[];
  skipped: PlanUnclaimSkipped;
}

export interface PlanUnclaimOptions {
  /** Injectable for tests; defaults to reading the file straight off disk. */
  read?: (path: string) => CodeSessionData | undefined;
}

/**
 * What a release would do, without writing anything.
 *
 * Reads only what the ledger already tracks: the active fosterings in this
 * store. That is what keeps a native card out of reach by construction rather
 * than by a check that could be wrong — a card the app wrote was never
 * recorded as a fostering, so it can never appear in `listActive`.
 */
export function planUnclaim(
  store: StoreLayout,
  ledger: LedgerState | LedgerEvent[],
  opts: PlanUnclaimOptions = {},
): PlanUnclaimResult {
  const state = Array.isArray(ledger) ? project(ledger) : ledger;
  const read = opts.read ?? readSessionFile;
  const root = comparablePath(store.root);

  const items: UnclaimItem[] = [];
  const skipped: PlanUnclaimSkipped = { gone: 0, unreadable: 0, noClaim: 0 };

  for (const fostering of listActive(state)) {
    // Only the copies this store holds. The ledger tracks fosterings across
    // every installation foster has ever written into, and a copy sitting in
    // another profile is not this run's to touch.
    if (comparablePath(storeRootOfCopy(fostering.copyPath)) !== root) continue;

    if (!existsSync(fostering.copyPath)) {
      skipped.gone += 1;
      continue;
    }

    const data = read(fostering.copyPath);
    if (!data) {
      skipped.unreadable += 1;
      continue;
    }

    const claim = worktreeClaim(data);
    if (!claim) {
      skipped.noClaim += 1;
      continue;
    }

    items.push({
      path: fostering.copyPath,
      sessionId: data.sessionId,
      title: data.title ?? data.sessionId,
      ...(claim.worktreePath !== undefined ? { worktreePath: claim.worktreePath } : {}),
      ...(claim.worktreeName !== undefined ? { worktreeName: claim.worktreeName } : {}),
      ...(claim.worktreeLazy !== undefined ? { worktreeLazy: claim.worktreeLazy } : {}),
      cwdFrom: data.cwd,
      ...(claim.cwdTo !== undefined ? { cwdTo: claim.cwdTo } : {}),
    });
  }

  return { items, skipped };
}

export interface UnclaimOutcome {
  path: string;
  sessionId: string;
  title: string;
  status: 'released' | 'skipped' | 'failed';
  detail?: string;
  worktreePath?: string;
  worktreeName?: string;
  cwdFrom?: string;
  cwdTo?: string;
}

export interface ApplyUnclaimOptions {
  store: StoreLayout;
  ledger: Ledger;
  guard?: WriteGuard;
}

function describeItem(
  item: UnclaimItem,
  status: UnclaimOutcome['status'],
  detail?: string,
): UnclaimOutcome {
  return {
    path: item.path,
    sessionId: item.sessionId,
    title: item.title,
    status,
    ...(detail ? { detail } : {}),
    ...(item.worktreePath !== undefined ? { worktreePath: item.worktreePath } : {}),
    ...(item.worktreeName !== undefined ? { worktreeName: item.worktreeName } : {}),
    ...(item.cwdFrom !== undefined ? { cwdFrom: item.cwdFrom } : {}),
    ...(item.cwdTo !== undefined ? { cwdTo: item.cwdTo } : {}),
  };
}

/**
 * Write the release, one item at a time.
 *
 * Same order as `repointCards`: the write happens first, and only a completed
 * write is recorded, so a crash between the two never leaves the ledger
 * claiming a release that the file does not show. Guarded the same way too —
 * `assertCardsWritable` refuses only when *none* of the batch can be written,
 * and otherwise reports what the app is holding beside what moved, because a
 * copy fostered after the app's last start was never read by it and can be
 * rewritten safely; the change is simply invisible until a restart, the way
 * `retitleCards` explains for its own writes.
 */
export function applyUnclaim(items: UnclaimItem[], options: ApplyUnclaimOptions): UnclaimOutcome[] {
  const { store, ledger, guard = assertCardsWritable } = options;
  const outcomes: UnclaimOutcome[] = [];
  const holding = new Set<string>();

  if (items.length > 0) {
    const fosteredAt = new Map<string, number>();
    for (const fostering of listActive(project(ledger.read()))) {
      fosteredAt.set(comparablePath(fostering.copyPath), fostering.fosteredAt);
    }
    const cards: WritableCard[] = items.map((item) => {
      const at = fosteredAt.get(comparablePath(item.path));
      return { path: item.path, native: false, ...(at === undefined ? {} : { fosteredAt: at }) };
    });
    const { held } = guard(store, cards);
    for (const card of held) holding.add(comparablePath(card.path));
  }

  for (const item of items) {
    if (holding.has(comparablePath(item.path))) {
      outcomes.push(
        describeItem(
          item,
          'skipped',
          'Claude Desktop has this card loaded — close it and run this again',
        ),
      );
      continue;
    }

    const data = readSessionFile(item.path);
    if (!data) {
      outcomes.push(describeItem(item, 'failed', 'the card could not be read'));
      continue;
    }

    try {
      const written: CodeSessionData = { ...data };
      delete written.worktreePath;
      delete written.worktreeName;
      delete written.worktreeLazy;
      if (item.cwdTo !== undefined) written.cwd = item.cwdTo;

      writeFileAtomic(item.path, JSON.stringify(written));
      ledger.append({
        kind: 'worktree_released',
        path: item.path,
        sessionId: data.sessionId,
        ...(item.worktreePath !== undefined ? { worktreePath: item.worktreePath } : {}),
        ...(item.worktreeName !== undefined ? { worktreeName: item.worktreeName } : {}),
        ...(item.worktreeLazy !== undefined ? { worktreeLazy: item.worktreeLazy } : {}),
        ...(item.cwdFrom !== undefined ? { cwdFrom: item.cwdFrom } : {}),
        ...(item.cwdTo !== undefined ? { cwdTo: item.cwdTo } : {}),
      });
      outcomes.push(describeItem(item, 'released'));
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'unclaim', reason });
      outcomes.push(describeItem(item, 'failed', reason));
    }
  }

  return outcomes;
}

export interface UndoUnclaimOutcome {
  path: string;
  sessionId: string;
  status: 'undone' | 'skipped' | 'failed';
  detail?: string;
}

export interface UndoUnclaimOptions {
  store: StoreLayout;
  ledger: Ledger;
  dryRun?: boolean;
  guard?: WriteGuard;
}

/**
 * Put back what a release removed — only where nothing has moved on since.
 *
 * The card has to still be exactly where the release left it: `cwd` reading as
 * `cwdTo` (or, when the release never moved it, `cwdFrom`) and none of the
 * three claim fields present. A card that has since been repointed, retitled
 * into a different `cwd`, or handed a fresh worktree by the app is left alone
 * and reported rather than overwritten — the same restraint `undoRequests`
 * takes for granted because a repoint's `from`/`to` are a single field, where
 * this has four to get right or none at all.
 */
export function undoUnclaim(options: UndoUnclaimOptions): UndoUnclaimOutcome[] {
  const { store, ledger, dryRun = false, guard = assertCardsWritable } = options;
  const pending = listWorktreeReleased(project(ledger.read()));
  const outcomes: UndoUnclaimOutcome[] = [];

  const holding = new Set<string>();
  if (!dryRun && pending.length > 0) {
    const fosteredAt = new Map<string, number>();
    for (const fostering of listActive(project(ledger.read()))) {
      fosteredAt.set(comparablePath(fostering.copyPath), fostering.fosteredAt);
    }
    const cards: WritableCard[] = pending.map((card) => {
      const at = fosteredAt.get(comparablePath(card.path));
      return { path: card.path, native: false, ...(at === undefined ? {} : { fosteredAt: at }) };
    });
    const { held } = guard(store, cards);
    for (const card of held) holding.add(comparablePath(card.path));
  }

  for (const card of pending) {
    if (holding.has(comparablePath(card.path))) {
      outcomes.push({
        path: card.path,
        sessionId: card.sessionId,
        status: 'skipped',
        detail: 'Claude Desktop has this card loaded — close it and run this again',
      });
      continue;
    }

    const data = readSessionFile(card.path);
    if (!data) {
      outcomes.push({
        path: card.path,
        sessionId: card.sessionId,
        status: 'failed',
        detail: 'the card could not be read',
      });
      continue;
    }

    const expectedCwd = card.cwdTo ?? card.cwdFrom;
    const cwdMatches =
      expectedCwd === undefined
        ? data.cwd === undefined
        : typeof data.cwd === 'string' && samePath(data.cwd, expectedCwd);
    const stillReleased =
      data.worktreePath === undefined &&
      data.worktreeName === undefined &&
      data.worktreeLazy === undefined;

    if (!cwdMatches || !stillReleased) {
      outcomes.push({
        path: card.path,
        sessionId: card.sessionId,
        status: 'skipped',
        detail: 'the card moved on since the release',
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({ path: card.path, sessionId: card.sessionId, status: 'undone' });
      continue;
    }

    try {
      const restored: CodeSessionData = { ...data };
      if (card.worktreePath !== undefined) restored.worktreePath = card.worktreePath;
      if (card.worktreeName !== undefined) restored.worktreeName = card.worktreeName;
      if (card.worktreeLazy !== undefined) restored.worktreeLazy = card.worktreeLazy;
      if (card.cwdFrom !== undefined) restored.cwd = card.cwdFrom;

      writeFileAtomic(card.path, JSON.stringify(restored));
      ledger.append({ kind: 'worktree_release_undone', path: card.path });
      outcomes.push({ path: card.path, sessionId: card.sessionId, status: 'undone' });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'unclaim-undo', reason });
      outcomes.push({
        path: card.path,
        sessionId: card.sessionId,
        status: 'failed',
        detail: reason,
      });
    }
  }

  return outcomes;
}
