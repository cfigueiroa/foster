import { UNTITLED } from '../domain/fostering.js';
import { looksMarked, staleMark, stripMarks, templatesSeen } from '../domain/stale.js';
import type { DiscoveredSession } from '../domain/types.js';
import type { LedgerEvent } from '../ledger/types.js';
import type { LedgerState } from '../ledger/project.js';
import { divergedFrom, type BranchWeight, type Forks } from './branches.js';
import { fosterSessions, type FosterOptions, type Outcome } from './executor.js';
import { markFor, UNKNOWN_MARK_DETAIL, type MarkDecision } from './marks.js';
import { retitleCards, type RetitleOutcome, type RetitleRequest } from './retitle.js';
import type { Sidebar } from './sidebar.js';

// The mark this pass writes is the same write `fileCards.ts` makes for its own
// reason, so the rules that make it safe live in `marks.ts` rather than here.
export { UNKNOWN_MARK_DETAIL } from './marks.js';

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
 * — keeps its title untouched. A row this account already holds on another
 * branch is marked the same way as a copy would be, native or not;
 * `retitle.ts` says why that write is safe with the app open.
 *
 * What the other branches wear depends on whether they stopped. A branch that
 * holds records of its own and went on after the tip did is not stale — it is
 * where the work was left, and on this store it was where two of the forks the
 * sweep could see had been left, 50 and 77 hours after the tip stopped.
 * It keeps its place in the sidebar and says which branch it is. Only a branch
 * that really did stop earlier is marked stale and filed in the archived view:
 * still there, still opens, no longer looking like the row to continue in.
 *
 * Nothing here decides between branches, which is what kept `consolidate` a
 * question for the user. Every branch keeps a row, so there is nothing to lose
 * and no threshold to set.
 */

/**
 * What a row is, among the branches of one conversation.
 *
 * `tip` holds most work of its own; `diverged` went on after the tip did and
 * keeps its place; `stale` stopped earlier and is filed away.
 */
export type BranchKind = 'tip' | 'diverged' | 'stale';

export interface BranchRow {
  cliSessionId: string;
  /** True for the branch that carried on. */
  tip: boolean;
  kind: BranchKind;
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
  /**
   * The template `prefix`'s mark was made from, `{when}` unfilled — absent for
   * the tip, which carries no mark. Recorded on the `fostered` event so a later
   * run recognises this mark whatever words it is itself given.
   */
  template?: string;
}

export interface ForkPlan {
  root: string;
  tip: string;
  rows: BranchRow[];
  bring: BringRequest[];
  retitle: RetitleRequest[];
  /** Rows left as they are, and why. */
  skipped: { sessionId: string; title: string; detail: string }[];
  /**
   * The tip's own card, when this account already holds one for it — read
   * before any write this pass makes, so the id is stable whether or not the
   * card also needs its mark taken off. Absent when the tip has no row here
   * yet; `applyBranchCards` fills that in from the copy it brings, if it brings
   * one. The sweep's pin pass is why this is carried at all: a pin that follows
   * a row the branch pass just marked stale has to be moved onto *something*,
   * and this is where that something is named.
   */
  tipHeld?: { sessionId: string; title: string };
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
  /** The mark a branch wears when it went on after the tip. */
  divergedTemplate: string;
  /** Conversations a live `claude` is writing, lower-cased. */
  live: ReadonlySet<string>;
  state: LedgerState;
  /**
   * The ledger's raw events, for `templatesSeen` — a row marked by an earlier
   * run, in different words than this one was given, is still recognised from
   * what the log says it was written with (#35).
   */
  events: readonly LedgerEvent[];
}

export function planBranchCards(input: BranchPlanInput): ForkPlan[] {
  const { forks, here, hereCards, candidates, orphans, prefix, live, state, events } = input;
  const { staleTemplate, divergedTemplate } = input;
  // The words this run was told, plus every word the ledger proves an earlier
  // run wrote — so a row marked stale in Portuguese last week is still
  // recognised by a bare `foster sweep` today (#35).
  const templates = [...new Set([staleTemplate, divergedTemplate, ...templatesSeen(events)])];

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
      const kind: BranchKind = isTip
        ? 'tip'
        : divergedFrom(branch, fork.branches[0]!)
          ? 'diverged'
          : 'stale';
      const stoppedAt = stoppedAtOf(branch);
      const mark =
        kind === 'tip'
          ? ''
          : staleMark(kind === 'diverged' ? divergedTemplate : staleTemplate, stoppedAt);
      const held = hereCards.filter((card) => sameId(card.data.cliSessionId, id));
      const row: BranchRow = {
        cliSessionId: id,
        tip: isTip,
        kind,
        total: branch.total,
        only: branch.only,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        held: held.length,
        action: 'none',
      };

      if (held.length > 0) {
        row.action = 'keep';
        if (isTip) {
          // The first held card stands in for the row; a tip with more than one
          // is the app having made a duplicate, which is not this pass's problem
          // to resolve. Read now, before `retitle` below might rewrite its title.
          plan.tipHeld = {
            sessionId: held[0]!.data.sessionId,
            title: stripMarks(held[0]!.data.title ?? '', templates),
          };
        }
        for (const card of held) {
          const decision = retitleFor(card, {
            kind,
            mark,
            templates,
            archivedByFoster,
            staleTemplate,
            divergedTemplate,
          });
          if (decision.kind === 'none') continue;
          if (decision.kind === 'unknown-mark') {
            plan.skipped.push({
              sessionId: card.data.sessionId,
              title: card.data.title ?? UNTITLED,
              detail: UNKNOWN_MARK_DETAIL,
            });
            continue;
          }
          if (live.has(id.toLowerCase())) {
            plan.skipped.push({
              sessionId: card.data.sessionId,
              title: card.data.title ?? UNTITLED,
              detail: 'a live claude is writing this branch — left as it is',
            });
            continue;
          }
          plan.retitle.push(decision.request);
          row.action = 'retitle';
        }
      } else if (kind === 'stale' && branch.only === 0) {
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
          const cleanSource = stripMarks(pick.data.title ?? '', templates);
          if (looksMarked(cleanSource)) {
            plan.skipped.push({
              sessionId: pick.data.sessionId,
              title: pick.data.title ?? UNTITLED,
              detail: UNKNOWN_MARK_DETAIL,
            });
          } else {
            plan.bring.push({
              session: withTitle(pick, cleanSource),
              prefix: `${mark}${prefix}`,
              archive: kind === 'stale',
              origin: fromSource ? 'source' : 'deleted',
              tip: isTip,
              ...(kind === 'tip'
                ? {}
                : { template: kind === 'diverged' ? divergedTemplate : staleTemplate }),
            });
            row.action = 'bring';
          }
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

/**
 * What to do about one card of one branch, in the vocabulary of this pass:
 * which branch it is decides the mark, whether the row is filed away, and
 * which template the write records. Everything after that is `markFor`'s.
 */
function retitleFor(
  card: DiscoveredSession,
  context: {
    kind: BranchKind;
    mark: string;
    templates: readonly string[];
    archivedByFoster: Set<string>;
    staleTemplate: string;
    divergedTemplate: string;
  },
): MarkDecision {
  const { kind, mark, templates, archivedByFoster, staleTemplate, divergedTemplate } = context;
  return markFor(card, {
    as: kind,
    mark,
    // A tip strips a mark rather than adding one, so it names no template of
    // its own: `markFor` records whichever known one explains what it took off.
    ...(kind === 'stale'
      ? { template: staleTemplate }
      : kind === 'diverged'
        ? { template: divergedTemplate }
        : {}),
    templates,
    archivedByFoster,
    // Only a branch that stopped is filed away. A branch that went on comes
    // back out of the archived view when foster is the one that put it there.
    file: kind === 'stale',
  });
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
  /**
   * The tip's row in this account once this pass is done — carried from
   * `ForkPlan.tipHeld` when the tip already had a card here, or read off the
   * copy this pass just brought when it did not. Absent only when neither
   * applies, which is the tip having arrived earlier through the ordinary pass
   * under `opensMore` rather than through this one — this pass has no record
   * of that copy's id to offer. The sweep's pin pass is the only reader.
   */
  tipCard?: { sessionId: string; title: string };
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
    // Set from the plan when the tip already had a row; a bring for the tip
    // below fills it in from the copy actually written, since that copy's id
    // is minted only now and the plan could not have known it.
    let tipCard = plan.tipHeld;
    for (const request of plan.bring) {
      const made = fosterSessions([request.session], {
        ...options,
        prefix: request.prefix,
        acceptBranches: true,
        includeArchived: true,
        ...(request.archive ? { archive: true } : {}),
        ...(request.template ? { template: request.template } : {}),
      });
      for (const outcome of made) {
        if (outcome.status === 'fostered' && (request.archive || request.session.data.isArchived)) {
          archived += 1;
        }
      }
      if (request.tip && !tipCard) {
        const fostered = made.find((outcome) => outcome.status === 'fostered');
        if (fostered?.copySessionId) {
          tipCard = {
            sessionId: fostered.copySessionId,
            title: fostered.copyTitle ?? fostered.title,
          };
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
      ...(tipCard ? { tipCard } : {}),
    });
  }

  return { forks, outcomes, retitled, archived };
}
