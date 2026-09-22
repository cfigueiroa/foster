import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { listAccountDirs } from '../domain/paths.js';
import {
  DEFAULT_DIVERGED_TEMPLATE,
  DEFAULT_OTHER_FILE_TEMPLATE,
  DEFAULT_STALE_TEMPLATE,
  looksMarked,
  stripMarks,
  templatesSeen,
} from '../domain/stale.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { LedgerEvent } from '../ledger/types.js';
import { scanAccount } from '../store/scanner.js';
import {
  groupCardId,
  readGroupScopes,
  scopeKey,
  sessionIdOfCard,
  writeGroupScope,
  type GroupScope,
  type GroupScopes,
} from '../store/groupScopes.js';
import {
  idsOnDisk,
  readScheduledTasks,
  writeScheduledTasks,
  type ScheduledTask,
  type ScheduledTasksFile,
  type ScheduledTasksRead,
} from '../store/routines.js';
import {
  backupLocalStorage,
  currentLog,
  localStoragePresent,
  readLocalStorageValue,
  writeLocalStorageEntries,
} from '../store/localStorage.js';
import { writeEpitaxyPrefs } from '../store/viewPrefs.js';
import { nonCanonicalNumbers } from '../util/jsonNumbers.js';
import { planLayoutViewCarry, type LayoutViewCarry } from './view.js';
import { AppRunningError, inspectApp } from './safety.js';
import { readProcesses, type ProcessLister } from './desktop.js';

/**
 * Bring the sidebar's groups and its routines (scheduled tasks) from every
 * other account into the one signed in now.
 *
 * Both live in files the app owns and rewrites from memory — the group scopes
 * in `claude_desktop_config.json`, the routines in each account's own
 * `scheduled-tasks.json` — so, like `store/pinstate.ts`, a write here is only
 * safe while the app is closed. Unlike a fostered session, neither of these has
 * an identity of its own to copy: a group is matched by *name*, and a routine
 * is matched by its own `id`, so bringing one twice is a no-op rather than a
 * duplicate.
 *
 * Planning and applying are kept apart the way every other pass in this
 * codebase keeps them: `planLayout` reads and decides, `applyLayout` writes
 * exactly what the plan says and nothing it does not.
 */

const DEFAULT_TEMPLATES = [
  DEFAULT_STALE_TEMPLATE,
  DEFAULT_DIVERGED_TEMPLATE,
  DEFAULT_OTHER_FILE_TEMPLATE,
];

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupAssignItem {
  cardId: string;
  title: string;
}

export interface GroupSkipped {
  title: string;
  reason: 'missing' | 'archived';
}

export interface GroupPlanItem {
  name: string;
  groupId: string;
  /** True when the target scope has no group of this name yet. */
  created: boolean;
  assign: GroupAssignItem[];
  skipped: GroupSkipped[];
  /** The group's resulting order — what is already there, plus what this run appends. */
  order: string[];
  /** The slice of `order` this run would append; empty on an idempotent second run. */
  appendedOrder: string[];
}

export interface GroupConflict {
  cliSessionId: string;
  title: string;
  /** The group name taken — the source card with the latest activity. */
  chosen: string;
  /** The group name(s) proposed by the source(s) that lost. */
  others: string[];
}

export interface GroupsPlan {
  items: GroupPlanItem[];
  conflicts: GroupConflict[];
  /** Distinct source accounts the group scopes named, whether or not they had anything to bring. */
  sources: number;
}

interface GroupCandidate {
  sourceKey: string;
  sourceCardId: string;
  groupName: string;
  cliSessionId: string;
  sourceCard: DiscoveredSession;
}

function isCleanTitle(title: string, templates: readonly string[]): boolean {
  return stripMarks(title, templates) === title && !looksMarked(title);
}

type TargetResolution =
  { status: 'ok'; card: DiscoveredSession } | { status: 'missing' } | { status: 'archived' };

/**
 * Which of the target's cards for one conversation a group assignment should
 * land on. Several can share a `cliSessionId` — a fork, or the same
 * conversation shown from two working directories — so the choice follows the
 * order the spec gives: not archived, then a title with no foster mark on it
 * (the tip, per `domain/stale.ts`), then the latest `lastActivityAt`.
 */
function resolveTarget(
  cliSessionId: string,
  targetCards: readonly DiscoveredSession[],
  templates: readonly string[],
): TargetResolution {
  const candidates = targetCards.filter((card) => card.data.cliSessionId === cliSessionId);
  if (candidates.length === 0) return { status: 'missing' };

  const notArchived = candidates.filter((card) => !card.data.isArchived);
  if (notArchived.length === 0) return { status: 'archived' };

  const clean = notArchived.filter((card) => isCleanTitle(card.data.title ?? '', templates));
  const pool = clean.length > 0 ? clean : notArchived;

  const card = pool.reduce((best, next) =>
    (next.data.lastActivityAt ?? 0) > (best.data.lastActivityAt ?? 0) ? next : best,
  );
  return { status: 'ok', card };
}

/**
 * Cards for an account, cached per scope key — several assignments in one
 * source scope, and every group's `order` list, ask about the same directory.
 */
function cardReader(store: StoreLayout): (key: string) => DiscoveredSession[] {
  const cache = new Map<string, DiscoveredSession[]>();
  return (key: string): DiscoveredSession[] => {
    const cached = cache.get(key);
    if (cached) return cached;
    const [accountUuid, organizationUuid] = key.split('/');
    const cards =
      accountUuid && organizationUuid ? scanAccount(store, { accountUuid, organizationUuid }) : [];
    cache.set(key, cards);
    return cards;
  };
}

function planGroups(
  store: StoreLayout,
  target: AccountRef,
  ledgerEvents: readonly LedgerEvent[],
): GroupsPlan {
  const scopes = readGroupScopes(store);
  const targetKey = scopeKey(target);
  const targetScope: GroupScope = scopes[targetKey] ?? { groups: [], assignments: {} };
  const sourceEntries = Object.entries(scopes).filter(([key]) => key !== targetKey);

  const templates = [...templatesSeen(ledgerEvents), ...DEFAULT_TEMPLATES];
  const targetCards = scanAccount(store, target);
  const cardsOf = cardReader(store);
  const cardById = (key: string, sessionId: string): DiscoveredSession | undefined =>
    cardsOf(key).find((card) => card.data.sessionId === sessionId);

  // Every source assignment, resolved to the conversation it names — a card id
  // on its own says nothing the target could match against, since foster mints
  // a fresh id for every copy and the app does the same for every fork.
  const byConversation = new Map<string, GroupCandidate[]>();
  for (const [sourceKey, scope] of sourceEntries) {
    const nameOf = new Map(scope.groups.map((group) => [group.id, group.name]));
    for (const [sourceCardId, groupId] of Object.entries(scope.assignments)) {
      const sessionId = sessionIdOfCard(sourceCardId);
      const sourceCard = sessionId ? cardById(sourceKey, sessionId) : undefined;
      const cliSessionId = sourceCard?.data.cliSessionId;
      const groupName = nameOf.get(groupId);
      if (!sourceCard || !cliSessionId || !groupName) continue;

      const list = byConversation.get(cliSessionId) ?? [];
      list.push({ sourceKey, sourceCardId, groupName, cliSessionId, sourceCard });
      byConversation.set(cliSessionId, list);
    }
  }

  // One winner per conversation: the group name proposed by whichever source
  // card has the latest activity. Agreement is the ordinary case; a conflict is
  // only worth a line in the report, never a reason to refuse.
  const conflicts: GroupConflict[] = [];
  const winners = new Map<string, GroupCandidate>();
  // Keyed by the exact (source scope, source card) a winner came from, so the
  // order pass below can tell which source's `order` list this run actually
  // acted on.
  const resolvedTargetCard = new Map<string, string>();

  for (const [cliSessionId, candidates] of byConversation) {
    let winner = candidates[0]!;
    for (const candidate of candidates) {
      if (
        (candidate.sourceCard.data.lastActivityAt ?? 0) >
        (winner.sourceCard.data.lastActivityAt ?? 0)
      ) {
        winner = candidate;
      }
    }
    const names = new Set(candidates.map((candidate) => candidate.groupName));
    if (names.size > 1) {
      conflicts.push({
        cliSessionId,
        title: winner.sourceCard.data.title ?? winner.sourceCard.data.sessionId,
        chosen: winner.groupName,
        others: [...names].filter((name) => name !== winner.groupName),
      });
    }
    winners.set(cliSessionId, winner);
  }

  const groupItems = new Map<string, GroupPlanItem>();
  const groupIdByName = new Map<string, string>(
    targetScope.groups.map((group) => [group.name, group.id]),
  );

  const ensureItem = (name: string): GroupPlanItem => {
    let id = groupIdByName.get(name);
    const created = id === undefined;
    if (id === undefined) {
      id = `cg-${randomUUID()}`;
      groupIdByName.set(name, id);
    }
    let item = groupItems.get(id);
    if (!item) {
      item = {
        name,
        groupId: id,
        created,
        assign: [],
        skipped: [],
        order: [...(targetScope.order?.[id] ?? [])],
        appendedOrder: [],
      };
      groupItems.set(id, item);
    }
    return item;
  };

  // A target card already filed anywhere is left alone — the user's own filing
  // wins, and idempotency depends on this staying a snapshot taken once, before
  // this run adds anything of its own.
  const alreadyAssigned = new Set(Object.keys(targetScope.assignments));

  for (const [cliSessionId, winner] of winners) {
    const item = ensureItem(winner.groupName);
    const resolution = resolveTarget(cliSessionId, targetCards, templates);
    const title = winner.sourceCard.data.title ?? winner.sourceCard.data.sessionId;

    if (resolution.status === 'missing') {
      item.skipped.push({ title, reason: 'missing' });
      continue;
    }
    if (resolution.status === 'archived') {
      item.skipped.push({ title, reason: 'archived' });
      continue;
    }

    const targetCardId = groupCardId(resolution.card.data.sessionId);
    resolvedTargetCard.set(`${winner.sourceKey}\u0000${winner.sourceCardId}`, targetCardId);
    if (alreadyAssigned.has(targetCardId)) continue;

    item.assign.push({
      cardId: targetCardId,
      title: resolution.card.data.title ?? resolution.card.data.sessionId,
    });
  }

  // Which group a target card actually ends up in, after this run's own
  // assignments — pre-existing assignments first, then this run's. A card the
  // order pass maps to a *different* group than the one it is actually filed
  // in must never be appended to that other group's order: the user's own
  // filing (or a conflict this run resolved the other way) already answered
  // "which group", and order is a view onto that answer, not a second vote
  // (#A5 — appending local_t to group Y's order when it stays filed in X).
  const finalGroupOf = new Map<string, string>(Object.entries(targetScope.assignments));
  for (const item of groupItems.values()) {
    for (const assign of item.assign) finalGroupOf.set(assign.cardId, item.groupId);
  }

  // The manual, partial order: only for a card that is actually assigned to
  // *this* group in the target once the write lands — a card this run skipped
  // as missing or archived has no target id to place in an order at all, and
  // a card resolved for a different group is never listed here either.
  for (const [sourceKey, scope] of sourceEntries) {
    if (!scope.order) continue;
    const nameOf = new Map(scope.groups.map((group) => [group.id, group.name]));
    for (const [sourceGroupId, cardIds] of Object.entries(scope.order)) {
      const groupName = nameOf.get(sourceGroupId);
      const targetGroupId = groupName ? groupIdByName.get(groupName) : undefined;
      const item = targetGroupId ? groupItems.get(targetGroupId) : undefined;
      if (!item) continue;

      for (const sourceCardId of cardIds) {
        const mapped = resolvedTargetCard.get(`${sourceKey}\u0000${sourceCardId}`);
        if (!mapped || item.order.includes(mapped)) continue;
        if (finalGroupOf.get(mapped) !== item.groupId) continue;
        item.order.push(mapped);
        item.appendedOrder.push(mapped);
      }
    }
  }

  const sourceAccounts = new Set(sourceEntries.map(([key]) => key.split('/')[0]));
  return { items: [...groupItems.values()], conflicts, sources: sourceAccounts.size };
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export interface RoutineBringItem {
  id: string;
  /** Absent when the source never had one (an older build); carried as absent. */
  displayName?: string;
  cronExpression?: string;
  fireAt?: number;
  filePath: string;
  cwd: string;
}

export interface RoutineSkipped {
  id: string;
  displayName: string;
  reason: 'already-here' | 'missing-skill' | 'missed-one-shot' | 'disabled';
  /** Set for `missed-one-shot`: the moment it was due. */
  firedAt?: number;
}

export interface RoutinesPlan {
  bring: RoutineBringItem[];
  skipped: RoutineSkipped[];
  /** Distinct source accounts that had a readable `scheduled-tasks.json`. */
  sources: number;
}

function planRoutines(store: StoreLayout, target: AccountRef, now: number): RoutinesPlan {
  const others = listAccountDirs(store).filter(
    (account) =>
      !(
        account.accountUuid === target.accountUuid &&
        account.organizationUuid === target.organizationUuid
      ),
  );

  // `idsOnDisk`, not `readScheduledTasks(...).file.scheduledTasks` — an entry
  // this module cannot validate (missing a field, a shape from a build ahead
  // of this one) still claims its id in the app, and `readScheduledTasks`
  // filters it out of `scheduledTasks` entirely (see `store/routines.ts`).
  // Asking the filtered list left an id "already here" invisible to this
  // check, and the newest source copy of that id got brought in as a
  // duplicate rather than left alone (#R1).
  const targetIds = new Set(idsOnDisk(store, target));

  // Dedup by id across *every* source first, enabled or not — the newest
  // `createdAt` wins the id regardless. Only once there is one candidate per
  // id is "enabled" asked, and only of that winner. Asking it earlier, per
  // source, let an older *enabled* copy win an id whose newest copy had since
  // been disabled on purpose: a real case measured this run, a routine
  // disabled in its newest account but still enabled in an older one, which
  // the old order brought back to life in the target.
  const byId = new Map<string, ScheduledTask>();
  // Distinct account uuids, not account/org directories — two orgs of the same
  // account both offering routines must still count as one source, the same
  // way `planGroups`' own `sourceAccounts` already did (`key.split('/')[0]`).
  // Keying this one on the full `accountUuid/organizationUuid` pair inflated
  // "Routines (from N other accounts)" whenever a single account held more
  // than one organization.
  const sourceAccounts = new Set<string>();
  for (const account of others) {
    const read = readScheduledTasks(store, account);
    if (read.status !== 'ok') continue;
    sourceAccounts.add(account.accountUuid);

    for (const task of read.file.scheduledTasks) {
      const existing = byId.get(task.id);
      if (!existing || (task.createdAt ?? 0) > (existing.createdAt ?? 0)) byId.set(task.id, task);
    }
  }

  const bring: RoutineBringItem[] = [];
  const skipped: RoutineSkipped[] = [];

  for (const task of byId.values()) {
    if (!task.enabled) {
      skipped.push({ id: task.id, displayName: task.displayName ?? task.id, reason: 'disabled' });
      continue;
    }
    // The user may have disabled this on purpose in the target already —
    // enabled or not, an id the target already has is left exactly as it is.
    if (targetIds.has(task.id)) {
      skipped.push({
        id: task.id,
        displayName: task.displayName ?? task.id,
        reason: 'already-here',
      });
      continue;
    }
    if (!existsSync(task.filePath)) {
      skipped.push({
        id: task.id,
        displayName: task.displayName ?? task.id,
        reason: 'missing-skill',
      });
      continue;
    }
    // A one-shot the app never fired is overdue, and the app runs an overdue
    // task at its next launch — bringing it unasked would fire something the
    // user never scheduled in this account. A recurring task has no such
    // moment: `cronExpression` keeps firing regardless of when it is brought.
    if (task.fireAt !== undefined && task.cronExpression === undefined && task.fireAt <= now) {
      skipped.push({
        id: task.id,
        displayName: task.displayName ?? task.id,
        reason: 'missed-one-shot',
        firedAt: task.fireAt,
      });
      continue;
    }

    bring.push({
      id: task.id,
      ...(task.displayName !== undefined ? { displayName: task.displayName } : {}),
      ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
      ...(task.fireAt !== undefined ? { fireAt: task.fireAt } : {}),
      filePath: task.filePath,
      cwd: task.cwd,
    });
  }

  return { bring, skipped, sources: sourceAccounts.size };
}

// ---------------------------------------------------------------------------
// Plan / apply
// ---------------------------------------------------------------------------

export interface LayoutPlan {
  target: AccountRef;
  groups: GroupsPlan;
  routines: RoutinesPlan;
  /**
   * The sidebar filter menu's per-account half, carried from another account
   * only when this one has none of it set — see `engine/view.ts`'s
   * `planLayoutViewCarry`. The machine-wide half needs no copying.
   */
  viewPrefs: LayoutViewCarry;
}

export interface PlanLayoutOptions {
  store: StoreLayout;
  target: AccountRef;
  now?: number;
  /**
   * The ledger's events, so a title already wearing a mark this installation's
   * own sweeps have used is recognised as such — see `domain/stale.ts`'s
   * `templatesSeen`. Every default template is always checked regardless.
   */
  ledgerEvents?: readonly LedgerEvent[];
}

export function planLayout(options: PlanLayoutOptions): LayoutPlan {
  const { store, target } = options;
  return {
    target,
    groups: planGroups(store, target, options.ledgerEvents ?? []),
    routines: planRoutines(store, target, options.now ?? Date.now()),
    viewPrefs: planLayoutViewCarry(store, target),
  };
}

export interface LayoutPendingCounts {
  /** Groups that do not exist in the target yet and would be minted. */
  groupsCreated: number;
  /** Cards that would be newly assigned to a group. */
  cardsAssigned: number;
  /** Manual order entries that would be appended to a group's order list. */
  orderEntriesAdded: number;
  routinesBrought: number;
  /** Sidebar filter-menu (view) keys that would be carried from another account. */
  viewKeysCarried: number;
}

/**
 * What `applyLayout` would write for this plan, without writing anything.
 *
 * Uses the same "dirty group" predicate `applyLayout` itself writes under — a
 * new assignment or a new manual order entry (see finding #9: a group with
 * neither gets no id and no row, so it counts as nothing pending either) — so
 * this and a real `applyLayout` run always agree on what is left to bring.
 * `foster sweep`'s preview line and the CLI's own restart-command choice both
 * read this rather than re-deriving their own notion of "pending", which is
 * what used to let a plan with only new order entries, or only a view-prefs
 * carry, go unmentioned.
 */
export function pendingLayoutCounts(plan: LayoutPlan): LayoutPendingCounts {
  const dirtyGroups = plan.groups.items.filter(
    (item) => item.assign.length > 0 || item.appendedOrder.length > 0,
  );
  return {
    groupsCreated: dirtyGroups.filter((item) => item.created).length,
    cardsAssigned: dirtyGroups.reduce((sum, item) => sum + item.assign.length, 0),
    orderEntriesAdded: dirtyGroups.reduce((sum, item) => sum + item.appendedOrder.length, 0),
    routinesBrought: plan.routines.bring.length,
    viewKeysCarried: Object.keys(plan.viewPrefs.account).length,
  };
}

/** The sum of every `LayoutPendingCounts` field — 0 means nothing is pending. */
export function totalLayoutPending(counts: LayoutPendingCounts): number {
  return (
    counts.groupsCreated +
    counts.cardsAssigned +
    counts.orderEntriesAdded +
    counts.routinesBrought +
    counts.viewKeysCarried
  );
}

export interface LayoutPlanSummary {
  groupsCreated: number;
  cardsAssigned: number;
  orderEntriesAdded: number;
  groupConflicts: number;
  groupsSkipped: number;
  routinesBrought: number;
  routinesSkipped: number;
  viewKeysCarried: number;
}

/**
 * A small, comparable fingerprint of a plan — for a caller (`foster layout
 * --restart`) that re-plans inside the gap between quitting Claude Desktop and
 * starting it again, to tell whether the plan it is about to apply still
 * matches the one it showed the user before asking to restart (#R2). Two
 * `planLayout` calls against the same, unchanged store produce equal
 * summaries; one where the app (or another `foster` run) wrote something in
 * between does not, and the caller can decide whether that difference is
 * worth telling the user about rather than silently applying a plan they
 * never saw. Deliberately not the full `LayoutPlan` — two plans can differ in
 * ways nobody cares about (group id text, ordering of an array) while
 * agreeing on everything this counts.
 */
export function layoutPlanSummary(plan: LayoutPlan): LayoutPlanSummary {
  const pending = pendingLayoutCounts(plan);
  return {
    groupsCreated: pending.groupsCreated,
    cardsAssigned: pending.cardsAssigned,
    orderEntriesAdded: pending.orderEntriesAdded,
    groupConflicts: plan.groups.conflicts.length,
    groupsSkipped: plan.groups.items.reduce((sum, item) => sum + item.skipped.length, 0),
    routinesBrought: pending.routinesBrought,
    routinesSkipped: plan.routines.skipped.length,
    viewKeysCarried: pending.viewKeysCarried,
  };
}

export interface ApplyLayoutOptions {
  store: StoreLayout;
  ledger: Ledger;
  env?: NodeJS.ProcessEnv;
  list?: ProcessLister;
  now?: () => Date;
}

export interface ApplyLayoutResult {
  /** Groups created or given a new assignment or order entry. */
  groupsTouched: number;
  /** Of `groupsTouched`, how many did not exist in the target before this run. */
  groupsCreated: number;
  cardsAssigned: number;
  /** Manual order entries appended to a group's order list this run. */
  orderEntriesAdded: number;
  routinesBrought: number;
  /** True when the per-account view prefs were carried from another account. */
  viewPrefsCarried: boolean;
  /** Sidebar filter-menu (view) keys carried this run — 0 when `viewPrefsCarried` is false. */
  viewKeysCarried: number;
  /** Every backup this run wrote, before either file was touched. */
  backups: string[];
  /**
   * A label per file this run actually wrote, in the order it wrote them —
   * `applyLayout` writes several distinct targets (the config scope, up to
   * two Local Storage keys, the routines file, a second config write for the
   * view carry) and cannot make all of them land as one atomic unit. If a
   * later one fails, this is what already landed, named exactly, rather than
   * left for the caller to guess from a bare exception.
   */
  written: string[];
}

export class LayoutWriteError extends Error {
  constructor(written: readonly string[], failedAt: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      written.length > 0
        ? `Wrote: ${written.join(', ')}. Then failed writing ${failedAt}: ${reason}`
        : `Failed writing ${failedAt}, before anything else was written: ${reason}`,
    );
    this.name = 'LayoutWriteError';
  }
}

/**
 * The three places a target's groups have to agree — see CLAUDE.md, "Groups
 * live in three places". `undefined` when there is no Local Storage database
 * to write into yet (a store the sidebar's filter menu has never touched),
 * which is a gap to skip rather than a reason to fail the whole run — the
 * config copy is still written, and is what the app reads to rebuild the
 * other two the next time it does.
 *
 * `allScopes` is every scope the config file now holds, the target's own
 * already merged in — what a caller reads fresh via `readGroupScopes` (or
 * folds `nextScope` into in memory, without a second disk read) right before
 * this is called. Which source a key's document is seeded from depends on
 * whether that key has ever been written at all (#R5):
 *
 * - a key that already has a record ("when records exist") is merged the
 *   narrow way `writeGroupScope` merges the config file — only the target's
 *   own scope entry is replaced, and every other account's scope already
 *   sitting in that record survives untouched;
 * - a key with no record yet ("when missing") is seeded from every scope
 *   `allScopes` holds, not the target's alone — a store where the sidebar's
 *   filter menu has genuinely never been opened has nothing of its own to
 *   preserve, and seeding only the target's scope would make this account
 *   the only one the app could rebuild from Local Storage if the config copy
 *   were ever lost, silently dropping every other account's groups from a
 *   record that is supposed to hold all of them.
 *
 * A fresh `LSS-persisted.dframe-group-scopes` document takes the measured
 * shape `{value, tabId, timestamp}`, `tabId` empty and `timestamp` now — the
 * same shape a record that already exists keeps, just with `value` and
 * `timestamp` updated. A fresh `dframe-store` document takes the measured
 * `{state: {customGroupsByScope}, version: 1}` — `version` is only ever set
 * here, on a document that had nothing to inherit it from; one that already
 * exists keeps whatever `version` (and every other top-level key) it had.
 */
function localStorageGroupWrites(
  store: StoreLayout,
  target: AccountRef,
  allScopes: GroupScopes,
  nowMs: number,
): { scriptKey: string; document: Record<string, unknown> }[] | undefined {
  if (!localStoragePresent(store)) return undefined;
  const key = scopeKey(target);
  const targetScope = allScopes[key];

  const lss = readLocalStorageValue(store, 'LSS-persisted.dframe-group-scopes');
  const lssValue = lss
    ? { ...(lss.document.value as Record<string, unknown> | undefined), [key]: targetScope }
    : { ...allScopes };
  const nextLss = {
    ...lss?.document,
    value: lssValue,
    tabId: (lss?.document.tabId as string | undefined) ?? '',
    timestamp: nowMs,
  };

  const dframe = readLocalStorageValue(store, 'dframe-store');
  const state = (dframe?.document.state as Record<string, unknown> | undefined) ?? {};
  const customGroups = dframe
    ? { ...(state.customGroupsByScope as Record<string, unknown> | undefined), [key]: targetScope }
    : { ...allScopes };
  const nextDframe = dframe
    ? { ...dframe.document, state: { ...state, customGroupsByScope: customGroups } }
    : { state: { customGroupsByScope: customGroups }, version: 1 };

  return [
    { scriptKey: 'LSS-persisted.dframe-group-scopes', document: nextLss },
    { scriptKey: 'dframe-store', document: nextDframe },
  ];
}

/**
 * Write exactly what the plan says, and nothing else — refusing outright while
 * Claude Desktop is running, the same rule `store/pinstate.ts` and
 * `writeAppPref` both keep: the app owns every file this touches and rewrites
 * them from memory, so a write here would simply be overwritten the next time
 * one of them flushes.
 *
 * The CLI checks the same thing first, for a message that names `--restart`;
 * this is the backstop for any other caller, sweep's own read-only planning
 * pass included — it never calls this function at all.
 *
 * Two passes, deliberately kept apart (#R3, "all-or-nothing as far as
 * checkable"):
 *
 * - **Phase 1** reconciles the plan against disk state read fresh right here
 *   — never the snapshot `planLayout` took, which can be stale by the time
 *   this runs (a `--restart` gap is exactly that: the app can flush a group,
 *   an assignment or a routine of its own into the seconds this call spans —
 *   #R1, #R2) — and runs every check that can fail *without* writing
 *   anything: the target's `scheduled-tasks.json` is readable, the config
 *   file carries no number literal a JSON round trip would rewrite, and the
 *   groups' Local Storage records (when there is a database to write into at
 *   all) are locatable and decodable. Any of those failing throws before a
 *   single byte anywhere has changed.
 * - **Phase 2** writes exactly what Phase 1 decided, in the same order every
 *   earlier build wrote it in. A failure here is a genuine race or
 *   concurrent-modification refusal Phase 1 could not have predicted (writing
 *   is the only way `writeGroupScope` / `writeEpitaxyPrefs` can tell whether
 *   a neighbour moved) — it still throws `LayoutWriteError`, still names
 *   exactly what had already landed in `written`, and a `layout_applied`
 *   ledger event is appended for that landed part *before* the throw, so a
 *   run that got half done is never lost from both the caller's return value
 *   and the ledger at once (#R3, #R4).
 */
export function applyLayout(plan: LayoutPlan, options: ApplyLayoutOptions): ApplyLayoutResult {
  const { store, ledger } = options;
  const app = inspectApp(store, options.env, options.list ?? readProcesses);
  if (app.running) {
    throw new AppRunningError(
      'Claude Desktop rewrites its own config while it runs; close it or add --restart.',
    );
  }

  const nowMs = (options.now?.() ?? new Date()).getTime();
  const key = scopeKey(plan.target);
  const backups: string[] = [];
  const written: string[] = [];

  // Only ever set once the write it describes has actually landed — never
  // computed ahead of the write and trusted to still be true after it, which
  // is what let a failed Local Storage write get reported as if the groups it
  // never touched had (#R4).
  const landed = {
    groupsTouched: 0,
    groupsCreated: 0,
    cardsAssigned: 0,
    orderEntriesAdded: 0,
    routinesBrought: 0,
    viewKeysCarried: 0,
  };
  let viewPrefsCarried = false;

  const appendLedgerIfLanded = (): void => {
    if (landed.groupsTouched > 0 || landed.routinesBrought > 0 || landed.viewKeysCarried > 0) {
      ledger.append({
        kind: 'layout_applied',
        target: plan.target,
        groups: landed.cardsAssigned,
        groupsCreated: landed.groupsCreated,
        orderEntriesAdded: landed.orderEntriesAdded,
        routines: landed.routinesBrought,
        viewKeysCarried: landed.viewKeysCarried,
      });
    }
  };

  // ---------------------------------------------------------------------
  // Phase 1 — reconcile against fresh disk state; check everything that can
  // fail before writing anything.
  // ---------------------------------------------------------------------

  // Never create a group for nothing — see #9. A group whose only proposal
  // this run has is a card that turned out missing or archived elsewhere gets
  // an entry in `skipped`, and that is the whole record of it; nothing here
  // mints an id or a name for a group with zero rows to show.
  const plannedGroups = plan.groups.items.filter(
    (item) => item.assign.length > 0 || item.appendedOrder.length > 0,
  );

  interface ReconciledGroups {
    nextScope: GroupScope;
    allScopes: GroupScopes;
    groupsCreated: number;
    cardsAssigned: number;
    orderEntriesAdded: number;
    groupsTouched: number;
    localStorageWrites: { scriptKey: string; document: Record<string, unknown> }[] | undefined;
  }

  let groups: ReconciledGroups | undefined;
  if (plannedGroups.length > 0) {
    const scopes = readGroupScopes(store);
    const current: GroupScope = scopes[key] ?? { groups: [], assignments: {} };
    const nextGroups = [...current.groups];
    const nextAssignments = { ...current.assignments };
    const nextOrder: Record<string, string[]> = { ...(current.order ?? {}) };

    // Rechecked fresh, right here (#R2): a group of this name, or an
    // assignment for one of these cards, that the app (or another `foster`
    // run) wrote to disk since the plan was taken is never shadowed by a
    // second group of the same name, and never overwritten — the user's own
    // filing (or the app's) still wins, the same rule `planGroups` already
    // applies to the snapshot it read at plan time.
    const nameToId = new Map(current.groups.map((g) => [g.name, g.id]));
    const assignedOnDisk = new Set(Object.keys(current.assignments));

    let groupsCreated = 0;
    let cardsAssigned = 0;
    let orderEntriesAdded = 0;
    let groupsTouched = 0;

    for (const item of plannedGroups) {
      const droppedCardIds = new Set<string>();
      const assign = item.assign.filter((entry) => {
        if (assignedOnDisk.has(entry.cardId)) {
          droppedCardIds.add(entry.cardId);
          return false;
        }
        return true;
      });
      // A card whose assignment was just dropped is never left dangling in
      // this group's order list either — the same "order follows where the
      // card is actually filed" rule #A5 already applies at plan time.
      const appendedOrder = item.appendedOrder.filter((cardId) => !droppedCardIds.has(cardId));
      if (assign.length === 0 && appendedOrder.length === 0) continue; // #9, rechecked

      const existingId = nameToId.get(item.name);
      const groupId = existingId ?? item.groupId;

      if (existingId === undefined && !nextGroups.some((g) => g.id === groupId)) {
        nextGroups.push({ id: groupId, name: item.name });
        groupsCreated += 1;
      }
      for (const entry of assign) {
        nextAssignments[entry.cardId] = groupId;
        assignedOnDisk.add(entry.cardId);
      }
      if (appendedOrder.length > 0) {
        nextOrder[groupId] = [...(nextOrder[groupId] ?? []), ...appendedOrder];
        orderEntriesAdded += appendedOrder.length;
      }
      groupsTouched += 1;
      cardsAssigned += assign.length;
    }

    if (groupsTouched > 0) {
      const nextScope: GroupScope = {
        groups: nextGroups,
        assignments: nextAssignments,
        ...(Object.keys(nextOrder).length > 0 ? { order: nextOrder } : {}),
      };
      const allScopes: GroupScopes = { ...scopes, [key]: nextScope };

      // Checkable without writing: can the two Local Storage records this
      // would also touch even be located and decoded? A store whose sidebar
      // filter menu was never opened has no database at all — a gap
      // `localStorageGroupWrites` itself skips gracefully — but one with a
      // database and a corrupt or unrecognised record in it is a real
      // problem, and (#R3) it is caught here, before the config write, not
      // discovered only after the config copy had already landed (#R4).
      let localStorageWrites: ReconciledGroups['localStorageWrites'];
      if (localStoragePresent(store)) {
        try {
          localStorageWrites = localStorageGroupWrites(store, plan.target, allScopes, nowMs);
        } catch (error) {
          throw new LayoutWriteError(written, 'groups (Local Storage)', error);
        }
      }

      groups = {
        nextScope,
        allScopes,
        groupsCreated,
        cardsAssigned,
        orderEntriesAdded,
        groupsTouched,
        localStorageWrites,
      };
    }
  }

  const viewKeysCarried = Object.keys(plan.viewPrefs.account).length;

  // Checkable without writing, and shared by both writers of
  // `claude_desktop_config.json` this run might use (groups, the view-prefs
  // carry) — one read, checked once, before either write, so a store that
  // would fail it never ends up with one of the two landed and the other
  // refused.
  if (groups || viewKeysCarried > 0) {
    const raw = readFileSync(store.desktopConfigFile, 'utf8');
    const lossy = nonCanonicalNumbers(raw)[0];
    if (lossy) {
      throw new LayoutWriteError(
        written,
        'groups (config)',
        new Error(
          `refusing to write: ${store.desktopConfigFile} holds a number literal that a JSON round-trip would rewrite (\`${lossy.literal}\`, at offset ${lossy.index}). Nothing was written.`,
        ),
      );
    }
  }

  // Checkable without writing: is the target's own routines file even
  // readable? Refused up front (#A3, #5) rather than overwritten wholesale on
  // the strength of the plan alone, which would destroy whatever
  // `recordedSkips` and existing tasks an unparsable file held — and refused
  // here, before groups or view prefs write anything, not after (#R3): the
  // old behaviour let a target with a broken routines file still receive a
  // real groups write it was never told about failing alongside.
  let routinesTargetRead: ScheduledTasksRead | undefined;
  let toBringRoutines: RoutineBringItem[] = [];
  if (plan.routines.bring.length > 0) {
    routinesTargetRead = readScheduledTasks(store, plan.target);
    if (routinesTargetRead.status === 'unreadable') {
      throw new LayoutWriteError(
        written,
        'routines',
        new Error(
          `the target's scheduled-tasks.json could not be parsed (${routinesTargetRead.reason}); refusing to replace it`,
        ),
      );
    }
    // Rechecked fresh against `idsOnDisk`, the same reason planning itself
    // does (#R1): an id the disk now claims — recognised or not, `idsOnDisk`
    // sees both — is left alone, even one this plan was built before the
    // target had it at all (another `foster` run, or the app itself, in the
    // gap since `planLayout` ran).
    const idsNow = new Set(idsOnDisk(store, plan.target));
    toBringRoutines = plan.routines.bring.filter((item) => !idsNow.has(item.id));
  }

  // ---------------------------------------------------------------------
  // Phase 2 — write exactly what Phase 1 decided, and nothing else.
  // ---------------------------------------------------------------------

  if (groups) {
    try {
      const result = writeGroupScope(store, plan.target, groups.nextScope, {
        now: options.now,
        env: options.env,
      });
      backups.push(result.backup);
      written.push('groups (config)');
    } catch (error) {
      throw new LayoutWriteError(written, 'groups (config)', error);
    }
    landed.groupsTouched = groups.groupsTouched;
    landed.groupsCreated = groups.groupsCreated;
    landed.cardsAssigned = groups.cardsAssigned;
    landed.orderEntriesAdded = groups.orderEntriesAdded;

    if (groups.localStorageWrites) {
      try {
        backups.push(backupLocalStorage(store, { now: options.now, env: options.env }));
        const record = readLocalStorageValue(store, 'dframe-store') ?? currentLog(store);
        writeLocalStorageEntries(record, groups.localStorageWrites);
        written.push('groups (Local Storage)');
      } catch (error) {
        // #R4: this used to be swallowed into a "... FAILED" entry in
        // `written`, with no throw — the config copy really had landed, so
        // the run really had done *something*, but reporting the whole call
        // as an ordinary success hid that one of the sidebar's three places
        // never agreed with the other two. The config write already landed,
        // so that much is logged before this throws.
        appendLedgerIfLanded();
        throw new LayoutWriteError(written, 'groups (Local Storage)', error);
      }
    }
  }

  if (toBringRoutines.length > 0) {
    const file: ScheduledTasksFile =
      routinesTargetRead?.status === 'ok'
        ? routinesTargetRead.file
        : { scheduledTasks: [], recordedSkips: {} };
    const added: ScheduledTask[] = toBringRoutines.map((item) => ({
      id: item.id,
      ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
      ...(item.cronExpression !== undefined ? { cronExpression: item.cronExpression } : {}),
      ...(item.fireAt !== undefined ? { fireAt: item.fireAt } : {}),
      enabled: true,
      filePath: item.filePath,
      createdAt: nowMs,
      cwd: item.cwd,
      // lastRunAt, lastScheduledFor and notifySessionId are deliberately not
      // carried: the first is another account's history, the second could make
      // the app count runs this account never missed, and the third names a
      // session that does not exist here.
    }));

    try {
      const result = writeScheduledTasks(
        store,
        plan.target,
        { ...file, scheduledTasks: [...file.scheduledTasks, ...added] },
        { now: options.now, env: options.env },
      );
      if (result.backup) backups.push(result.backup);
      written.push('routines');
    } catch (error) {
      appendLedgerIfLanded();
      throw new LayoutWriteError(written, 'routines', error);
    }
    landed.routinesBrought = added.length;
  }

  if (viewKeysCarried > 0) {
    try {
      const result = writeEpitaxyPrefs(store, plan.viewPrefs.account, {
        now: options.now,
        env: options.env,
      });
      backups.push(result.backup);
      written.push('view prefs');
    } catch (error) {
      appendLedgerIfLanded();
      throw new LayoutWriteError(written, 'view prefs', error);
    }
    landed.viewKeysCarried = viewKeysCarried;
    viewPrefsCarried = true;
  }

  appendLedgerIfLanded();

  return {
    groupsTouched: landed.groupsTouched,
    groupsCreated: landed.groupsCreated,
    cardsAssigned: landed.cardsAssigned,
    orderEntriesAdded: landed.orderEntriesAdded,
    routinesBrought: landed.routinesBrought,
    viewPrefsCarried,
    viewKeysCarried: landed.viewKeysCarried,
    backups,
    written,
  };
}
