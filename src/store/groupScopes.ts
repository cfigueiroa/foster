import { copyFileSync, readFileSync } from 'node:fs';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { writeFileAtomic } from '../util/fsatomic.js';

/**
 * The sidebar's groups, and which card sits in which.
 *
 * Measured 22/09/2026, real MSIX store: the app keeps them in
 * `claude_desktop_config.json` — the same file `store/appPrefs.ts` reads —
 * nested three levels under `preferences.epitaxyPrefs["dframe-group-scopes"]`,
 * keyed by `"<accountUuid>/<organizationUuid>"`. One scope per account/org, and
 * the app owns the whole file: creating a group through the app wrote the new
 * scope within seconds. So a write here is only safe while the app is closed —
 * the same rule `store/pinstate.ts` and `writeAppPref` both keep — and it must
 * touch nothing else the file carries, the same discipline `writeAppPref` uses
 * for one preference at a time, one level deeper.
 */

const DFRAME_GROUP_SCOPES = 'dframe-group-scopes';

export interface GroupRecord {
  id: string;
  name: string;
}

export interface GroupScope {
  groups: GroupRecord[];
  /** Card id (`code:local_<uuid>`) -> group id. */
  assignments: Record<string, string>;
  /** Group id -> partial, manual order of the card ids within it. */
  order?: Record<string, string[]>;
}

/** Keyed by `"<accountUuid>/<organizationUuid>"` — one scope per account/org. */
export type GroupScopes = Record<string, GroupScope>;

export function scopeKey(account: AccountRef): string {
  return `${account.accountUuid}/${account.organizationUuid}`;
}

/** A card's id, as the scope's `assignments` and `order` name it. */
export function groupCardId(sessionId: string): string {
  return `code:${sessionId}`;
}

/** The session id underneath a card id, or undefined for a shape this scheme never wrote. */
export function sessionIdOfCard(cardId: string): string | undefined {
  return cardId.startsWith('code:') ? cardId.slice('code:'.length) : undefined;
}

function isScope(value: unknown): value is GroupScope {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { groups?: unknown }).groups)
  );
}

/**
 * Every scope the file currently holds, or empty when the app has never
 * written one — a store nothing has ever grouped, which is every fixture store
 * this test suite builds and plenty of real installations too.
 */
export function readGroupScopes(store: StoreLayout): GroupScopes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8'));
  } catch {
    return {};
  }
  const preferences = (parsed as { preferences?: unknown })?.preferences;
  const epitaxy =
    preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? (preferences as Record<string, unknown>).epitaxyPrefs
      : undefined;
  const scopes =
    epitaxy && typeof epitaxy === 'object' && !Array.isArray(epitaxy)
      ? (epitaxy as Record<string, unknown>)[DFRAME_GROUP_SCOPES]
      : undefined;
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return {};

  const out: GroupScopes = {};
  for (const [key, value] of Object.entries(scopes as Record<string, unknown>)) {
    if (isScope(value)) out[key] = value;
  }
  return out;
}

/**
 * Write one scope, and nothing else — mirrors `writeAppPref`'s "never touch a
 * neighbour" discipline, one level deeper: the whole file is parsed twice, the
 * one scope this call is asked for is replaced, and the result is compared
 * against the original key by key at every level (top, `preferences`,
 * `epitaxyPrefs`, `dframe-group-scopes`) before the write is allowed to
 * replace it. Anything else moved and the write is refused with the file
 * untouched.
 *
 * A backup is written first regardless, named with the moment — the same
 * convention `writeAppPref` uses, so a foster backup is recognisable by shape
 * wherever it turns up next to a file the app owns.
 */
export function writeGroupScope(
  store: StoreLayout,
  account: AccountRef,
  scope: GroupScope,
  options: { now?: () => Date } = {},
): { backup: string } {
  const key = scopeKey(account);
  const raw = readFileSync(store.desktopConfigFile, 'utf8');
  const before = JSON.parse(raw) as Record<string, unknown>;
  const after = JSON.parse(raw) as Record<string, unknown>;

  const preferences = asObject(after.preferences);
  const epitaxy = asObject(preferences.epitaxyPrefs);
  const scopes = asObject(epitaxy[DFRAME_GROUP_SCOPES]);
  scopes[key] = scope;
  epitaxy[DFRAME_GROUP_SCOPES] = scopes;
  preferences.epitaxyPrefs = epitaxy;
  after.preferences = preferences;

  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backup = `${store.desktopConfigFile}.bak-${stamp}`;
  copyFileSync(store.desktopConfigFile, backup);

  const text = JSON.stringify(after, null, 2);
  const back = JSON.parse(text) as Record<string, unknown>;
  const moved = neighboursThatMoved(before, back, key);
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

/** Every key, at all four levels, that is not the scope being written and changed anyway. */
function neighboursThatMoved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  scopeName: string,
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
    if (key === DFRAME_GROUP_SCOPES) continue;
    if (JSON.stringify(wasEpitaxy[key]) !== JSON.stringify(nowEpitaxy[key])) {
      moved.push(`preferences.epitaxyPrefs.${key}`);
    }
  }

  const wasScopes = asObject(wasEpitaxy[DFRAME_GROUP_SCOPES]);
  const nowScopes = asObject(nowEpitaxy[DFRAME_GROUP_SCOPES]);
  for (const key of new Set([...Object.keys(wasScopes), ...Object.keys(nowScopes)])) {
    if (key === scopeName) continue;
    if (JSON.stringify(wasScopes[key]) !== JSON.stringify(nowScopes[key])) {
      moved.push(`preferences.epitaxyPrefs.${DFRAME_GROUP_SCOPES}.${key}`);
    }
  }

  return moved;
}
