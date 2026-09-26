import { readFileSync } from 'node:fs';
import { currentAccount } from './account.js';
import { listAccountDirs, sameAccount } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds } from '../ledger/project.js';
import type { LedgerEvent } from '../ledger/types.js';
import { scanAccount } from '../store/scanner.js';
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
  unknownAccountSuffixedEpitaxyKeys,
  writeEpitaxyPrefs,
  type ViewAccountPrefs,
} from '../store/viewPrefs.js';
import { nonCanonicalNumbers } from '../util/jsonNumbers.js';
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
  /**
   * `epitaxyPrefs` keys suffixed with what looks like an account uuid, under
   * a name none of the five per-account keys use — see
   * `store/viewPrefs.ts`'s `unknownAccountSuffixedEpitaxyKeys`. Never a
   * refusal, only an inventory line.
   */
  unknownAccountKeys: string[];
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
    unknownAccountKeys: unknownAccountSuffixedEpitaxyKeys(store),
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
        'grouping by state only shows active sessions; drop --status or use --status active ' +
          `(the app's own rule — --group-by state was given together with --status ${status}).`,
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
 * Everything both halves need is checked before either is written — #8: this
 * used to check the Local Storage record only after already having written
 * the config half, so `view set --pr-status off --sort name --yes` against a
 * store with no `dframe-store` record landed the per-account write and only
 * then threw, with nothing in the message saying the first half had already
 * happened.
 *
 * The checks run up front, before any write, are exactly the ones that can be
 * without writing anything: that the Local Storage record exists at all (the
 * same read `readLocalStorageValue` always does, so a corrupt encoding or an
 * unparsable payload is caught here too, not mid-write), and that the config
 * file carries no number literal a JSON round trip would silently rewrite —
 * the same check `writeEpitaxyPrefs` itself refuses on, run here first so a
 * store that would fail it never gets a Local Storage write it cannot be
 * paired with.
 *
 * Config is still written first once both checks pass: its own write refuses
 * (throws, nothing touched) if anything but the named keys moved since the
 * read — a concurrent-modification check the up-front checks above cannot
 * substitute for, since it can only be run against the post-write shape, and
 * the Local Storage append has no equivalent of it at all. If the Local
 * Storage append then fails — the one failure the up-front checks cannot rule
 * out — the error names the per-account half as already written, backup path
 * included, rather than leaving the caller to guess which half landed.
 */
export function applyViewSet(plan: ViewSetPlan, options: ApplyViewOptions): { backups: string[] } {
  const { store } = options;
  assertClosed(store, options);
  const backups: string[] = [];

  const hasAccountChanges = Object.keys(plan.account).length > 0;
  const { groupBy, sort } = plan.machine;
  const hasMachineChanges = groupBy !== undefined || sort !== undefined;

  let machineRecord: LocalStorageRecord | undefined;
  if (hasMachineChanges) {
    machineRecord = readLocalStorageValue(store, DFRAME_STORE_KEY);
    if (!machineRecord) {
      throw new Error(
        'Local Storage has never recorded the sidebar filters — open the Code sidebar in ' +
          'Claude Desktop once, so there is a record for foster to change.',
      );
    }
  }
  if (hasAccountChanges) {
    const raw = readFileSync(store.desktopConfigFile, 'utf8');
    const lossy = nonCanonicalNumbers(raw)[0];
    if (lossy) {
      throw new Error(
        `refusing to write: ${store.desktopConfigFile} holds a number literal that a JSON round-trip would rewrite (\`${lossy.literal}\`, at offset ${lossy.index}). Nothing was written.`,
      );
    }
  }

  if (hasAccountChanges) {
    const { backup } = writeEpitaxyPrefs(store, plan.account, {
      now: options.now,
      env: options.env,
    });
    backups.push(backup);
  }

  if (hasMachineChanges) {
    try {
      // Backed up before the append, same as every other write-with-app-closed
      // store here — see util/backups.ts.
      backups.push(backupLocalStorage(store, options));

      const state = { ...((machineRecord!.document.state as Record<string, unknown>) ?? {}) };
      if (groupBy !== undefined) {
        state.groupByByMode = { ...((state.groupByByMode as object) ?? {}), code: groupBy };
      }
      if (sort !== undefined) {
        state.sortByByMode = { ...((state.sortByByMode as object) ?? {}), code: sort };
      }
      writeLocalStorageValue(machineRecord!, DFRAME_STORE_KEY, {
        ...machineRecord!.document,
        state,
      });
    } catch (error) {
      if (hasAccountChanges) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `the per-account half was already written (backup at ${backups[0]}); the machine-wide half failed: ${message}`,
        );
      }
      throw error;
    }
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
    // #9c: an explicitly empty `environments: []` means exactly what an unset
    // key means — `ViewAccountPrefs`'s own "`[]` or absent, both mean every
    // environment" — and the target here always starts with none of the five
    // set, so carrying an empty array changes nothing. This used to still
    // push a change and an `account[envKey] = undefined` entry, so a source
    // whose only account pref was an empty environments array looked like it
    // had something to carry: every later `foster layout` repeated the
    // no-op write, backup and ledger event against a target that never
    // actually gained a fourth key.
    if (prefs.environments !== undefined && prefs.environments.length > 0) {
      changes.push({ field: 'env', from: undefined, to: prefs.environments });
      account[environmentsKey(target)] = prefs.environments;
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
    // A source whose only account pref was the empty-environments no-op above
    // has nothing left to carry — move on to the next candidate rather than
    // reporting nothing-to-do as the run's final answer when another account
    // might have something real.
    if (changes.length === 0) continue;
    return { from: source, changes, account };
  }

  return { changes: [], account: {} };
}

// ---------------------------------------------------------------------------
// The machine-wide half (`groupBy`/`sort`) — a sighting-based carry.
//
// `dframe-store`'s `groupByByMode.code`/`sortByByMode.code` is one record for
// the whole installation, and the page re-syncs it with the *signed-in*
// account's server copy at every startup (see AGENTS.md, "Desktop: grupos
// sincronizam com o servidor" — inferred to cover this same record, since it
// is the same server-synced store the groups scope lives in; not directly
// measured for `groupBy`/`sort` specifically). That means this machine can
// never simply read what a *different* account last showed — by the time
// that account is not signed in, the record has already been overwritten.
// `view_seen` is the workaround: a sighting taken while an account happened
// to be signed in, kept in the ledger so a later run — signed into a
// different account — can still ask what it saw. `recordViewSeen` is the
// write half; `recordSignedInViewSighting` (below) is what `foster sweep` and
// `foster layout` actually call, once each, before planning — see AGENTS.md.
// ---------------------------------------------------------------------------

/** The latest `view_seen` sighting recorded for one account, if any. */
export function viewSeenFor(
  events: readonly LedgerEvent[],
  account: AccountRef,
): { groupBy?: string; sortBy: string } | undefined {
  let latest: { groupBy?: string; sortBy: string } | undefined;
  for (const event of events) {
    if (event.kind !== 'view_seen' || !sameAccount(event.account, account)) continue;
    latest = {
      ...(event.groupBy !== undefined ? { groupBy: event.groupBy } : {}),
      sortBy: event.sortBy,
    };
  }
  return latest;
}

/** The latest `view_carried` value foster itself wrote for one account/key, if any. */
export function viewCarriedFor(
  events: readonly LedgerEvent[],
  account: AccountRef,
  key: 'groupBy' | 'sortBy',
): unknown {
  let latest: unknown;
  let found = false;
  for (const event of events) {
    if (event.kind !== 'view_carried' || !sameAccount(event.account, account)) continue;
    if (event.key !== key) continue;
    latest = event.value;
    found = true;
  }
  return found ? latest : undefined;
}

/**
 * Take a sighting of the target's own current `groupBy`/`sort`, if it differs
 * from the latest sighting already on file for that account — never spamming
 * the ledger with an unchanged value. Read-only apart from the one append;
 * callers decide when it is worth calling (a sweep or a layout run, per the
 * spec), which nothing in this codebase does yet.
 */
export function recordViewSeen(ledger: Ledger, store: StoreLayout, account: AccountRef): void {
  const state = readViewState(store, account);
  const groupBy = state.groupBy;
  const sortBy = state.sort;
  const previous = viewSeenFor(ledger.read(), account);
  if (previous && previous.groupBy === groupBy && previous.sortBy === sortBy) return;
  ledger.append({
    kind: 'view_seen',
    account,
    ...(groupBy !== undefined ? { groupBy } : {}),
    sortBy,
  });
}

/**
 * `foster sweep`/`foster layout`'s own call to `recordViewSeen`, for
 * whichever account the store is actually signed into right now.
 *
 * `currentAccount` (`engine/account.ts`) is the org-qualified version of the
 * same fact `signedInAccount` reads (`readConfig(store).lastKnownAccountUuid`)
 * — `recordViewSeen` needs a full `AccountRef`, which a bare accountUuid
 * cannot supply on its own. Read-only apart from the one append
 * `recordViewSeen` itself may make, and silent when nothing is signed in:
 * a store nobody has opened Claude Desktop on yet has no `lastKnownAccountUuid`
 * to attribute a sighting to, and guessing one would be worse than skipping.
 *
 * Callers take this **before** planning, never inside the closed-app gap a
 * `--restart` run writes in (`applyLayout` itself never calls this) — by the
 * time that gap opens, the Local Storage record it would read reflects
 * whichever account was signed in *before* the restart, not the target the
 * write is about to sign into.
 *
 * `resolve`/`record` are injection seams for a test double, not something a
 * real caller ever overrides.
 */
export function recordSignedInViewSighting(
  store: StoreLayout,
  ledger: Ledger,
  options: {
    resolve?: (store: StoreLayout, accounts: AccountRef[]) => AccountRef | undefined;
    record?: (ledger: Ledger, store: StoreLayout, account: AccountRef) => void;
  } = {},
): void {
  const resolve = options.resolve ?? currentAccount;
  const record = options.record ?? recordViewSeen;
  const signedIn = resolve(store, listAccountDirs(store));
  if (!signedIn) return;
  record(ledger, store, signedIn);
}

export interface MachineViewCarry {
  from?: AccountRef;
  groupBy?: string;
  sortBy?: string;
}

/**
 * The desired `groupBy`/`sort`, carried from the most recently active *other*
 * account's own latest `view_seen` sighting — the same "most recent source
 * wins" rule the rest of `foster layout` already applies. "Local change
 * wins": a key is only ever written when the target's current value is one
 * foster itself wrote before (`view_carried`), or the target has never shown
 * anything different from what is desired — never a value the user (or the
 * app, syncing from the server) set since.
 */
export function planMachineViewCarry(
  store: StoreLayout,
  target: AccountRef,
  events: readonly LedgerEvent[],
): MachineViewCarry {
  const others = listAccountDirs(store).filter((account) => !sameAccount(account, target));

  // Only native cards say which account was used: a foster copy inherits its
  // origin's `lastActivityAt`, so the newest conversation's copies tie across
  // every account a sweep reached, and the first one listed would win.
  const copies = copySessionIds([...events]);
  let bestAccount: AccountRef | undefined;
  let bestAt = -Infinity;
  for (const account of others) {
    const cards = scanAccount(store, account, copies, { slim: true });
    for (const card of cards) {
      if (card.isCopy) continue;
      const at = card.data.lastActivityAt ?? 0;
      if (at > bestAt) {
        bestAt = at;
        bestAccount = account;
      }
    }
  }
  if (!bestAccount) return {};

  const sighting = viewSeenFor(events, bestAccount);
  if (!sighting) return {};

  const current = readViewState(store, target);
  const result: MachineViewCarry = { from: bestAccount };

  if (sighting.groupBy !== undefined && sighting.groupBy !== current.groupBy) {
    const owned =
      current.groupBy === undefined ||
      current.groupBy === viewCarriedFor(events, target, 'groupBy');
    if (owned) result.groupBy = sighting.groupBy;
  }
  if (sighting.sortBy !== current.sort) {
    const carriedSort = viewCarriedFor(events, target, 'sortBy');
    // `current.sort` defaults to `'recency'` the moment the key is absent —
    // the app's own rule, per `readViewState` — so "never set" has to be
    // read off the raw state rather than off that defaulted value, or a
    // record that exists for other reasons (groupBy, say) but has never
    // carried a `sortByByMode` key would look owned when it never was.
    const rawState = current.machineRecord?.document.state as Record<string, unknown> | undefined;
    const neverSetSort = !rawState || !Object.hasOwn(rawState, 'sortByByMode');
    const owned = neverSetSort || current.sort === carriedSort;
    if (owned) result.sortBy = sighting.sortBy;
  }

  return result;
}
