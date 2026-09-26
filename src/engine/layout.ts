import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { listAccountDirs, sameAccount } from '../domain/paths.js';
import { templatesSeen } from '../domain/stale.js';
import { DEFAULT_MARK_TEMPLATES, resolveContinuingCard } from './continuingCard.js';
import { planPinParity, type PinParityPlan } from './pinParity.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { LedgerEvent } from '../ledger/types.js';
import { scanAccount, type ScanCache } from '../store/scanner.js';
import {
  groupCardId,
  readGroupScopes,
  readGroupScopesReport,
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
  DFRAME_SYNC_PENDING_KEY,
  localStoragePresent,
  readLocalStorageText,
  readLocalStorageValue,
  writeLocalStorageEntries,
  writeLocalStorageValue,
  type LocalStorageWrite,
} from '../store/localStorage.js';
import { writeEpitaxyPrefs } from '../store/viewPrefs.js';
import {
  planAccountPrefsCarry,
  writeAccountPrefsCarry,
  type AccountPrefCarryPlan,
} from '../store/appPrefs.js';
import { nonCanonicalNumbers } from '../util/jsonNumbers.js';
import {
  planLayoutViewCarry,
  planMachineViewCarry,
  type LayoutViewCarry,
  type MachineViewCarry,
} from './view.js';
import { applyPinMoves, planPinMoves, type PinMovesPlan } from './pinMoves.js';
import { applyArchiveSync, type ArchiveSyncItem } from './archiveSync.js';
import { planMarksBack, planArchiveMarksBack } from './marksBack.js';
import { retitleCards, type RetitleRequest } from './retitle.js';
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

const DEFAULT_TEMPLATES = DEFAULT_MARK_TEMPLATES;

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupAssignItem {
  cardId: string;
  title: string;
  /** Set when this assignment moves the card out of a group it already sat in. */
  movedFrom?: string;
}

export interface GroupSkipped {
  title: string;
  reason: 'missing' | 'archived' | 'filed-by-hand';
  /** For `filed-by-hand`: the group name the card is currently filed in. */
  currentGroup?: string;
}

/**
 * Every card this installation's ledger says `applyLayout` itself filed into a
 * group for this account, keyed by card id and folded to the latest
 * assignment — the "local change wins" rule for moving a card between groups:
 * a card already sitting in a group is only ever moved when that current
 * filing is one foster wrote, never one the user made by hand (in the app,
 * or by a manual edit `foster` never touched).
 */
export function layoutAssignedByCard(
  events: readonly LedgerEvent[],
  target: AccountRef,
): Map<string, string> {
  const owned = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'layout_assigned' || !sameAccount(event.account, target)) continue;
    for (const { cardId, groupName } of event.assignments) owned.set(cardId, groupName);
  }
  return owned;
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
  /**
   * Set when `claude_desktop_config.json` itself could not be read or parsed
   * — see `GroupScopesReadReport.configUnreadable`. This plan then has
   * nothing to offer, the same as a store nobody has ever grouped — but
   * unlike that ordinary case, it is a problem the reader needs to know
   * about rather than read as "nothing pending".
   */
  configUnreadable?: string;
}

interface GroupCandidate {
  sourceKey: string;
  sourceCardId: string;
  groupName: string;
  cliSessionId: string;
  sourceCard: DiscoveredSession;
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
  const card = resolveContinuingCard(candidates, templates);
  return card ? { status: 'ok', card } : { status: 'archived' };
}

/**
 * Cards for an account, cached per scope key — several assignments in one
 * source scope, and every group's `order` list, ask about the same directory.
 *
 * Only `sessionId`, `cliSessionId`, `title`, `isArchived` and `lastActivityAt`
 * are ever read off what this returns (`resolveTarget`, the loop below), none
 * of them a bulky field, so every read here is `slim` — cheap on its own, and
 * free of a disk read at all when `scanCache` already holds the file from the
 * sweep's own scan moments earlier.
 */
function cardReader(
  store: StoreLayout,
  scanCache?: ScanCache,
): (key: string) => DiscoveredSession[] {
  const cache = new Map<string, DiscoveredSession[]>();
  return (key: string): DiscoveredSession[] => {
    const cached = cache.get(key);
    if (cached) return cached;
    const [accountUuid, organizationUuid] = key.split('/');
    const cards =
      accountUuid && organizationUuid
        ? scanAccount(store, { accountUuid, organizationUuid }, undefined, {
            slim: true,
            cache: scanCache,
          })
        : [];
    cache.set(key, cards);
    return cards;
  };
}

function planGroups(
  store: StoreLayout,
  target: AccountRef,
  ledgerEvents: readonly LedgerEvent[],
  scanCache?: ScanCache,
): GroupsPlan {
  const scopesReport = readGroupScopesReport(store);
  const scopes = scopesReport.scopes;
  const targetKey = scopeKey(target);
  const targetScope: GroupScope = scopes[targetKey] ?? { groups: [], assignments: {} };
  const sourceEntries = Object.entries(scopes).filter(([key]) => key !== targetKey);

  const templates = [...templatesSeen(ledgerEvents), ...DEFAULT_TEMPLATES];
  const targetCards = scanAccount(store, target, undefined, { slim: true, cache: scanCache });
  const cardsOf = cardReader(store, scanCache);
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
  // The most recently active source, overall — whose own group list decides
  // the order brand-new groups are appended in (see the ordering pass below).
  const latestActivityBySource = new Map<string, number>();

  for (const [cliSessionId, candidates] of byConversation) {
    let winner = candidates[0]!;
    for (const candidate of candidates) {
      const at = candidate.sourceCard.data.lastActivityAt ?? 0;
      if (at > (winner.sourceCard.data.lastActivityAt ?? 0)) winner = candidate;
      if (at > (latestActivityBySource.get(candidate.sourceKey) ?? -Infinity)) {
        latestActivityBySource.set(candidate.sourceKey, at);
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

  let mostRecentSourceKey: string | undefined;
  let mostRecentAt = -Infinity;
  for (const [key, at] of latestActivityBySource) {
    if (at > mostRecentAt) {
      mostRecentAt = at;
      mostRecentSourceKey = key;
    }
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

  // A target card already filed in the *same* group is a no-op — the snapshot
  // taken once, before this run adds anything of its own. One filed in a
  // *different* group is moved only when that filing is foster's own doing
  // (`layoutAssignedByCard`, folded from the ledger); otherwise it is the
  // user's own filing and is left exactly where it is.
  const groupNameById = new Map(targetScope.groups.map((group) => [group.id, group.name]));
  const fosterFiled = layoutAssignedByCard(ledgerEvents, target);

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

    const currentGroupId = targetScope.assignments[targetCardId];
    if (currentGroupId === item.groupId) continue; // already correctly filed here

    if (currentGroupId !== undefined) {
      const currentGroupName = groupNameById.get(currentGroupId);
      const ownedAs = fosterFiled.get(targetCardId);
      if (ownedAs === undefined || ownedAs !== currentGroupName) {
        item.skipped.push({
          title,
          reason: 'filed-by-hand',
          ...(currentGroupName !== undefined ? { currentGroup: currentGroupName } : {}),
        });
        continue;
      }
      item.assign.push({
        cardId: targetCardId,
        title: resolution.card.data.title ?? resolution.card.data.sessionId,
        movedFrom: currentGroupName,
      });
      continue;
    }

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

  // Brand-new groups are appended in the order the most recently active
  // source scope lists them, not discovery order — a name the most-recent
  // source does not have at all falls to the end, in whatever order it was
  // first encountered. Groups the target already had keep their existing
  // relative order, ahead of anything new.
  const mostRecentScope = mostRecentSourceKey ? scopes[mostRecentSourceKey] : undefined;
  const orderIndex = new Map<string, number>(
    (mostRecentScope?.groups ?? []).map((group, index) => [group.name, index]),
  );
  const items = [...groupItems.values()];
  const existingItems = items.filter((item) => !item.created);
  const newItems = items
    .filter((item) => item.created)
    .sort((a, b) => (orderIndex.get(a.name) ?? Infinity) - (orderIndex.get(b.name) ?? Infinity));

  return {
    items: [...existingItems, ...newItems],
    conflicts,
    sources: sourceAccounts.size,
    ...(scopesReport.configUnreadable ? { configUnreadable: scopesReport.configUnreadable } : {}),
  };
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
  /**
   * The sidebar filter menu's machine-wide half (`groupBy`/`sort`), carried
   * from a `view_seen` sighting of the most recently active other account —
   * see `engine/view.ts`'s `planMachineViewCarry`. Absent only on a plan
   * built by hand without the field.
   */
  machineViewPrefs?: MachineViewCarry;
  /**
   * The three account-uuid-keyed app prefs, carried from the most recently
   * active other account into the target's own entry — see
   * `store/appPrefs.ts`'s `planAccountPrefsCarry`.
   */
  accountPrefsCarry?: AccountPrefCarryPlan;
  /**
   * Pin moves a sweep marked a pinned row for and could not write, because the
   * app was open — see `engine/pinMoves.ts`. The pin list is the app's own
   * IndexedDB, safe to write in the same closed-app gap as everything above.
   */
  pins?: PinMovesPlan;
  /**
   * Marks a sweep wrote that the running app has since saved back over — see
   * `engine/marksBack.ts`. Written again in the same closed-app gap, where the
   * app cannot undo them before it reads them.
   */
  marks?: RetitleRequest[];
  /**
   * Archived-flag-only writes (`engine/archiveSync.ts`) the running app has
   * saved back over — see `planArchiveMarksBack`. Written again the same way
   * `marks` above is, in the same closed-app gap.
   */
  archiveMarks?: ArchiveSyncItem[];
  /**
   * Cross-account pin parity — see `engine/pinParity.ts`. Absent only on a
   * plan built by hand without the field, the same convention `pins` above
   * already keeps.
   */
  pinsParity?: PinParityPlan;
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
  /**
   * A cache already holding this run's cards — a sweep's own, reused instead
   * of reading the store from disk a second time. Standalone `foster layout`
   * has no such scan and leaves this out; every scan here then reads the
   * store fresh, exactly as before this was added.
   */
  cache?: ScanCache;
}

/**
 * The other account whose own cards show the latest `lastActivityAt`,
 * overall — the same "most recent source wins" rule the rest of this module
 * already applies per conversation, asked once across every conversation.
 * Shared by the account-uuid-keyed app prefs carry below; `engine/view.ts`
 * keeps its own, narrower version of this for the machine-wide filter menu.
 */
export function mostRecentlyActiveOtherAccount(
  store: StoreLayout,
  target: AccountRef,
  cache?: ScanCache,
): AccountRef | undefined {
  const others = listAccountDirs(store).filter((account) => !sameAccount(account, target));
  let best: AccountRef | undefined;
  let bestAt = -Infinity;
  for (const account of others) {
    const cards = scanAccount(store, account, undefined, { slim: true, cache });
    for (const card of cards) {
      const at = card.data.lastActivityAt ?? 0;
      if (at > bestAt) {
        bestAt = at;
        best = account;
      }
    }
  }
  return best;
}

export function planLayout(options: PlanLayoutOptions): LayoutPlan {
  const { store, target, cache } = options;
  return {
    target,
    groups: planGroups(store, target, options.ledgerEvents ?? [], cache),
    routines: planRoutines(store, target, options.now ?? Date.now()),
    viewPrefs: planLayoutViewCarry(store, target),
    machineViewPrefs: planMachineViewCarry(store, target, options.ledgerEvents ?? []),
    pins: planPinMoves(store, options.ledgerEvents ?? [], target, undefined, cache),
    marks: planMarksBack(options.ledgerEvents ?? [], target, store),
    archiveMarks: planArchiveMarksBack(options.ledgerEvents ?? [], target, store),
    pinsParity: planPinParity(store, target, options.ledgerEvents ?? [], undefined, cache),
    accountPrefsCarry: planAccountPrefsCarry(
      store,
      target,
      mostRecentlyActiveOtherAccount(store, target, cache),
    ),
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
  /** Pins a sweep could not move, still sitting on a row it marked. Absent on a hand-built count. */
  pinsMoved?: number;
  /** Marks the running app saved back over, to write again. Absent on a hand-built count. */
  marksBack?: number;
  /** Archive-only writes the running app saved back over. Absent on a hand-built count. */
  archiveMarksBack?: number;
  /** Pins another account's parity would newly add. Absent on a hand-built count. */
  pinsToPin?: number;
  /** Pins parity would remove — always foster's own earlier pin. Absent on a hand-built count. */
  pinsToUnpin?: number;
  /** Machine-wide filter-menu keys (`groupBy`/`sort`) that would be carried. Absent on a hand-built count. */
  machineViewKeysCarried?: number;
  /** Account-uuid-keyed app prefs that would be carried. Absent on a hand-built count. */
  accountPrefsCarried?: number;
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
    // `?.` for a plan built by hand without the field — every test fixture
    // written before pins joined the layout.
    pinsMoved: plan.pins?.moves.length ?? 0,
    marksBack: plan.marks?.length ?? 0,
    archiveMarksBack: plan.archiveMarks?.length ?? 0,
    pinsToPin: plan.pinsParity?.toPin.length ?? 0,
    pinsToUnpin: plan.pinsParity?.toUnpin.length ?? 0,
    machineViewKeysCarried:
      (plan.machineViewPrefs?.groupBy !== undefined ? 1 : 0) +
      (plan.machineViewPrefs?.sortBy !== undefined ? 1 : 0),
    accountPrefsCarried: Object.keys(plan.accountPrefsCarry?.changes ?? {}).length,
  };
}

/** The sum of every `LayoutPendingCounts` field — 0 means nothing is pending. */
export function totalLayoutPending(counts: LayoutPendingCounts): number {
  return (
    counts.groupsCreated +
    counts.cardsAssigned +
    counts.orderEntriesAdded +
    counts.routinesBrought +
    counts.viewKeysCarried +
    (counts.pinsMoved ?? 0) +
    (counts.marksBack ?? 0) +
    (counts.archiveMarksBack ?? 0) +
    (counts.pinsToPin ?? 0) +
    (counts.pinsToUnpin ?? 0) +
    (counts.machineViewKeysCarried ?? 0) +
    (counts.accountPrefsCarried ?? 0)
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
  /** Machine-wide filter-menu keys (`groupBy`/`sort`) carried this run — see `engine/view.ts`. */
  machineViewKeysCarried: number;
  /** Account-uuid-keyed app prefs carried this run — see `store/appPrefs.ts`. */
  accountPrefsCarried: number;
  /** Deferred pin moves written this run — see `engine/pinMoves.ts`. */
  pinsMoved?: number;
  /** Cross-account pins newly pinned this run — see `engine/pinParity.ts`. */
  pinsPinned?: number;
  /** Cross-account pins removed this run — always foster's own earlier pin. */
  pinsUnpinned?: number;
  /**
   * Why the pin moves could not be written, when they could not. Never a
   * reason the run failed — see the pin step at the end of `applyLayout`.
   */
  pinsError?: string;
  /** Marks written again after the running app had saved over them — see `engine/marksBack.ts`. */
  marksBack?: number;
  /** Archive-only writes written again after the running app undid them — see `planArchiveMarksBack`. */
  archiveMarksBack?: number;
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
  /**
   * Every card this run filed, and the group it went into — what
   * `verifyLayoutGroups` looks for once the app is up again. Empty when no
   * group assignment landed.
   */
  assigned: LayoutAssignment[];
  /**
   * True when, after this run, Local Storage holds the page's sync-pending
   * marker for the target (`DFRAME_SYNC_PENDING_KEY`) — written by this run in
   * the same batch as the groups, or already there naming the target. False
   * when there was no Local Storage database to write into, and then the
   * groups this run wrote are at the mercy of the server copy at startup.
   */
  syncPendingMarked: boolean;
}

/** One card filed into one group by `applyLayout`. */
export interface LayoutAssignment {
  /** `code:local_<uuid>` — the sidebar's own card id. */
  cardId: string;
  groupId: string;
  groupName: string;
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
 * The three places a target's groups have to agree — see AGENTS.md, "Groups
 * live in three places" — plus the one thing that makes them outlive the
 * restart. `undefined` when there is no Local Storage database to write into
 * yet (a store the sidebar's filter menu has never touched), which is a gap to
 * skip rather than a reason to fail the whole run; the config copy is still
 * written, and the post-restart check (`verifyLayoutGroups`) says whether it
 * held.
 *
 * Measured 23/09/2026: all three places agreeing is not enough on its own.
 * `dframe-store` is synced with the account's server copy, and at startup the
 * page replaces the signed-in account's list of groups with the server's —
 * keeping a local `code:local_*` assignment only when its group id is one the
 * server already knows. A group minted here is not, so the whole scope went.
 * The page's own way out is `DFRAME_SYNC_PENDING_KEY`: when it names the
 * signed-in identity, startup uploads the local state instead, and a
 * `|migrate` suffix unions the server's groups in first — so a group another
 * machine added since is kept, not overwritten. It is written into the same
 * batch as the two documents, as `<scopeKey>|migrate`, which only matches when
 * the app next starts signed in as the target — under any other account the
 * page itself clears it. An existing marker that already names the target
 * (the page's own edit-mode value, or its wildcard `1`) is left as it is: it
 * already makes startup upload the local state, groups included, and turning
 * it into a merge would bring back a server-side group the user had since
 * deleted here.
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
): LocalStorageWrite[] | undefined {
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

  const pending = readLocalStorageText(store, DFRAME_SYNC_PENDING_KEY);
  const pendingNamesTarget = pending === key || pending === '1';

  return [
    { scriptKey: 'LSS-persisted.dframe-group-scopes', document: nextLss },
    { scriptKey: 'dframe-store', document: nextDframe },
    ...(pendingNamesTarget
      ? []
      : [{ scriptKey: DFRAME_SYNC_PENDING_KEY, text: syncPendingMigrateValue(target) }]),
  ];
}

/**
 * The marker `localStorageGroupWrites` writes: the page's own vouched identity
 * (`<accountUuid>/<orgUuid>`, the same string `scopeKey` builds), with the
 * `|migrate` suffix the page itself uses when it seeds groups into an account.
 */
export function syncPendingMigrateValue(target: AccountRef): string {
  return `${scopeKey(target)}|migrate`;
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
  let assigned: LayoutAssignment[] = [];
  let syncPendingMarked = false;

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
    localStorageWrites: LocalStorageWrite[] | undefined;
    assigned: LayoutAssignment[];
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
    const currentGroupNameById = new Map(current.groups.map((g) => [g.id, g.name]));

    let groupsCreated = 0;
    let cardsAssigned = 0;
    let orderEntriesAdded = 0;
    let groupsTouched = 0;
    const assigned: LayoutAssignment[] = [];

    for (const item of plannedGroups) {
      const existingId = nameToId.get(item.name);
      const groupId = existingId ?? item.groupId;

      // Rechecked against the group the card is *actually* filed in on disk
      // right now, not the snapshot planning read (#R2): an entry already in
      // this exact group is a no-op. A plain new assignment (no
      // `movedFrom`) is dropped, not written, the moment the disk shows the
      // card filed in some *other* group by the time this runs — planning
      // never checked ownership for that case, only "was it unassigned", so
      // a group that appeared since is the user's own filing and wins, same
      // as before this milestone. A move (`entry.movedFrom` set) is only
      // carried through when the disk still shows the card in the exact
      // group `planGroups` found it in — `movedFrom` is foster's own filing
      // by the plan-time check, but a *second* move since planning is new
      // information this phase never re-verified against the ledger, so it
      // is left alone rather than assumed still safe to override.
      const droppedCardIds = new Set<string>();
      const assign = item.assign.filter((entry) => {
        const currentGroupId = current.assignments[entry.cardId];
        if (currentGroupId === groupId) {
          droppedCardIds.add(entry.cardId);
          return false;
        }
        if (currentGroupId !== undefined) {
          const currentName = currentGroupNameById.get(currentGroupId);
          if (entry.movedFrom === undefined || currentName !== entry.movedFrom) {
            droppedCardIds.add(entry.cardId);
            return false;
          }
        }
        return true;
      });
      // A card whose assignment was just dropped is never left dangling in
      // this group's order list either — the same "order follows where the
      // card is actually filed" rule #A5 already applies at plan time.
      const appendedOrder = item.appendedOrder.filter((cardId) => !droppedCardIds.has(cardId));
      if (assign.length === 0 && appendedOrder.length === 0) continue; // #9, rechecked

      if (existingId === undefined && !nextGroups.some((g) => g.id === groupId)) {
        nextGroups.push({ id: groupId, name: item.name });
        groupsCreated += 1;
      }
      for (const entry of assign) {
        nextAssignments[entry.cardId] = groupId;
        assigned.push({ cardId: entry.cardId, groupId, groupName: item.name });
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
        assigned,
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
    assigned = groups.assigned;
    if (assigned.length > 0) {
      ledger.append({
        kind: 'layout_assigned',
        account: plan.target,
        assignments: assigned.map((entry) => ({
          cardId: entry.cardId,
          groupName: entry.groupName,
        })),
      });
    }

    if (groups.localStorageWrites) {
      try {
        backups.push(backupLocalStorage(store, { now: options.now, env: options.env }));
        const record = readLocalStorageValue(store, 'dframe-store') ?? currentLog(store);
        writeLocalStorageEntries(record, groups.localStorageWrites);
        written.push('groups (Local Storage)');
        // Either this batch carried the marker, or `localStorageGroupWrites`
        // left out one that already named the target — the same outcome.
        syncPendingMarked = true;
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

  // The machine-wide half of the filter menu — `groupBy`/`sort` — carried
  // from a `view_seen` sighting, in `dframe-store` itself (the same Local
  // Storage record the groups write above shares, but this write is
  // independent: it can be needed with no group work pending at all).
  let machineViewKeysCarried = 0;
  if (plan.machineViewPrefs) {
    const { groupBy, sortBy } = plan.machineViewPrefs;
    if (groupBy !== undefined || sortBy !== undefined) {
      try {
        const record = readLocalStorageValue(store, 'dframe-store');
        if (!record) {
          throw new Error(
            'Local Storage has never recorded the sidebar filters — open the Code sidebar in ' +
              'Claude Desktop once, so there is a record for foster to change.',
          );
        }
        backups.push(backupLocalStorage(store, { now: options.now, env: options.env }));
        const state = { ...((record.document.state as Record<string, unknown>) ?? {}) };
        if (groupBy !== undefined) {
          state.groupByByMode = { ...((state.groupByByMode as object) ?? {}), code: groupBy };
        }
        if (sortBy !== undefined) {
          state.sortByByMode = { ...((state.sortByByMode as object) ?? {}), code: sortBy };
        }
        writeLocalStorageValue(record, 'dframe-store', { ...record.document, state });
        written.push('view (machine-wide)');
        if (groupBy !== undefined) {
          ledger.append({
            kind: 'view_carried',
            account: plan.target,
            key: 'groupBy',
            value: groupBy,
          });
        }
        if (sortBy !== undefined) {
          ledger.append({
            kind: 'view_carried',
            account: plan.target,
            key: 'sortBy',
            value: sortBy,
          });
        }
        machineViewKeysCarried = (groupBy !== undefined ? 1 : 0) + (sortBy !== undefined ? 1 : 0);
      } catch (error) {
        appendLedgerIfLanded();
        throw new LayoutWriteError(written, 'view (machine-wide)', error);
      }
    }
  }

  // The account-uuid-keyed app prefs — rechecked fresh (#R2): a target that
  // has gained its own entry since the plan was taken is left alone, the
  // same "target already has one, leave it" rule this run follows for the
  // per-account view prefs above.
  let accountPrefsCarried = 0;
  if (plan.accountPrefsCarry && Object.keys(plan.accountPrefsCarry.changes).length > 0) {
    try {
      const raw = readFileSync(store.desktopConfigFile, 'utf8');
      const current = JSON.parse(raw) as { preferences?: Record<string, unknown> };
      const preferences = current.preferences ?? {};
      const stillMissing = Object.fromEntries(
        Object.entries(plan.accountPrefsCarry.changes).filter(([name]) => {
          const map = preferences[name];
          const record =
            map && typeof map === 'object' && !Array.isArray(map)
              ? (map as Record<string, unknown>)
              : {};
          return !Object.hasOwn(record, plan.target.accountUuid);
        }),
      );
      if (Object.keys(stillMissing).length > 0) {
        const result = writeAccountPrefsCarry(store, plan.target, stillMissing, {
          now: options.now,
          env: options.env,
        });
        backups.push(result.backup);
        written.push('app prefs (by account)');
        accountPrefsCarried = Object.keys(stillMissing).length;
      }
    } catch (error) {
      appendLedgerIfLanded();
      throw new LayoutWriteError(written, 'app prefs (by account)', error);
    }
  }

  // Last, and in a database of its own: the pin list is the app's IndexedDB,
  // not either file above, so nothing here can leave those half-written. It
  // records its own ledger events (`pins_moved`, `pins_synced`), settling the
  // moves a sweep deferred and syncing cross-account pin parity — see
  // `engine/pinMoves.ts` and `engine/pinParity.ts` — in one read/write batch,
  // never two separate database writes in the same gap.
  //
  // A failure here is reported, not thrown. Everything above has landed by
  // now, and a pin is an extra: throwing would call the whole run failed, and
  // since nothing settles the move, every later layout run would fail at the
  // same step and never get to write anything else either.
  let pinsMoved = 0;
  let pinsSyncedCount = { pinned: 0, unpinned: 0 };
  let pinsError: string | undefined;
  const pinsParity = plan.pinsParity;
  const hasPinWork =
    (plan.pins && (plan.pins.moves.length > 0 || plan.pins.settled.length > 0)) ||
    (pinsParity && (pinsParity.toPin.length > 0 || pinsParity.toUnpin.length > 0));
  if (hasPinWork) {
    try {
      const result = applyPinMoves(
        store,
        ledger,
        plan.pins ?? { moves: [], settled: [] },
        { now: options.now },
        pinsParity,
      );
      if (result.backup) backups.push(result.backup);
      if (result.moved > 0) written.push('pins');
      if ((result.pinned ?? 0) > 0 || (result.unpinned ?? 0) > 0) written.push('pins (parity)');
      pinsMoved = result.moved;
      pinsSyncedCount = { pinned: result.pinned ?? 0, unpinned: result.unpinned ?? 0 };
    } catch (error) {
      pinsError = error instanceof Error ? error.message : String(error);
    }
  }

  // The marks the running app saved back over, each its own atomic write and
  // its own `card_retitled`, exactly as the sweep first wrote them. Reported
  // rather than thrown for the pins' reason: an extra, after everything else
  // has landed. `retitleCards` never throws for one card; it records a failure.
  let marksBack = 0;
  if (plan.marks && plan.marks.length > 0) {
    const outcomes = retitleCards(plan.marks, { ledger });
    marksBack = outcomes.filter((outcome) => outcome.status === 'retitled').length;
    if (marksBack > 0) written.push('marks');
  }

  // The archive-only writes the running app saved back over, same reasoning
  // as `marks` above: its own atomic write and its own `archive_synced`,
  // never thrown for one card.
  let archiveMarksBack = 0;
  if (plan.archiveMarks && plan.archiveMarks.length > 0) {
    const outcomes = applyArchiveSync(plan.archiveMarks, { ledger });
    archiveMarksBack = outcomes.filter((outcome) => outcome.status === 'written').length;
    if (archiveMarksBack > 0) written.push('archive marks');
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
    machineViewKeysCarried,
    accountPrefsCarried,
    pinsMoved,
    pinsPinned: pinsSyncedCount.pinned,
    pinsUnpinned: pinsSyncedCount.unpinned,
    ...(pinsError ? { pinsError } : {}),
    marksBack,
    archiveMarksBack,
    backups,
    written,
    assigned,
    syncPendingMarked,
  };
}
