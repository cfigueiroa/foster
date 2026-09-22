import path from 'node:path';
import { listAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import {
  backupLocalStorage,
  localStorageDir,
  readLocalStorageValue,
  writeLocalStorageValue,
  type LocalStorageRecord,
} from '../store/localStorage.js';
import {
  ACTIVITY_DAYS_KEY,
  emptyProjectsKey,
  environmentsKey,
  legacyViewKeysPresent,
  prStatusKey,
  readActivityDays,
  readViewAccountPrefs,
  writeEpitaxyPrefs,
  type ViewAccountPrefs,
} from '../store/viewPrefs.js';
import { AppRunningError, inspectApp } from './safety.js';
import { readProcesses, type ProcessLister } from './desktop.js';

/**
 * The Code sidebar's filter menu — reading and changing both halves at once.
 *
 * Seven settings, two stores: `store/localStorage.ts` for the three that are
 * machine-wide, `store/viewPrefs.ts` for the four that are per account. Both
 * are files the app owns and rewrites from memory, so — like `layout.ts` —
 * every write here refuses outright while Claude Desktop is running.
 */

const DFRAME_STORE_KEY = 'dframe-store';

/** The CLI's own words, mapped to the value the app stores — one table per setting. */
export const STATUS_WORDS = ['active', 'archived', 'all'] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

export const GROUP_BY_WORDS: Record<string, string> = {
  date: 'date',
  folder: 'project',
  state: 'state',
  custom: 'custom',
  none: 'none',
};
export const GROUP_BY_STORED_TO_WORD: Record<string, string> = Object.fromEntries(
  Object.entries(GROUP_BY_WORDS).map(([word, stored]) => [stored, word]),
);

export const SORT_WORDS: Record<string, string> = {
  activity: 'recency',
  name: 'alpha',
  created: 'created',
};
export const SORT_STORED_TO_WORD: Record<string, string> = Object.fromEntries(
  Object.entries(SORT_WORDS).map(([word, stored]) => [stored, word]),
);

export const ENV_WORDS: Record<string, string> = {
  local: 'local',
  cloud: 'remote',
  'remote-control': 'bridge',
  ssh: 'ssh',
  slack: 'slack',
};
export const ENV_STORED_TO_WORD: Record<string, string> = Object.fromEntries(
  Object.entries(ENV_WORDS).map(([word, stored]) => [stored, word]),
);

export interface ViewState {
  /** `recentsStatusFilter`; undefined when the app has never written it. */
  status?: string;
  /** `groupByByMode.code`; undefined when the app has never written it. */
  groupBy?: string;
  /** `sortByByMode.code`; the app treats absence as `recency`. */
  sort: string;
  account: ViewAccountPrefs;
  activityDays?: number;
  legacy: string[];
  /** Absent when Local Storage has never recorded this key at all. */
  machineRecord?: LocalStorageRecord;
}

export function readViewState(store: StoreLayout, account: AccountRef): ViewState {
  const machineRecord = readMachineRecordQuietly(store);
  const state = (machineRecord?.document.state as Record<string, unknown> | undefined) ?? {};
  const groupByMode = state.groupByByMode as Record<string, unknown> | undefined;
  const sortByMode = state.sortByByMode as Record<string, unknown> | undefined;

  return {
    ...(typeof state.recentsStatusFilter === 'string' ? { status: state.recentsStatusFilter } : {}),
    ...(typeof groupByMode?.code === 'string' ? { groupBy: groupByMode.code } : {}),
    // Measured: absence means `recency` — the app never writes the key for its
    // own default, so a store nothing has ever sorted still has an answer.
    sort: typeof sortByMode?.code === 'string' ? sortByMode.code : 'recency',
    account: readViewAccountPrefs(store, account),
    ...(readActivityDays(store) !== undefined ? { activityDays: readActivityDays(store) } : {}),
    legacy: legacyViewKeysPresent(store),
    ...(machineRecord ? { machineRecord } : {}),
  };
}

function readMachineRecordQuietly(store: StoreLayout): LocalStorageRecord | undefined {
  try {
    return readLocalStorageValue(store, DFRAME_STORE_KEY);
  } catch {
    // No Local Storage database yet, or one this reader cannot make sense of —
    // either way there is nothing machine-wide to report, not an error to throw
    // from a read.
    return undefined;
  }
}

export interface ViewChange {
  field: 'status' | 'group-by' | 'sort' | 'env' | 'empty-groups' | 'pr-status' | 'activity-days';
  from: unknown;
  to: unknown;
}

export interface ViewSetRequest {
  status?: StatusWord;
  groupBy?: keyof typeof GROUP_BY_WORDS;
  sort?: keyof typeof SORT_WORDS;
  /** CLI words, or `'all'` for every environment. */
  env?: (keyof typeof ENV_WORDS)[] | 'all';
  emptyGroups?: boolean;
  prStatus?: boolean;
  activityDays?: 0 | 1 | 3 | 7 | 30;
}

export interface ViewSetPlan {
  target: AccountRef;
  changes: ViewChange[];
  machine: { status?: string; groupBy?: string; sort?: string };
  account: Record<string, unknown>;
  /** True when `--group-by state` forced `status` to `active` — the app's own rule. */
  impliedStatusActive: boolean;
}

export function planViewSet(
  store: StoreLayout,
  target: AccountRef,
  request: ViewSetRequest,
): ViewSetPlan {
  const current = readViewState(store, target);
  const changes: ViewChange[] = [];
  const machine: ViewSetPlan['machine'] = {};
  const account: Record<string, unknown> = {};
  let impliedStatusActive = false;

  let status = request.status;
  if (request.groupBy === 'state' && current.status !== 'active') {
    // The app's own rule: grouping by state only makes sense with the active
    // filter, so it sets one when the other is asked for.
    status = status ?? 'active';
    impliedStatusActive = true;
  }
  if (status !== undefined && status !== current.status) {
    changes.push({ field: 'status', from: current.status, to: status });
    machine.status = status;
  }

  if (request.groupBy !== undefined) {
    const stored = GROUP_BY_WORDS[request.groupBy]!;
    if (stored !== current.groupBy) {
      changes.push({ field: 'group-by', from: current.groupBy, to: request.groupBy });
      machine.groupBy = stored;
    }
  }

  if (request.sort !== undefined) {
    const stored = SORT_WORDS[request.sort]!;
    if (stored !== current.sort) {
      changes.push({ field: 'sort', from: current.sort, to: request.sort });
      machine.sort = stored;
    }
  }

  if (request.env !== undefined) {
    const stored = request.env === 'all' ? [] : request.env.map((word) => ENV_WORDS[word]!);
    const before = current.account.environments ?? [];
    if (JSON.stringify([...stored].sort()) !== JSON.stringify([...before].sort())) {
      changes.push({ field: 'env', from: before, to: stored });
      account[environmentsKey(target)] = stored.length > 0 ? stored : undefined;
    }
  }

  if (
    request.emptyGroups !== undefined &&
    request.emptyGroups !== current.account.showEmptyProjects
  ) {
    changes.push({
      field: 'empty-groups',
      from: current.account.showEmptyProjects ?? false,
      to: request.emptyGroups,
    });
    account[emptyProjectsKey(target)] = request.emptyGroups;
  }

  if (
    request.prStatus !== undefined &&
    request.prStatus !== (current.account.showPrStatus ?? true)
  ) {
    changes.push({
      field: 'pr-status',
      from: current.account.showPrStatus ?? true,
      to: request.prStatus,
    });
    account[prStatusKey(target)] = request.prStatus;
  }

  if (request.activityDays !== undefined && request.activityDays !== current.activityDays) {
    changes.push({ field: 'activity-days', from: current.activityDays, to: request.activityDays });
    account[ACTIVITY_DAYS_KEY] = request.activityDays;
  }

  return { target, changes, machine, account, impliedStatusActive };
}

export interface ApplyViewOptions {
  store: StoreLayout;
  env?: NodeJS.ProcessEnv;
  list?: ProcessLister;
  now?: () => Date;
  /** Where to copy the Local Storage database before writing; a fresh directory per call by default. */
  backupDir?: string;
}

function assertClosed(store: StoreLayout, options: ApplyViewOptions): void {
  const app = inspectApp(store, options.env, options.list ?? readProcesses);
  if (app.running) {
    throw new AppRunningError(
      'Claude Desktop rewrites its own config while it runs; close it or add --restart.',
    );
  }
}

export function applyViewSet(plan: ViewSetPlan, options: ApplyViewOptions): { backups: string[] } {
  const { store } = options;
  assertClosed(store, options);
  const backups: string[] = [];

  const { status, groupBy, sort } = plan.machine;
  if (status !== undefined || groupBy !== undefined || sort !== undefined) {
    const record = readLocalStorageValue(store, DFRAME_STORE_KEY);
    if (!record) {
      throw new Error(
        'Local Storage has never recorded the sidebar filters — open the Code sidebar in ' +
          'Claude Desktop once, so there is a record for foster to change.',
      );
    }
    const state = { ...((record.document.state as Record<string, unknown>) ?? {}) };
    if (status !== undefined) state.recentsStatusFilter = status;
    if (groupBy !== undefined) {
      state.groupByByMode = { ...((state.groupByByMode as object) ?? {}), code: groupBy };
    }
    if (sort !== undefined) {
      state.sortByByMode = { ...((state.sortByByMode as object) ?? {}), code: sort };
    }

    const backup = backupLocalStorage(
      store,
      options.backupDir ??
        path.join(localStorageDir(store), '..', `leveldb-bak-foster-${Date.now()}`),
    );
    backups.push(backup);
    writeLocalStorageValue(record, DFRAME_STORE_KEY, { ...record.document, state });
  }

  if (Object.keys(plan.account).length > 0) {
    const { backup } = writeEpitaxyPrefs(store, plan.account, { now: options.now });
    backups.push(backup);
  }

  return { backups };
}

export interface ViewCopyPlan {
  from: AccountRef;
  to: AccountRef;
  changes: ViewChange[];
  account: Record<string, unknown>;
}

/**
 * The per-account half only — `store/localStorage.ts`'s half is machine-wide
 * and there is nothing to copy about it.
 */
export function planViewCopy(store: StoreLayout, from: AccountRef, to: AccountRef): ViewCopyPlan {
  const source = readViewAccountPrefs(store, from);
  const target = readViewAccountPrefs(store, to);
  const changes: ViewChange[] = [];
  const account: Record<string, unknown> = {};

  const sourceEnv = source.environments ?? [];
  const targetEnv = target.environments ?? [];
  if (JSON.stringify([...sourceEnv].sort()) !== JSON.stringify([...targetEnv].sort())) {
    changes.push({ field: 'env', from: targetEnv, to: sourceEnv });
    account[environmentsKey(to)] = sourceEnv.length > 0 ? sourceEnv : undefined;
  }

  if ((source.showEmptyProjects ?? false) !== (target.showEmptyProjects ?? false)) {
    changes.push({
      field: 'empty-groups',
      from: target.showEmptyProjects ?? false,
      to: source.showEmptyProjects ?? false,
    });
    if (source.showEmptyProjects !== undefined)
      account[emptyProjectsKey(to)] = source.showEmptyProjects;
  }

  if ((source.showPrStatus ?? true) !== (target.showPrStatus ?? true)) {
    changes.push({
      field: 'pr-status',
      from: target.showPrStatus ?? true,
      to: source.showPrStatus ?? true,
    });
    if (source.showPrStatus !== undefined) account[prStatusKey(to)] = source.showPrStatus;
  }

  return { from, to, changes, account };
}

export function applyViewCopy(
  plan: ViewCopyPlan,
  options: ApplyViewOptions,
): { backups: string[] } {
  if (Object.keys(plan.account).length === 0) return { backups: [] };
  assertClosed(options.store, options);
  const { backup } = writeEpitaxyPrefs(options.store, plan.account, { now: options.now });
  return { backups: [backup] };
}

// ---------------------------------------------------------------------------
// Layout's own carry-over of the per-account half — see spec part 2, "layout
// also carries the per-account half (B) from the source account when the
// target has none of those keys set".
// ---------------------------------------------------------------------------

export interface LayoutViewCarry {
  from?: AccountRef;
  changes: ViewChange[];
  account: Record<string, unknown>;
}

function hasAnyAccountPref(prefs: ViewAccountPrefs): boolean {
  return (
    prefs.environments !== undefined ||
    prefs.showEmptyProjects !== undefined ||
    prefs.showPrStatus !== undefined
  );
}

/**
 * The same "user's own choice wins" rule `engine/layout.ts` applies to groups,
 * applied to the sidebar filter menu: nothing is borrowed unless the target has
 * none of these three set at all, and then the whole set comes from one
 * account — the first other account that has any of them, in the order
 * `listAccountDirs` gives.
 */
export function planLayoutViewCarry(store: StoreLayout, target: AccountRef): LayoutViewCarry {
  const targetPrefs = readViewAccountPrefs(store, target);
  if (hasAnyAccountPref(targetPrefs)) return { changes: [], account: {} };

  const others = listAccountDirs(store).filter(
    (candidate) =>
      !(
        candidate.accountUuid === target.accountUuid &&
        candidate.organizationUuid === target.organizationUuid
      ),
  );

  for (const source of others) {
    const prefs = readViewAccountPrefs(store, source);
    if (!hasAnyAccountPref(prefs)) continue;

    const changes: ViewChange[] = [];
    const account: Record<string, unknown> = {};
    if (prefs.environments !== undefined) {
      changes.push({ field: 'env', from: undefined, to: prefs.environments });
      account[environmentsKey(target)] =
        prefs.environments.length > 0 ? prefs.environments : undefined;
    }
    if (prefs.showEmptyProjects !== undefined) {
      changes.push({ field: 'empty-groups', from: undefined, to: prefs.showEmptyProjects });
      account[emptyProjectsKey(target)] = prefs.showEmptyProjects;
    }
    if (prefs.showPrStatus !== undefined) {
      changes.push({ field: 'pr-status', from: undefined, to: prefs.showPrStatus });
      account[prStatusKey(target)] = prefs.showPrStatus;
    }
    return { from: source, changes, account };
  }

  return { changes: [], account: {} };
}
