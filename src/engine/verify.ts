import { sameAccount } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { LedgerEvent } from '../ledger/types.js';
import { layoutAssignedByCard, planLayout, type LayoutPlan } from './layout.js';
import type { PinMove } from './pinMoves.js';
import { fosterOwnedPins } from './pinParity.js';
import type { RetitleRequest } from './retitle.js';
import { readViewState, viewCarriedFor } from './view.js';
import { readGroupScopes, scopeKey } from '../store/groupScopes.js';
import { readPinState } from '../store/pinstate.js';
import { readScheduledTasks } from '../store/routines.js';

/**
 * Read back everything the ledger says foster wrote to one account, and say
 * what the app has since undone.
 *
 * The occasion is the gap `foster layout --yes --restart` and `sweep
 * --restart` open and close: they write while the app is down, and the app's
 * own startup can rewrite some of it straight back — measured 23/09/2026 and
 * 24/09/2026 on real stores, in two different ways. `marksBack.ts` and
 * `pinMoves.ts` each already answer "did this specific write stick?" from the
 * ledger alone, which is exactly what a command run well after the fact, in a
 * fresh process, can still ask; `layoutVerify.ts`'s own check cannot be
 * repeated here, because it rests on the `LayoutAssignment[]` a run planned in
 * memory and a `layout_applied` ledger event carries only counts (see the
 * comment on `LayoutAppliedEvent` — nothing reads its fields back on purpose).
 *
 * `planLayout` already composes `planMarksBack` and `planPinMoves` for
 * exactly this reason — `foster layout` calls it to decide what to write in
 * the gap — so reading its `.marks` and `.pins` back out is the whole of the
 * title/archived-flag and pin halves of this check, not a re-derivation.
 *
 * Groups and routines get a narrower, explicitly hedged check. Nothing in the
 * ledger says which card a past run put in which group, so "is this specific
 * assignment still there" cannot be answered after the fact the way a title
 * or a pin can. What can be told apart is the shape measured on 23/09/2026: a
 * scope that goes from N groups to zero while a fresh plan still wants to
 * create some — the account had layout applied to it before, and now shows
 * none of it. Anything short of that — a plan with pending assignments but a
 * non-empty scope — is reported as pending work, not asserted as undone,
 * because it cannot be told apart from other accounts simply having gained
 * new group assignments since the last run.
 */

export interface VerifyMarks {
  /** Cards whose title or archived flag the app reverted — see `planMarksBack`. */
  pending: RetitleRequest[];
}

export interface VerifyPins {
  /** Moves that still need writing — never landed, or landed and were undone. */
  pending: PinMove[];
  /** Moves already reflected in the pin list; nothing to do. */
  settled: PinMove[];
  /** Set when the pin list itself could not be read. */
  unreadable?: string;
}

export interface VerifyGroups {
  /** Whether the ledger has ever recorded `layout_applied` creating a group here. */
  everApplied: boolean;
  /** Groups the store's config currently holds for this account. */
  nowGroups: number;
  /** Card assignments the store's config currently holds for this account. */
  nowAssignments: number;
  /** New groups a fresh plan would still create. */
  pendingNewGroups: number;
  /** Card assignments a fresh plan would still make. */
  pendingAssignments: number;
  /**
   * True only for the shape actually measured on a real store: every group
   * this account ever had is gone, and a fresh plan wants to recreate some.
   * A non-zero pending count on its own is not enough — see the module doc.
   */
  reset: boolean;
}

export interface VerifyRoutines {
  everApplied: boolean;
  nowCount: number;
  pendingBring: number;
  reset: boolean;
}

/** Cross-account pins foster synced that are no longer pinned. */
export interface VerifyPinParity {
  undone: string[];
}

/** Machine-wide/per-account filter-menu values foster carried that no longer match. */
export interface VerifyViewCarried {
  undone: { key: string; expected: unknown; actual: unknown }[];
}

/** Group filings foster wrote (moves included) that no longer hold. */
export interface VerifyGroupAssignments {
  undone: { cardId: string; groupName: string }[];
}

export interface VerifyReport {
  target: AccountRef;
  marks: VerifyMarks;
  pins: VerifyPins;
  groups: VerifyGroups;
  routines: VerifyRoutines;
  /** Cross-account pin parity — see `engine/pinParity.ts`. */
  pinParity: VerifyPinParity;
  /** Sidebar filter-menu values foster carried — see `engine/view.ts`. */
  viewCarried: VerifyViewCarried;
  /** Group filings (including moves) foster wrote — see `engine/layout.ts`. */
  groupAssignments: VerifyGroupAssignments;
  /** True when anything above found the app had undone a write. */
  undone: boolean;
}

function everAppliedGroups(events: readonly LedgerEvent[], target: AccountRef): boolean {
  return events.some(
    (event) =>
      event.kind === 'layout_applied' &&
      sameAccount(event.target, target) &&
      (event.groupsCreated ?? event.groups) > 0,
  );
}

function everAppliedRoutines(events: readonly LedgerEvent[], target: AccountRef): boolean {
  return events.some(
    (event) =>
      event.kind === 'layout_applied' && sameAccount(event.target, target) && event.routines > 0,
  );
}

/**
 * Groups/routines from a `LayoutPlan` already built — split out so a caller
 * that has one anyway (`foster layout`'s own preview) is not asked to build a
 * second.
 */
export function verifyFromPlan(
  store: StoreLayout,
  target: AccountRef,
  events: readonly LedgerEvent[],
  plan: LayoutPlan,
): VerifyReport {
  const marks: VerifyMarks = { pending: plan.marks ?? [] };
  const pinsPlan = plan.pins;
  const pins: VerifyPins = {
    pending: pinsPlan?.moves ?? [],
    settled: pinsPlan?.settled ?? [],
    ...(pinsPlan?.unreadable === undefined ? {} : { unreadable: pinsPlan.unreadable }),
  };

  const scope = readGroupScopes(store)[scopeKey(target)];
  const nowGroups = scope?.groups.length ?? 0;
  const nowAssignments = scope ? Object.keys(scope.assignments).length : 0;
  const pendingNewGroups = plan.groups.items.filter((item) => item.created).length;
  const pendingAssignments = plan.groups.items.reduce((sum, item) => sum + item.assign.length, 0);
  const groupsEverApplied = everAppliedGroups(events, target);
  const groups: VerifyGroups = {
    everApplied: groupsEverApplied,
    nowGroups,
    nowAssignments,
    pendingNewGroups,
    pendingAssignments,
    reset: groupsEverApplied && nowGroups === 0 && pendingNewGroups + pendingAssignments > 0,
  };

  let nowCount = 0;
  const read = readScheduledTasks(store, target);
  if (read.status === 'ok') nowCount = read.file.scheduledTasks.length;
  const routinesEverApplied = everAppliedRoutines(events, target);
  const pendingBring = plan.routines.bring.length;
  const routines: VerifyRoutines = {
    everApplied: routinesEverApplied,
    nowCount,
    pendingBring,
    reset: routinesEverApplied && nowCount === 0 && pendingBring > 0,
  };

  // Cross-account pin parity: every id foster itself pinned (folded from
  // `pins_synced`) should still be pinned, unless a later `pins_synced`
  // already unpinned it — `fosterOwnedPins` already drops those.
  const owned = fosterOwnedPins(events, target);
  let pinnedIds: Set<string> | undefined;
  try {
    pinnedIds = new Set(readPinState(store)?.ids ?? []);
  } catch {
    pinnedIds = undefined; // unreadable — nothing to compare against, reported as no findings
  }
  const pinParity: VerifyPinParity = {
    undone: pinnedIds ? [...owned].filter((id) => !pinnedIds!.has(id)) : [],
  };

  // Sidebar filter-menu values foster carried: the machine-wide groupBy/sort,
  // plus the per-account keys `planLayoutViewCarry` may have written before.
  const currentView = readViewState(store, target);
  const viewCarriedUndone: VerifyViewCarried['undone'] = [];
  for (const key of ['groupBy', 'sortBy'] as const) {
    const expected = viewCarriedFor(events, target, key);
    if (expected === undefined) continue;
    const actual = key === 'groupBy' ? currentView.groupBy : currentView.sort;
    if (actual !== expected) viewCarriedUndone.push({ key, expected, actual });
  }
  const viewCarried: VerifyViewCarried = { undone: viewCarriedUndone };

  // Group filings foster wrote (including a move away from an earlier
  // group): the card should still be filed in the group the ledger names.
  const fosterFiled = layoutAssignedByCard(events, target);
  const groupIdByName = new Map((scope?.groups ?? []).map((g) => [g.name, g.id]));
  const groupAssignmentsUndone: VerifyGroupAssignments['undone'] = [];
  for (const [cardId, groupName] of fosterFiled) {
    const expectedGroupId = groupIdByName.get(groupName);
    const actualGroupId = scope?.assignments[cardId];
    if (expectedGroupId === undefined || actualGroupId !== expectedGroupId) {
      groupAssignmentsUndone.push({ cardId, groupName });
    }
  }
  const groupAssignments: VerifyGroupAssignments = { undone: groupAssignmentsUndone };

  const undone =
    marks.pending.length > 0 ||
    pins.pending.length > 0 ||
    groups.reset ||
    routines.reset ||
    pinParity.undone.length > 0 ||
    viewCarried.undone.length > 0 ||
    groupAssignments.undone.length > 0;

  return {
    target,
    marks,
    pins,
    groups,
    routines,
    pinParity,
    viewCarried,
    groupAssignments,
    undone,
  };
}

export function planVerify(
  store: StoreLayout,
  target: AccountRef,
  events: readonly LedgerEvent[],
): VerifyReport {
  const plan = planLayout({ store, target, ledgerEvents: events });
  return verifyFromPlan(store, target, events, plan);
}
