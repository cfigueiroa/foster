import { readFileSync } from 'node:fs';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { BackupOptions } from '../util/backups.js';
import { asObject, rewriteDesktopConfig } from './desktopConfig.js';

/**
 * The Code sidebar's filter menu — the per-account half of it.
 *
 * Measured 22/09/2026, real MSIX store, via the app's own `set_view` tool (then
 * restored): **five** of the menu's seven settings live in
 * `claude_desktop_config.json`, the same file `store/groupScopes.ts` and
 * `store/appPrefs.ts` read, as top-level keys of `preferences.epitaxyPrefs` —
 * siblings of `dframe-group-scopes`, not nested under it. Every one of the
 * five carries the account uuid as a suffix, status and the activity window
 * included — an earlier reading of this file treated both as machine-wide or
 * unsuffixed; measured again with the app's own tool, both
 * `code-sessions-status-filter.<accountUuid>` and
 * `code-sessions-state-activity-days.<accountUuid>` are per account, and
 * `dframe-store.state.recentsStatusFilter` (Local Storage) is a different field
 * entirely — never read or written for status.
 *
 * Two more keys, without the `-v2` suffix or the account uuid the app now
 * writes, are left over from an older build, alongside the unsuffixed
 * `code-sessions-status-filter` and `code-sessions-state-activity-days` this
 * reading demoted from "the real key" to "legacy" — measured side by side on
 * a real account: `code-sessions-status-filter` (unsuffixed) said `all` while
 * `code-sessions-status-filter.<accountUuid>` said `active`, which is what the
 * sidebar showed. The UI does not read any of the unsuffixed four; they are
 * read-only here, surfaced as `legacy`, and never written.
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

export function statusKey(account: AccountRef): string {
  return `code-sessions-status-filter.${account.accountUuid}`;
}

export function activityDaysKey(account: AccountRef): string {
  return `code-sessions-state-activity-days.${account.accountUuid}`;
}

/** Left by an older build, or superseded by the per-account key above; the UI reads none of these. */
export const LEGACY_VIEW_KEYS = [
  'code-sessions-status-filter',
  'code-sessions-selected-environments',
  'code-sessions-show-empty-projects',
  'code-sessions-state-activity-days',
] as const;

export interface ViewAccountPrefs {
  /** `[]` or absent, read back as absent, both mean "every environment". */
  environments?: string[];
  showEmptyProjects?: boolean;
  showPrStatus?: boolean;
  status?: string;
  activityDays?: number;
}

/** The five keys this account carries, exactly as `writeEpitaxyPrefs` would set them. */
export function accountPrefKeys(account: AccountRef): {
  environments: string;
  showEmptyProjects: string;
  showPrStatus: string;
  status: string;
  activityDays: string;
} {
  return {
    environments: environmentsKey(account),
    showEmptyProjects: emptyProjectsKey(account),
    showPrStatus: prStatusKey(account),
    status: statusKey(account),
    activityDays: activityDaysKey(account),
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
  const status = epitaxy[statusKey(account)];
  const activityDays = epitaxy[activityDaysKey(account)];
  return {
    ...(Array.isArray(environments)
      ? { environments: environments.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof showEmptyProjects === 'boolean' ? { showEmptyProjects } : {}),
    ...(typeof showPrStatus === 'boolean' ? { showPrStatus } : {}),
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof activityDays === 'number' ? { activityDays } : {}),
  };
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
 * first regardless. Both are `rewriteDesktopConfig`'s (`store/desktopConfig.ts`),
 * the one rewrite path this shares with `writeAppPref` and `writeGroupScope`.
 *
 * Refused up front, before any of that, if the raw file holds a number
 * literal that `JSON.parse` / `JSON.stringify` would silently rewrite — see
 * `util/jsonNumbers.ts` and the matching note on `writeGroupScope`.
 */
export function writeEpitaxyPrefs(
  store: StoreLayout,
  changes: Record<string, unknown>,
  options: BackupOptions = {},
): { backup: string } {
  return rewriteDesktopConfig(
    store,
    'epitaxyPrefs',
    Object.keys(changes).map((key) => ['preferences', 'epitaxyPrefs', key]),
    (after) => {
      const preferences = asObject(after.preferences);
      const epitaxy = asObject(preferences.epitaxyPrefs);
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete epitaxy[key];
        else epitaxy[key] = value;
      }
      preferences.epitaxyPrefs = epitaxy;
      after.preferences = preferences;
    },
    options,
  );
}
