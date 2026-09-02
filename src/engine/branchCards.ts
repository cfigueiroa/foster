import { UNTITLED } from '../domain/fostering.js';
import { staleMark, stripStale } from '../domain/stale.js';
import type { DiscoveredSession } from '../domain/types.js';
import type { LedgerState } from '../ledger/project.js';
import type { BranchWeight, Forks } from './branches.js';
import { fosterSessions, type FosterOptions, type Outcome } from './executor.js';
import { retitleCards, type RetitleOutcome, type RetitleRequest } from './retitle.js';
import type { Sidebar } from './sidebar.js';

/**
 * One row per branch, and the rows say which one carried on.
 *
 * A fork is one piece of work on two or more transcripts, and the sweep used to
 * stop at it: the destination showed whichever half had reached it first, the
 * half that carried on was refused as "already has a branch", and merging was
 * left to `consolidate` — which refuses beyond a threshold, wants the app
 * closed, and hides every branch but one. Measured on a real store, the row the
 * user had pinned held 328 records while the branches in the other accounts
 * held 3157 and 2564, and every sweep reported that nothing was left to do.
 *
 * So the sweep gives every branch its own row instead, and hides nothing. The
 * branch that carried on — `branches[0]`, by the measure `branches.ts` defends
 * — keeps its title untouched. Every other branch is marked stale in the title
 * and filed in the archived view: it is still there, still opens, and no longer
 * looks like the row to continue in. A row this account already holds on a
 * stale branch is marked the same way, native or not; `retitle.ts` says why
 * that write is safe with the app open.
 *
 * Nothing here decides between branches, which is what kept `consolidate` a
 * question for the user. Every branch keeps a row, so there is nothing to lose
 * and no threshold to set.
 */

export interface BranchRow {
  cliSessionId: string;
  /** True for the branch that carried on. */
  tip: boolean;
  total: number;
  only: number;
  /** When the last answer on this branch was written, when the transcript says. */
  stoppedAt?: number;
  /** Cards this account holds for exactly this branch. */
  held: number;
  action: 'keep' | 'bring' | 'retitle' | 'none';
}

export interface BringRequest {
  /** The card to copy, its title already stripped of any earlier stale mark. */
  session: DiscoveredSession;
  /** The stale mark, when the branch stopped, in front of the caller's own prefix. */
  prefix: string;
  archive: boolean;
  /** A card in a source account, or a conversation the app deleted the card for. */
  origin: 'source' | 'deleted';
  tip: boolean;
}

export interface ForkPlan {
  root: string;
  tip: string;
  rows: BranchRow[];
  bring: BringRequest[];
  retitle: RetitleRequest[];
  /** Rows left as they are, and why. */
  skipped: { sessionId: string; title: string; detail: string }[];
}

export interface BranchPlanInput {
  forks: Forks;
  /** The destination, as this run sees it — copies planned so far included. */
  here: Sidebar;
  /** The destination's cards on disk. */
  hereCards: DiscoveredSession[];
  /** Fosterable sessions from the sources that belong to a fork, most recent first. */
  candidates: DiscoveredSession[];
  /** Restorable conversations that belong to a fork, most recent first. */
  orphans: DiscoveredSession[];
  /** The caller's ordinary title prefix. */
  prefix: string;
  staleTemplate: string;
  /** Conversations a live `claude` is writing, lower-cased. */
  live: ReadonlySet<string>;
  state: LedgerState;
}

export function planBranchCards(input: BranchPlanInput): ForkPlan[] {
  const { forks, here, hereCards, candidates, orphans, prefix, staleTemplate, live, state } = input;

  // Cards foster itself filed away, by session id. Only those are lifted back
  // out when their branch turns out to be the one that carried on: a flag the
  // user set is the user's.
  const archivedByFoster = new Set<string>();
  for (const fostering of state.active.values()) {
    if (fostering.archivedByFoster) archivedByFoster.add(fostering.copySessionId);
  }
  for (const card of state.retitled.values()) {
    if (card.toArchived) archivedByFoster.add(card.sessionId);
  }

  const plans: ForkPlan[] = [];

  for (const fork of forks.all()) {
    const tip = fork.branches[0]!.cliSessionId;
    const plan: ForkPlan = { root: fork.root, tip, rows: [], bring: [], retitle: [], skipped: [] };

    for (const branch of fork.branches) {
      const id = branch.cliSessionId;
      const isTip = id === tip;
      const stoppedAt = stoppedAtOf(branch);
      const mark = isTip ? '' : staleMark(staleTemplate, stoppedAt);
      const held = hereCards.filter((card) => sameId(card.data.cliSessionId, id));
      const row: BranchRow = {
        cliSessionId: id,
        tip: isTip,
        total: branch.total,
        only: branch.only,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        held: held.length,
        action: 'none',
      };

      if (held.length > 0) {
        row.action = 'keep';
        for (const card of held) {
          const request = retitleFor(card, { isTip, mark, staleTemplate, archivedByFoster });
          if (!request) continue;
          if (live.has(id.toLowerCase())) {
            plan.skipped.push({
              sessionId: card.data.sessionId,
              title: card.data.title ?? UNTITLED,
              detail: 'a live claude is writing this branch — left as it is',
            });
            continue;
          }
          plan.retitle.push(request);
          row.action = 'retitle';
        }
      } else if (!isTip && branch.only === 0) {
        // Every record it holds, the branch that carried on holds too: a row
        // for it would open nothing the clean row does not, and the sidebar
        // is the one place a row costs something. A row already here on such
        // a branch is still marked above — it is stale, whatever it holds.
        row.action = 'none';
      } else if (!here.shows(id)) {
        // One card per branch, whichever source holds it most recently; both
        // lists arrive most recent first. A deleted conversation counts too —
        // it is the case where the branch that carried on has no card anywhere.
        const fromSource = candidates.find((session) => sameId(session.data.cliSessionId, id));
        const pick = fromSource ?? orphans.find((session) => sameId(session.data.cliSessionId, id));
        if (pick) {
          plan.bring.push({
            session: withTitle(pick, stripStale(pick.data.title ?? '', staleTemplate)),
            prefix: `${mark}${prefix}`,
            archive: !isTip,
            origin: fromSource ? 'source' : 'deleted',
            tip: isTip,
          });
          row.action = 'bring';
        }
      }

      plan.rows.push(row);
    }

    plans.push(plan);
  }

  return plans;
}

/**
 * Where the work on a branch was left: its last answer. The last record would
 * be wrong here — `transcripts.ts` explains the click that moves it.
 */
function stoppedAtOf(branch: BranchWeight): number | undefined {
  return branch.lastAssistantAt ?? branch.lastMessageAt;
}

/** Compared with case folded, as this identifier is everywhere else it is compared. */
function sameId(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function retitleFor(
  card: DiscoveredSession,
  context: { isTip: boolean; mark: string; staleTemplate: string; archivedByFoster: Set<string> },
): RetitleRequest | undefined {
  const { isTip, mark, staleTemplate, archivedByFoster } = context;
  const current = card.data.title ?? '';
  const clean = stripStale(current, staleTemplate);
  const title = isTip ? clean : `${mark}${clean.trim() ? clean : UNTITLED}`;

  let archived: boolean | undefined;
  if (isTip) {
    if (card.data.isArchived && archivedByFoster.has(card.data.sessionId)) archived = false;
  } else if (!card.data.isArchived) {
    archived = true;
  }

  if (title === current && archived === undefined) return undefined;
  return {
    path: card.path,
    target: card.account,
    native: !card.isCopy,
    title,
    ...(archived === undefined ? {} : { archived }),
    as: isTip ? 'tip' : 'stale',
  };
}

function withTitle(session: DiscoveredSession, title: string): DiscoveredSession {
  if (title === (session.data.title ?? '')) return session;
  const data = { ...session.data };
  if (title.trim()) data.title = title;
  else delete data.title;
  return { ...session, data };
}

export interface ForkOutcome {
  root: string;
  tip: string;
  rows: BranchRow[];
  brought: Outcome[];
  retitled: RetitleOutcome[];
  skipped: ForkPlan['skipped'];
}

export interface BranchesResult {
  forks: ForkOutcome[];
  /** Every copy the pass made or planned, across forks. */
  outcomes: Outcome[];
  retitled: RetitleOutcome[];
  /** Rows that arrive in, or move to, the archived view. */
  archived: number;
}

/**
 * Carry the plan out: copies first, then the marks, per fork.
 *
 * Copies before marks so a mark that cannot be written never costs a row —
 * the row is the part that cannot be recovered from the log alone.
 */
export function applyBranchCards(plans: ForkPlan[], options: FosterOptions): BranchesResult {
  const forks: ForkOutcome[] = [];
  const outcomes: Outcome[] = [];
  const retitled: RetitleOutcome[] = [];
  let archived = 0;

  for (const plan of plans) {
    const brought: Outcome[] = [];
    for (const request of plan.bring) {
      const made = fosterSessions([request.session], {
        ...options,
        prefix: request.prefix,
        acceptBranches: true,
        includeArchived: true,
        ...(request.archive ? { archive: true } : {}),
      });
      for (const outcome of made) {
        if (outcome.status === 'fostered' && (request.archive || request.session.data.isArchived)) {
          archived += 1;
        }
      }
      brought.push(...made);
    }

    const marks = retitleCards(plan.retitle, { ledger: options.ledger, dryRun: options.dryRun });
    for (const outcome of marks) {
      if (outcome.status === 'retitled' && outcome.archived?.to) archived += 1;
    }

    outcomes.push(...brought);
    retitled.push(...marks);
    forks.push({
      root: plan.root,
      tip: plan.tip,
      rows: plan.rows,
      brought,
      retitled: marks,
      skipped: plan.skipped,
    });
  }

  return { forks, outcomes, retitled, archived };
}
