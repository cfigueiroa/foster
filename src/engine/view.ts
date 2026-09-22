import { listAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import {
  backupLocalStorage,
  readLocalStorageValue,
  writeLocalStorageValue,
  type LocalStorageRecord,
} from '../store/localStorage.js';
import {
  activityDaysKey,
  emptyProjectsKey,
  environmentsKey,
  legacyViewKeysPresent,
  prStatusKey,
  readViewAccountPrefs,
  statusKey,
  writeEpitaxyPrefs,
  type ViewAccountPrefs,
} from '../store/viewPrefs.js';
import { AppRunningError, inspectApp } from './safety.js';
import { readProcesses, type ProcessLister } from './desktop.js';

/**
 * The Code sidebar's filter menu — reading and changing both halves at once.
 *
 * Two settings are machine-wide (`store/localStorage.ts`); five are per
 * account (`store/viewPrefs.ts`) — status and the activity window included,
 * per the 22/09/2026 re-measurement via the app's own `set_view` tool: an
 * earlier reading had both machine-wide or unsuffixed, which was wrong on
 * both counts, and `dframe-store.state.recentsStatusFilter` is a different
 * field that this module never reads or writes for status. Both stores are
 * files the app owns and rewrites from memory, so — like `layout.ts` — every
 * write here refuses outright while Claude Desktop is running.
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
  /** `groupByByMode.code`; undefined when the app has never written it. */
  groupBy?: string;
  /** `sortByByMode.code`; the app treats absence as `recency`. */
  sort: string;
  /** The five per-account settings, status and activity window included. */
  account: ViewAccountPrefs;
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
    ...(typeof groupByMode?.code === 'string' ? { groupBy: groupByMode.code } : {}),
    // Measured: absence means `recency` — the app never writes the key for its
    // own default, so a store nothing has ever sorted still has an answer.
    sort: typeof sortByMode?.code === 'string' ? sortByMode.code : 'recency',
    account: readViewAccountPrefs(store, account),
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
  /** Only ever `groupBy`/`sort` now — status moved to the per-account `account` map. */
  machine: { groupBy?: string; sort?: string };
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
  if (request.groupBy === 'state') {
    // The app's own rule: grouping by state only makes sense with the active
    // filter. An explicit --status that disagrees is a real conflict, not
    // something to override quietly — refused rather than silently writing
    // something other than what was asked for.
    if (status !== undefined && status !== 'active') {
      throw new Error(
        `--group-by state requires status active (the app's own rule), but --status ${status} was also given. ` +
          'Drop one of the two flags.',
      );
    }
    status = 'active';
    impliedStatusActive = true;
  }
  if (status !== undefined && status !== current.account.status) {
    changes.push({ field: 'status', from: current.account.status, to: status });
    account[statusKey(target)] = status;
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

  if (request.activityDays !== undefined && request.activityDays !== current.account.activityDays) {
    changes.push({
      field: 'activity-days',
      from: current.account.activityDays,
      to: request.activityDays,
    });
    account[activityDaysKey(target)] = request.activityDays;
  }

  return { target, changes, machine, account, impliedStatusActive };
}

export interface ApplyViewOptions {
  store: StoreLayout;
  env?: NodeJS.ProcessEnv;
  list?: ProcessLister;
  now?: () => Date;
}

function assertClosed(store: StoreLayout, options: ApplyViewOptions): void {
  const app = inspectApp(store, options.env, options.list ?? readProcesses);
  if (app.running) {
    throw new AppRunningError(
      'Claude Desktop rewrites its own config while it runs; close it or add --restart.',
    );
  }
}

/**
 * Both stores are validated and backed up before either is written.
 *
 * Config is written first. Its own write refuses (throws, nothing touched) if
 * anything but the named keys moved since the read — a check the Local
 * Storage append has no equivalent of — so writing config first means the
 * write most likely to refuse is the one tried while neither store has been
 * touched yet. If the Local Storage append fails afterward, only the
 * machine-wide half is left unset; nothing here depends on the other half's
 * value, so a retry of just that half is safe.
 */
export function applyViewSet(plan: ViewSetPlan, options: ApplyViewOptions): { backups: string[] } {
  const { store } = options;
  assertClosed(store, options);
  const backups: string[] = [];

  if (Object.keys(plan.account).length > 0) {
    const { backup } = writeEpitaxyPrefs(store, plan.account, {
      now: options.now,
      env: options.env,
    });
    backups.push(backup);
  }

  const { groupBy, sort } = plan.machine;
  if (groupBy !== undefined || sort !== undefined) {
    const record = readLocalStorageValue(store, DFRAME_STORE_KEY);
    if (!record) {
      throw new Error(
        'Local Storage has never recorded the sidebar filters — open the Code sidebar in ' +
          'Claude Desktop once, so there is a record for foster to change.',
      );
    }
    // Backed up before the append, same as every other write-with-app-closed
    // store here — see util/backups.ts.
    backups.push(backupLocalStorage(store, options));

    const state = { ...((record.document.state as Record<string, unknown>) ?? {}) };
    if (groupBy !== undefined) {
      state.groupByByMode = { ...((state.groupByByMode as object) ?? {}), code: groupBy };
    }
    if (sort !== undefined) {
      state.sortByByMode = { ...((state.sortByByMode as object) ?? {}), code: sort };
    }
    writeLocalStorageValue(record, DFRAME_STORE_KEY, { ...record.document, state });
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
 * One field's diff, source vs target, both read against the same fallback the
 * app itself would use when the key is absent (`false` for empty groups,
 * `true` for PR status shown, `[]`/undefined for "every environment", and no
 * assumed fallback for status or the activity window).
 *
 * The point of computing it this way, rather than only when both sides are
 * set, is #A2: a source that has never set a key and a target that has is a
 * real difference — the copy should put the target back to the default the
 * source implies — and the old code reported that difference in `changes`
 * without writing anything to match, so `foster view copy` printed a change
 * `applyViewCopy` then silently declined to make. Writing `undefined` here
 * deletes the target's key, which is exactly "restore the default", and the
 * plan and the write now describe the same thing.
 */
function diff<T>(
  field: ViewChange['field'],
  key: string,
  source: T | undefined,
  target: T | undefined,
  fallback: T | undefined,
  changes: ViewChange[],
  account: Record<string, unknown>,
  equal: (a: T | undefined, b: T | undefined) => boolean = (a, b) => a === b,
): void {
  const effectiveSource = source ?? fallback;
  const effectiveTarget = target ?? fallback;
  if (equal(effectiveSource, effectiveTarget)) return;
  changes.push({ field, from: effectiveTarget, to: effectiveSource });
  account[key] = source;
}

const sameArray = (a: string[] | undefined, b: string[] | undefined): boolean =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/**
 * The per-account half only — `store/localStorage.ts`'s half is machine-wide
 * and there is nothing to copy about it.
 */
export function planViewCopy(store: StoreLayout, from: AccountRef, to: AccountRef): ViewCopyPlan {
  const source = readViewAccountPrefs(store, from);
  const target = readViewAccountPrefs(store, to);
  const changes: ViewChange[] = [];
  const account: Record<string, unknown> = {};

  diff(
    'env',
    environmentsKey(to),
    source.environments,
    target.environments,
    [],
    changes,
    account,
    sameArray,
  );
  diff(
    'empty-groups',
    emptyProjectsKey(to),
    source.showEmptyProjects,
    target.showEmptyProjects,
    false,
    changes,
    account,
  );
  diff(
    'pr-status',
    prStatusKey(to),
    source.showPrStatus,
    target.showPrStatus,
    true,
    changes,
    account,
  );
  diff('status', statusKey(to), source.status, target.status, undefined, changes, account);
  diff(
    'activity-days',
    activityDaysKey(to),
    source.activityDays,
    target.activityDays,
    undefined,
    changes,
    account,
  );

  // `diff` writes `undefined` for "delete this key", and `account[key] =
  // undefined` is indistinguishable from the key never having been set at
  // all once spread — `writeEpitaxyPrefs` needs the key present (even as
  // `undefined`) to know to delete it, so it is kept explicit here rather
  // than filtered out.
  return { from, to, changes, account };
}

export function applyViewCopy(
  plan: ViewCopyPlan,
  options: ApplyViewOptions,
): { backups: string[] } {
  if (Object.keys(plan.account).length === 0) return { backups: [] };
  assertClosed(options.store, options);
  const { backup } = writeEpitaxyPrefs(options.store, plan.account, {
    now: options.now,
    env: options.env,
  });
  return { backups: [backup] };
}

// ---------------------------------------------------------------------------
// Layout's own carry-over of the per-account half — see spec part 2, "layout
// also carries the per-account half (B) from the source account when the
// target has none of those keys set" — now five keys, status and the
// activity window included (22/09/2026 re-measurement).
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
    prefs.showPrStatus !== undefined ||
    prefs.status !== undefined ||
    prefs.activityDays !== undefined
  );
}

/**
 * The same "user's own choice wins" rule `engine/layout.ts` applies to groups,
 * applied to the sidebar filter menu: nothing is borrowed unless the target has
 * none of these five set at all, and then the whole set comes from one
 * account — the first other account that has any of them, in the order
 * `listAccountDirs` gives. Target starts with nothing, so there is never a
 * default to restore here — only fields the source actually has are copied.
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
    if (prefs.status !== undefined) {
      changes.push({ field: 'status', from: undefined, to: prefs.status });
      account[statusKey(target)] = prefs.status;
    }
    if (prefs.activityDays !== undefined) {
      changes.push({ field: 'activity-days', from: undefined, to: prefs.activityDays });
      account[activityDaysKey(target)] = prefs.activityDays;
    }
    return { from: source, changes, account };
  }

  return { changes: [], account: {} };
}
