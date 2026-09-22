import { copyFileSync, readFileSync } from 'node:fs';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { writeFileAtomic } from '../util/fsatomic.js';

/**
 * The Code sidebar's filter menu — the per-account half of it.
 *
 * Measured 22/09/2026, real MSIX store: four of the menu's seven settings live
 * in `claude_desktop_config.json`, the same file `store/groupScopes.ts` and
 * `store/appPrefs.ts` read, as top-level keys of `preferences.epitaxyPrefs` —
 * siblings of `dframe-group-scopes`, not nested under it. Three of the four
 * carry the account uuid as a suffix; the fourth, `code-sessions-state-activity-days`,
 * does not, because "last activity" applies to the account signed in, whichever
 * one that is, rather than to one particular account's own row.
 *
 * Three more keys, without the `-v2` suffix or the account uuid the app now
 * writes, are left over from an older build. The UI no longer reads them —
 * measured: `code-sessions-status-filter` said `all` while the sidebar showed
 * "Ativo" — so they are read-only here, surfaced as `legacy` rather than
 * mistaken for the setting currently in force, and never written.
 */

export function environmentsKey(account: AccountRef): string {
  return `code-sessions-selected-environments-v2.${account.accountUuid}`;
}

export function emptyProjectsKey(account: AccountRef): string {
  return `code-sessions-show-empty-projects.${account.accountUuid}`;
}

export function prStatusKey(account: AccountRef): string {
  return `code-sessions-show-pr-status.${account.accountUuid}`;
}

/** Not suffixed by account — measured, and kept as a constant rather than a function for it. */
export const ACTIVITY_DAYS_KEY = 'code-sessions-state-activity-days';

/** Left by an older build; the UI no longer reads any of these. Never written. */
export const LEGACY_VIEW_KEYS = [
  'code-sessions-status-filter',
  'code-sessions-selected-environments',
  'code-sessions-show-empty-projects',
] as const;

export interface ViewAccountPrefs {
  /** `[]` or absent, read back as absent, both mean "every environment". */
  environments?: string[];
  showEmptyProjects?: boolean;
  showPrStatus?: boolean;
}

/** The four keys this account/installation carries, exactly as `writeEpitaxyPrefs` would set them. */
export function accountPrefKeys(account: AccountRef): {
  environments: string;
  showEmptyProjects: string;
  showPrStatus: string;
  activityDays: string;
} {
  return {
    environments: environmentsKey(account),
    showEmptyProjects: emptyProjectsKey(account),
    showPrStatus: prStatusKey(account),
    activityDays: ACTIVITY_DAYS_KEY,
  };
}

function preferencesOf(parsed: unknown): Record<string, unknown> {
  const preferences = (parsed as { preferences?: unknown })?.preferences;
  return preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : {};
}

function epitaxyOf(preferences: Record<string, unknown>): Record<string, unknown> {
  const epitaxy = preferences.epitaxyPrefs;
  return epitaxy && typeof epitaxy === 'object' && !Array.isArray(epitaxy)
    ? (epitaxy as Record<string, unknown>)
    : {};
}

/** Every `epitaxyPrefs` key currently stored, or `{}` when the file cannot be read at all. */
export function readEpitaxyPrefs(store: StoreLayout): Record<string, unknown> {
  try {
    return epitaxyOf(preferencesOf(JSON.parse(readFileSync(store.desktopConfigFile, 'utf8'))));
  } catch {
    return {};
  }
}

export function readViewAccountPrefs(store: StoreLayout, account: AccountRef): ViewAccountPrefs {
  const epitaxy = readEpitaxyPrefs(store);
  const environments = epitaxy[environmentsKey(account)];
  const showEmptyProjects = epitaxy[emptyProjectsKey(account)];
  const showPrStatus = epitaxy[prStatusKey(account)];
  return {
    ...(Array.isArray(environments)
      ? { environments: environments.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof showEmptyProjects === 'boolean' ? { showEmptyProjects } : {}),
    ...(typeof showPrStatus === 'boolean' ? { showPrStatus } : {}),
  };
}

export function readActivityDays(store: StoreLayout): number | undefined {
  const value = readEpitaxyPrefs(store)[ACTIVITY_DAYS_KEY];
  return typeof value === 'number' ? value : undefined;
}

/** The legacy keys that are actually present, for `--json` to report as such. */
export function legacyViewKeysPresent(store: StoreLayout): string[] {
  const epitaxy = readEpitaxyPrefs(store);
  return LEGACY_VIEW_KEYS.filter((key) => Object.hasOwn(epitaxy, key));
}

/**
 * Write any number of `epitaxyPrefs` keys in one atomic change — `view set` can
 * touch several at once (environment, empty groups, PR status, activity days
 * all in one call), and `view copy` carries several from one account to
 * another. `undefined` in `changes` removes the key, matching how the app
 * itself represents "absent = default" for `showPrStatus` and the empty
 * environments array.
 *
 * Same discipline as `writeGroupScope`, one level shallower: read twice,
 * change only the named keys, verify nothing else at any level moved, back up
 * first regardless.
 */
export function writeEpitaxyPrefs(
  store: StoreLayout,
  changes: Record<string, unknown>,
  options: { now?: () => Date } = {},
): { backup: string } {
  const raw = readFileSync(store.desktopConfigFile, 'utf8');
  const before = JSON.parse(raw) as Record<string, unknown>;
  const after = JSON.parse(raw) as Record<string, unknown>;

  const preferences = asObject(after.preferences);
  const epitaxy = asObject(preferences.epitaxyPrefs);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete epitaxy[key];
    else epitaxy[key] = value;
  }
  preferences.epitaxyPrefs = epitaxy;
  after.preferences = preferences;

  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backup = `${store.desktopConfigFile}.bak-${stamp}`;
  copyFileSync(store.desktopConfigFile, backup);

  const text = JSON.stringify(after, null, 2);
  const back = JSON.parse(text) as Record<string, unknown>;
  const moved = neighboursThatMoved(before, back, new Set(Object.keys(changes)));
  if (moved.length > 0) {
    throw new Error(
      `refusing to write: ${moved.join(', ')} would have changed too. Nothing was written; the backup is at ${backup}`,
    );
  }

  writeFileAtomic(store.desktopConfigFile, text);
  return { backup };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function neighboursThatMoved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changedKeys: ReadonlySet<string>,
): string[] {
  const moved: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'preferences') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) moved.push(key);
  }

  const wasPrefs = asObject(before.preferences);
  const nowPrefs = asObject(after.preferences);
  for (const key of new Set([...Object.keys(wasPrefs), ...Object.keys(nowPrefs)])) {
    if (key === 'epitaxyPrefs') continue;
    if (JSON.stringify(wasPrefs[key]) !== JSON.stringify(nowPrefs[key])) {
      moved.push(`preferences.${key}`);
    }
  }

  const wasEpitaxy = asObject(wasPrefs.epitaxyPrefs);
  const nowEpitaxy = asObject(nowPrefs.epitaxyPrefs);
  for (const key of new Set([...Object.keys(wasEpitaxy), ...Object.keys(nowEpitaxy)])) {
    if (changedKeys.has(key)) continue;
    if (JSON.stringify(wasEpitaxy[key]) !== JSON.stringify(nowEpitaxy[key])) {
      moved.push(`preferences.epitaxyPrefs.${key}`);
    }
  }

  return moved;
}
