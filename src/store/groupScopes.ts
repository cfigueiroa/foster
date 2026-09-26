import { readFileSync } from 'node:fs';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { BackupOptions } from '../util/backups.js';
import { asObject, rewriteDesktopConfig } from './desktopConfig.js';

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

function isGroupRecord(value: unknown): value is GroupRecord {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/**
 * `groups`, filtered to the entries `isGroupRecord` accepts. A malformed entry
 * (missing `id` or `name`, or not an object at all) is dropped on its own —
 * counted, never let take its siblings with it. Absent or the wrong shape at
 * the top (not an array) reads as "nothing here" rather than a reason to
 * refuse the rest of the scope: `groups` and `assignments` are independent
 * halves of the same object, and one being unreadable says nothing about the
 * other.
 */
function repairGroups(value: unknown): { groups: GroupRecord[]; skipped: number } {
  if (!Array.isArray(value)) return { groups: [], skipped: 0 };
  const groups: GroupRecord[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (isGroupRecord(entry)) groups.push(entry);
    else skipped += 1;
  }
  return { groups, skipped };
}

/**
 * `assignments`, filtered entry by entry. A single card id pointing at a
 * non-string value (`null` measured in the wild, see AGENTS.md) used to fail
 * `isStringRecord` for the *whole object*, which `readGroupScopes` then threw
 * away wholesale — every other, perfectly good assignment in that scope along
 * with it. Only the bad entries are dropped now, and counted.
 */
function repairAssignments(value: unknown): {
  assignments: Record<string, string>;
  skipped: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { assignments: {}, skipped: 0 };
  }
  const assignments: Record<string, string> = {};
  let skipped = 0;
  for (const [cardId, groupId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof groupId === 'string') assignments[cardId] = groupId;
    else skipped += 1;
  }
  return { assignments, skipped };
}

/**
 * `order`, filtered list by list — one malformed list (not an array, or an
 * array holding something other than card id strings) is dropped on its own;
 * it no longer takes every other group's order down with it. `undefined` when
 * nothing here survived, since `order` stays optional.
 */
function repairOrder(value: unknown): {
  order: Record<string, string[]> | undefined;
  skipped: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { order: undefined, skipped: 0 };
  }
  const order: Record<string, string[]> = {};
  let skipped = 0;
  for (const [groupId, list] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(list) && list.every((id) => typeof id === 'string')) {
      order[groupId] = list;
    } else {
      skipped += 1;
    }
  }
  return { order: Object.keys(order).length > 0 ? order : undefined, skipped };
}

export interface GroupScopesReadReport {
  scopes: GroupScopes;
  /**
   * Scope key -> count of entries (a bad group, a bad assignment, a bad order
   * list) skipped while reading it. A key with nothing skipped is left out
   * entirely, so `Object.keys(report.skippedEntries)` names exactly the scopes
   * worth a second look — `planLayout`'s target included, via `scopeKey`.
   */
  skippedEntries: Record<string, number>;
  /**
   * Set when the config file itself could not be read or parsed at all —
   * EACCES, a file replaced by a directory, JSON that will not parse — as
   * opposed to it simply not existing yet (ENOENT: an install nothing has
   * ever grouped, and the ordinary case every fixture store in this suite
   * builds). Both cases hand back `{ scopes: {} }` either way, since a plan
   * has nothing to read from the file regardless — but only this one is a
   * problem worth a warning: "no groups" from a file with none in it and "no
   * groups" from a file `planLayout` could not even open are not the same
   * fact, and only the read side of this module can tell them apart.
   */
  configUnreadable?: string;
}

/**
 * Whether `value` has enough of a scope's basic shape to plan or merge from at
 * all: `groups` an array, `assignments` a plain object. Both are still
 * required at this coarse level — a scope where either is missing entirely,
 * or is some other type altogether, gives `planLayout` nothing to iterate
 * (`Object.entries(scope.assignments)` on `undefined` is the crash finding
 * #A6 measured, before this file caught it), and there is nothing to salvage
 * entry-by-entry when the entry-holder itself never existed. This is *not*
 * the same question `repairGroups` / `repairAssignments` answer: those decide
 * which individual entries *inside* an array or object that does exist are
 * trustworthy; this decides whether that array or object exists in the first
 * place.
 */
function hasScopeShape(
  value: object,
): value is { groups: unknown; assignments: unknown; order?: unknown } {
  const candidate = value as { groups?: unknown; assignments?: unknown };
  return (
    Array.isArray(candidate.groups) &&
    Boolean(candidate.assignments) &&
    typeof candidate.assignments === 'object' &&
    !Array.isArray(candidate.assignments)
  );
}

/**
 * Every scope the file currently holds, or empty when the app has never
 * written one — a store nothing has ever grouped, which is every fixture store
 * this test suite builds and plenty of real installations too.
 *
 * A scope value with no basic shape to plan from (see `hasScopeShape`) is left
 * out of the result entirely, the same as before — `planLayout` treats the
 * source it came from as having nothing to offer, the same as an account with
 * an empty scope. Short of that, nothing here drops a whole scope for one bad
 * *entry* any more — see `repairGroups` / `repairAssignments` / `repairOrder`,
 * which is the fix: a scope that does have a `groups` array and an
 * `assignments` object no longer loses both over a single malformed entry in
 * either. `readGroupScopes` is the plain, backward-compatible view of this; a
 * caller that wants to know whether a scope had anything unrecognised
 * (`applyLayout` and its callers, for the target scope) uses
 * `readGroupScopesReport` instead.
 */
export function readGroupScopesReport(store: StoreLayout): GroupScopesReadReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { scopes: {}, skippedEntries: {} };
    }
    return {
      scopes: {},
      skippedEntries: {},
      configUnreadable: (error as Error).message,
    };
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
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) {
    return { scopes: {}, skippedEntries: {} };
  }

  const out: GroupScopes = {};
  const skippedEntries: Record<string, number> = {};
  for (const [key, value] of Object.entries(scopes as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !hasScopeShape(value)) {
      continue;
    }
    const groupsRes = repairGroups(value.groups);
    const assignRes = repairAssignments(value.assignments);
    const orderRes = repairOrder(value.order);

    out[key] = {
      groups: groupsRes.groups,
      assignments: assignRes.assignments,
      ...(orderRes.order ? { order: orderRes.order } : {}),
    };
    const skipped = groupsRes.skipped + assignRes.skipped + orderRes.skipped;
    if (skipped > 0) skippedEntries[key] = skipped;
  }
  return { scopes: out, skippedEntries };
}

/** The scopes half of `readGroupScopesReport`, for a caller that does not need the counts. */
export function readGroupScopes(store: StoreLayout): GroupScopes {
  return readGroupScopesReport(store).scopes;
}

/**
 * Write one scope, and nothing else — mirrors `writeAppPref`'s "never touch a
 * neighbour" discipline, one level deeper: the whole file is parsed twice, the
 * one scope this call is asked for is merged (see `mergeScope`), and the
 * result is compared against the original key by key at every level (top,
 * `preferences`, `epitaxyPrefs`, `dframe-group-scopes`) before the write is
 * allowed to replace it. Anything else moved and the write is refused with
 * the file untouched.
 *
 * `scope` is never the whole story for its key: it is merged onto whatever
 * the file holds for that key *right now*, re-read inside this call rather
 * than trusted from an earlier `readGroupScopes`. `applyLayout` builds `scope`
 * from a read that can be stale by the time this runs, and — before this — a
 * single malformed entry anywhere in the target's own scope (a `null`
 * assignment is the case measured, see AGENTS.md) made `readGroupScopes` drop
 * that whole scope, which then made this function's plain `scopes[key] =
 * scope` wipe every group and assignment the account actually had. Merging
 * fixes both: a group, an assignment or an order list this call's `scope`
 * does not mention — well-formed or not — survives untouched, and an unknown
 * key on the scope object itself (something a newer app version keeps that
 * this codebase does not model yet) survives too.
 *
 * A backup is written first regardless, under `~/.foster/backups` — see
 * `util/backups.ts` — never next to the file it copies.
 *
 * Refused up front, before any of that, if the raw file holds a number
 * literal that `JSON.parse` / `JSON.stringify` would silently rewrite (an
 * integer past `Number.MAX_SAFE_INTEGER`, a trailing `.0`, exponent
 * notation…) — see `util/jsonNumbers.ts`. The "did a neighbour move" check
 * below compares two already-parsed trees, so a number that changed shape
 * during that same parse is invisible to it; this is the check that would
 * have caught it, so it runs first and writes nothing either way. Both are
 * `rewriteDesktopConfig`'s (`store/desktopConfig.ts`), the one rewrite path
 * this shares with `writeAppPref` and `writeEpitaxyPrefs`.
 */
export function writeGroupScope(
  store: StoreLayout,
  account: AccountRef,
  scope: GroupScope,
  options: BackupOptions = {},
): { backup: string } {
  const key = scopeKey(account);
  return rewriteDesktopConfig(
    store,
    'groupScope',
    [['preferences', 'epitaxyPrefs', DFRAME_GROUP_SCOPES, key]],
    (after) => {
      const preferences = asObject(after.preferences);
      const epitaxy = asObject(preferences.epitaxyPrefs);
      const scopes = asObject(epitaxy[DFRAME_GROUP_SCOPES]);
      scopes[key] = mergeScope(scopes[key], scope);
      epitaxy[DFRAME_GROUP_SCOPES] = scopes;
      preferences.epitaxyPrefs = epitaxy;
      after.preferences = preferences;
    },
    options,
  );
}

/** A raw `groups` array entry's `id`, or undefined for a shape that has none to merge by. */
function rawGroupId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * `groups`, merged by `id`: every raw entry this call's `groups` does not
 * mention — a well-formed group the caller left alone, or one so malformed it
 * has no `id` to be mentioned by at all — is kept exactly as it was, in its
 * original position. An entry the caller *does* mention (same `id`) is
 * replaced by the caller's version in place; a group with an `id` the raw
 * array did not have is appended.
 */
function mergeGroups(rawValue: unknown, incoming: readonly GroupRecord[]): unknown[] {
  const rawGroups = Array.isArray(rawValue) ? rawValue : [];
  const incomingById = new Map(incoming.map((group) => [group.id, group] as const));
  const consumed = new Set<string>();

  const merged = rawGroups.map((entry) => {
    const id = rawGroupId(entry);
    if (id !== undefined && incomingById.has(id)) {
      consumed.add(id);
      return incomingById.get(id);
    }
    return entry;
  });
  for (const group of incoming) {
    if (!consumed.has(group.id)) merged.push(group);
  }
  return merged;
}

/**
 * `assignments`, merged key by key: every raw card id this call's
 * `assignments` does not mention keeps its raw value, `null` and every other
 * malformed shape included. A card id the caller does mention is set to the
 * caller's value, whatever the raw value under it was.
 */
function mergeAssignments(
  rawValue: unknown,
  incoming: Record<string, string>,
): Record<string, unknown> {
  return { ...asObject(rawValue), ...incoming };
}

/**
 * `order`, merged group id by group id — the same rule as `mergeAssignments`,
 * one level down: a group id this call's `order` does not mention keeps its
 * raw list untouched, however malformed. `undefined` only when neither side
 * had anything, so a write that never touches `order` at all does not conjure
 * an empty one into the file.
 */
function mergeOrder(
  rawValue: unknown,
  incoming: Record<string, string[]> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...asObject(rawValue), ...(incoming ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The scope this call actually writes for `key`: `rawValue` — whatever the
 * file holds for that key right now, read fresh inside `writeGroupScope`,
 * untouched by this codebase's own leniency when it *reads* a scope — merged
 * with `incoming`, the caller's scope. Every key on `rawValue` this codebase
 * does not model (`groups` / `assignments` / `order`) is carried over as-is;
 * `groups`, `assignments` and `order` are each merged by their own rule above
 * rather than replaced wholesale, which is the fix: an entry `incoming` never
 * mentions — because it was malformed on the way in, or simply not this
 * call's concern — is never lost.
 */
function mergeScope(rawValue: unknown, incoming: GroupScope): Record<string, unknown> {
  const merged = { ...asObject(rawValue) };
  merged.groups = mergeGroups(merged.groups, incoming.groups);
  merged.assignments = mergeAssignments(merged.assignments, incoming.assignments);
  const order = mergeOrder(merged.order, incoming.order);
  if (order) {
    merged.order = order;
  } else {
    delete merged.order;
  }
  return merged;
}
