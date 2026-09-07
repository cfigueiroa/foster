import path from 'node:path';
import { copyCwd, DEFAULT_PREFIX } from '../domain/fostering.js';
import { blockingReasons } from '../domain/filter.js';
import { listAccountDirs, storeIdentity } from '../domain/paths.js';
import { DEFAULT_DIVERGED_TEMPLATE, DEFAULT_STALE_TEMPLATE } from '../domain/stale.js';
import type { AccountRef, DiscoveredSession, StoreLayout, Unfosterable } from '../domain/types.js';
import { requireCurrentAccount } from '../engine/account.js';
import {
  applyBranchCards,
  planBranchCards,
  type BranchesResult,
  type ForkOutcome,
} from '../engine/branchCards.js';
import { forksOf } from '../engine/branches.js';
import { inspectDesktopFor, readProcesses, type ProcessLister } from '../engine/desktop.js';
import {
  fosterSessions,
  summariseOutcomes,
  type Outcome,
  type OutcomeStatus,
} from '../engine/executor.js';
import { lineage, lineageAt, type Lineage } from '../engine/lineage.js';
import type { RetitleOutcome } from '../engine/retitle.js';
import { inspectApp } from '../engine/safety.js';
import { sidebarFrom } from '../engine/sidebar.js';
import {
  applyTitleSync,
  planTitleSync,
  type TitleSyncItem,
  type TitleSyncSkipped,
} from '../engine/titleSync.js';
import {
  applyUnclaim,
  planUnclaim,
  type UnclaimItem,
  type UnclaimOutcome,
} from '../engine/unclaim.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, project } from '../ledger/project.js';
import { backupPinState, readPinState, writePinState, type PinState } from '../store/pinstate.js';
import { findRestorable } from '../store/restore.js';
import { fromAccounts, scanAccount, scanStore } from '../store/scanner.js';
import { errorMessage } from '../util/fs.js';
import { fosterableFrom, liveConversationIds } from './foster.js';

/**
 * The whole job, in one call: everything that can be in this account's sidebar,
 * is.
 *
 * The request behind it never varies — "bring it all here, archived and deleted
 * included" — and answering it used to take three commands in the right order
 * plus knowledge that lived in no executable place. `--archived` is the piece
 * that was invisible: measured on one real store, the same sweep offered 15
 * sessions without it and 141 with it, so anyone who did not know the flag
 * finished with a tenth of the work done and no way to tell.
 *
 * Three passes, in this order, then a re-plan that proves they are exhausted:
 *
 *  1. copy every fosterable session from the other accounts, archived included —
 *     the copy keeps the flag, so it lands in the destination's archived view
 *     rather than quietly reappearing in Recents;
 *  2. give every branch of a forked conversation a row of its own: the branch
 *     that carried on keeps its title, the rest are marked stale and filed in
 *     the archived view — see `branchCards.ts`;
 *  3. bring back conversations the app deleted that nothing still points at;
 *  4. release the worktree claim a copy already on disk inherited from its
 *     original, before `buildFosterCopy` learned not to hand one out (0.38.0,
 *     #27) — see `engine/unclaim.ts`. A copy fighting the original over a
 *     branch is a copy the app drops into the main repository, uncommitted
 *     work and all, which is not a session the user can use.
 *
 * Order matters. A conversation a fresh copy now points at is not lost any more,
 * so restoring after fostering asks the third question against the answer to
 * the first rather than against the state before it; and a fork's members are
 * kept out of the first pass so each row is written once, with its final title.
 * The worktree pass runs last, after the ledger holds every fostering the run
 * itself just wrote — not that a fresh copy would ever need it, since
 * `buildFosterCopy` already drops the claim at the point of copying, but so
 * the pass sees the same, settled state of this account's own directory the
 * final report describes.
 *
 * Right after the branch pass, a pin check follows through on what it just
 * wrote: pinning lives in the app's own IndexedDB, keyed on session id
 * (`store/pinstate.ts`), so a row the branch pass just marked stale keeps
 * whatever pin it had and the branch that carried on arrives unpinned. The
 * check always reads — one LevelDB read, which the app usually refuses (see
 * open — and only writes when the store allows it, degrading to a message in
 * `report.pinFixes` otherwise (#23).
 *
 * What is deliberately *not* here: `purge`, which destroys transcripts and is
 * part of no sweep. `consolidate` is not either, but for the opposite reason —
 * with a row per branch nothing is hidden, so collapsing a fork to one row is a
 * tidy-up for whoever wants one, not a decision the sweep has to leave open.
 *
 * One scan, one lineage, one transcript index for the whole run. The passes
 * used to build their own, and a `--yes` run read every card in the store five
 * times over and walked the transcript tree six.
 */

export interface SweepOptions {
  store: StoreLayout;
  ledger: Ledger;
  /** Where the copies go. Defaults to the account the app is signed into. */
  target?: AccountRef;
  prefix?: string;
  /**
   * What a row for a branch that stopped wears in front of its title; `{when}`
   * is where the moment of its last answer goes. See `domain/stale.ts`.
   */
  staleTemplate?: string;
  /**
   * What a row for a branch that went on after the tip wears instead. Such a
   * branch is not stale and is not filed away; see `domain/stale.ts`.
   */
  divergedTemplate?: string;
  /**
   * Bring every copy's title back into step with the original's — the fifth
   * pass, off by default. See `engine/titleSync.ts`; the flag exists because
   * the first run on a store that has been fostered into for weeks rewrites in
   * bulk, and a pass that changes a thousand sidebar rows should be asked for.
   */
  syncTitles?: boolean;
  /** When true, plan everything and write nothing. */
  dryRun?: boolean;
  /** Extra Claude config directories to search for deleted conversations. */
  configDirs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Transcript `projects/` directories, for tests. Wins over `env` and `configDirs`. */
  projectsDirs?: string[];
  /**
   * Conversations a live `claude` is writing. Injected so the engine stays free
   * of process inspection; production reads the real registry.
   */
  live?: ReadonlySet<string>;
  /**
   * The process table reader the pin pass asks before writing — see
   * `restartPlan`'s own `list` parameter. Injected so a test can drive a
   * synthetic table instead of the real machine deciding whether it passes.
   */
  list?: ProcessLister;
}

export interface SweepPhase {
  outcomes: Outcome[];
  counts: Record<OutcomeStatus, number>;
}

/**
 * The worktree-claim pass: what a copy already on disk is still holding.
 *
 * `outcomes` is empty on a dry run — nothing was written, so there is nothing
 * to report beyond the plan itself, the same convention `SweepPhase` keeps.
 */
export interface WorktreeClaimsPhase {
  items: UnclaimItem[];
  outcomes: UnclaimOutcome[];
  counts: { released: number; skipped: number; failed: number };
}

/**
 * The title pass: copies whose original is called something else now.
 *
 * `outcomes` is empty on a dry run, the convention every other phase keeps, and
 * the whole phase is absent from a run that did not ask for it.
 */
export interface TitleSyncPhase {
  items: TitleSyncItem[];
  skipped: TitleSyncSkipped[];
  outcomes: RetitleOutcome[];
  counts: { synced: number; skipped: number; failed: number };
}

/** The branch pass: what it brought, what it marked, per fork. */
export interface BranchesPhase extends BranchesResult {
  counts: Record<OutcomeStatus, number>;
  /** The template the stale rows were marked with, for the summary to quote. */
  staleTemplate: string;
  /** The template the rows that went on were marked with. */
  divergedTemplate: string;
}

/**
 * One pinned row the branch pass just left holding a mark it should not: the
 * sidebar's pin is keyed on session id (`store/pinstate.ts`), the branch pass
 * marks a row stale by rewriting its title in place rather than moving the
 * pin, and the branch that carried on is often a fresh copy with an id the
 * pinned list has never seen. Named here so the summary can say so even when
 * nothing gets written — see `PinFixesReport`.
 */
export interface PinFix {
  /** The pinned id the branch pass just marked stale. */
  staleSessionId: string;
  /** What that row was called before the mark, so the message can name it. */
  staleTitle: string;
  /** The branch that carried on — the row to pin instead. */
  cleanTitle: string;
  /**
   * Its id in this account, when this pass could resolve one — see
   * `ForkOutcome.tipCard`. Absent only for the rare row this pass cannot name,
   * in which case there is something to say but nothing yet to move the pin
   * onto.
   */
  cleanSessionId?: string;
}

/**
 * What the branch pass found in the pin list, and what it could do about it.
 *
 * Reading is attempted whatever the app is doing — one LevelDB read, the same
 * one `foster pin` makes to list what is pinned. Writing is not: the database
 * is the app's own and is locked while it runs, so `moved` is only ever true
 * once that write actually lands.
 */
export interface PinFixesReport {
  fixes: PinFix[];
  /** True once `writePinState` has actually repointed every movable fix. */
  moved: boolean;
  /**
   * Why a move that had something to do did not happen: the app is running, or
   * the write itself failed. Absent when there was nothing to move, or the
   * move succeeded — this is a message, never a reason the sweep failed.
   */
  blocked?: string;
}

/**
 * What no sweep can bring, counted by the reason it cannot.
 *
 * Reported rather than left as a silent gap: without it, a run that brought 141
 * of 154 sessions reads as having brought everything, and the 13 only surface if
 * somebody thinks to ask `list --all --json`.
 */
/** One session the sweep leaves behind, named so the gap is not silent. */
export interface NeverComeSession {
  title: string | undefined;
  /** The one reason counted for it, chosen the way `byReason` chooses. */
  reason: Unfosterable;
}

export interface NeverComes {
  /** Sessions blocked by at least one of the reasons below. */
  total: number;
  byReason: Partial<Record<Unfosterable, number>>;
  /**
   * The same sessions, named.
   *
   * A count on its own is a silent gap. A sweep that ended "Nothing is left to
   * sweep" and, one line down, "10 sessions this sweep does not bring (8
   * scheduled task, 2 never opened)" was both true and unusable: the two that
   * had no way in were never named anywhere, and one of them was a session its
   * owner had asked by name not to lose. It surfaced only because someone
   * compared a screenshot of the sidebar against the store by hand.
   *
   * Carried for every blocked session, in discovery order. Which of them the
   * line prints is the renderer's call: scheduled tasks have `--include-scheduled`
   * said right there, so naming those adds length without adding an answer.
   */
  sessions: NeverComeSession[];
}

/**
 * The re-plan, so the result says the sweep is finished rather than leaving the
 * user to re-run it and find out.
 *
 * Every number is what a second run *would write*, not what a second scan would
 * list: an origin session stays on disk after being fostered and keeps showing up
 * in the scan, and a conversation the user deleted in the app is offered by
 * `restore` for ever while the engine rightly refuses to resurrect it. Counting
 * the plan instead of the listing is the only form of "0" that means finished.
 */
export interface SweepConfirmation {
  fosterable: number;
  /** Rows a second branch pass would still add or mark. */
  branches: number;
  restorable: number;
  /** Copies a second worktree-claim pass would still find. */
  worktreeClaims: number;
  /**
   * Copies a second title pass would still bring into step. Counted only on a
   * run that asked for the pass: a sweep that was never told to sync titles is
   * not unfinished for having left them alone.
   */
  titlesOutOfStep?: number;
  exhausted: boolean;
}

export interface SweepReport {
  store: string;
  target: AccountRef;
  dryRun: boolean;
  fostered: SweepPhase;
  branches: BranchesPhase;
  restored: SweepPhase;
  /** The worktree-claim pass — see `WorktreeClaimsPhase`. */
  worktreeClaims: WorktreeClaimsPhase;
  /** The title pass, only on a run that asked for it — see `TitleSyncPhase`. */
  titleSync?: TitleSyncPhase;
  /**
   * Rows that end up in the destination's archived view rather than in Recents:
   * copies of archived sessions, and the branches that stopped.
   */
  archived: number;
  /**
   * Conversations a live `claude` process is writing right now.
   *
   * A registry entry is only counted once the pid has been shown to still be the
   * process that wrote it — see `inspectWriter` in store/liveSessions.ts — so a
   * pid Windows handed on to something else is not one of these. What is left
   * over-reports only where nothing can be known: a machine with no process table
   * to read, where every entry stays listed rather than being guessed away.
   */
  liveWriters: string[];
  neverComes: NeverComes;
  /**
   * Pinned rows the branch pass just marked stale, and whether the pin could be
   * moved onto the branch that carried on — see `PinFixesReport`. Always
   * present, empty when nothing pinned was touched: unlike `confirmation`, the
   * read behind this happens whether or not the run writes anything, so a dry
   * run has just as much to say here as a real one.
   */
  pinFixes: PinFixesReport;
  /** Present only on a run that wrote: a dry run has nothing to confirm. */
  confirmation?: SweepConfirmation;
}

/**
 * The reasons a sweep can do nothing about.
 *
 * `archived` is not among them — bringing archived sessions across is the point
 * of the sweep — and neither is `already-a-copy`, which describes something that
 * is already here.
 */
export const NEVER_COMES: readonly Unfosterable[] = [
  'scheduled-task',
  // Before `never-opened`, and the order is what makes the report useful: one
  // session is counted under the first reason that applies, and a spawned one is
  // always also never opened. Counted under the latter it would be reported as a
  // gap with no way out, when `--include-spawned` is exactly the way out.
  'spawned-task',
  'never-opened',
  'too-large',
];

/** What every pass of one run shares, read once. */
interface SweepRun {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  sources: AccountRef[];
  prefix: string;
  staleTemplate: string;
  divergedTemplate: string;
  configDirs: string[];
  env: NodeJS.ProcessEnv;
  live: ReadonlySet<string>;
  kin: Lineage;
  /** The sources' cards, classified by the ledger. Never written to, so read once. */
  fromSources: DiscoveredSession[];
}

interface Passes {
  fostered: Outcome[];
  branches: BranchesResult;
  restored: Outcome[];
}

export function runSweep(options: SweepOptions): SweepReport {
  const { store, ledger, dryRun = false } = options;
  const env = options.env ?? process.env;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const staleTemplate = options.staleTemplate ?? DEFAULT_STALE_TEMPLATE;
  const divergedTemplate = options.divergedTemplate ?? DEFAULT_DIVERGED_TEMPLATE;
  const configDirs = options.configDirs ?? [];
  const syncTitles = options.syncTitles ?? false;
  const accounts = listAccountDirs(store);
  const target = options.target ?? requireCurrentAccount(store, accounts);
  const live = options.live ?? liveConversationIds(env);

  // Every directory except the one the copies are going to. Another organization
  // of the same account is just as invisible to the sidebar as another account's,
  // so only the exact destination directory is left out.
  const sources = accounts.filter(
    (ref) =>
      !(ref.accountUuid === target.accountUuid && ref.organizationUuid === target.organizationUuid),
  );

  const kin = options.projectsDirs ? lineageAt(options.projectsDirs) : lineage(env, configDirs);
  const scanned = scanStore(store, copySessionIds(ledger.read()));
  const run: SweepRun = {
    store,
    ledger,
    target,
    sources,
    prefix,
    staleTemplate,
    divergedTemplate,
    configDirs,
    env,
    live,
    kin,
    fromSources: fromAccounts(scanned, sources),
  };

  // Counted before anything is written, from the unfiltered scan: the same set of
  // files, judged by the same rules that decide what the sweep may offer.
  const neverComes = countNeverComes(run.fromSources);

  const passes = runPasses(run, fromAccounts(scanned, [target]), dryRun);

  // Right after the branch pass, so the pin list is asked about the same
  // stale-marks and the same fresh copy this run just decided on — a later
  // read would have to guess which of them were this run's doing.
  const pinFixes = runPinPass(
    store,
    ledger,
    passes.branches,
    dryRun,
    env,
    options.list ?? readProcesses,
  );

  // Last, and reading the ledger fresh: the three passes above may just have
  // appended fosterings of their own, and this plans against whatever the
  // ledger now says rather than the reading taken before any of them ran.
  const worktreeClaims = runWorktreeClaims(store, ledger, dryRun);

  // After the worktree pass, and reading the ledger fresh again: the branch pass
  // may have marked a card this one now has to preserve the mark of.
  const titleSync = syncTitles
    ? runTitleSync(store, ledger, target, dryRun, [staleTemplate, divergedTemplate])
    : undefined;

  const report: SweepReport = {
    store: store.root,
    target,
    dryRun,
    fostered: phase(passes.fostered),
    branches: {
      ...passes.branches,
      counts: summariseOutcomes(passes.branches.outcomes),
      staleTemplate,
      divergedTemplate,
    },
    restored: phase(passes.restored),
    worktreeClaims,
    ...(titleSync ? { titleSync } : {}),
    archived: countArchived(run.fromSources, passes.fostered) + passes.branches.archived,
    liveWriters: [...passes.fostered, ...passes.branches.outcomes, ...passes.restored]
      .map((outcome) => outcome.live)
      .filter((id): id is string => Boolean(id)),
    neverComes,
    pinFixes,
  };

  // Nothing was written, so nothing has changed and a second pass would report
  // exactly what the first one just did. Saying "finished" off that would be a
  // claim about a run that never happened.
  if (dryRun) return report;

  return { ...report, confirmation: confirm(run, syncTitles) };
}

/**
 * The three passes over one reading of the destination.
 *
 * Fork members are split off before the first pass. Fostering one there would
 * give whichever branch the scan listed first a row with a clean title — and
 * the scan lists by card recency, which the app inflates on the row that was
 * merely clicked — so the branch pass would then have to rewrite a file the
 * first pass just wrote. Split first, every row is written once, with the title
 * it keeps.
 */
function runPasses(run: SweepRun, hereCards: DiscoveredSession[], dryRun: boolean): Passes {
  const { store, ledger, target, sources, prefix, configDirs, env, live, kin } = run;
  const { staleTemplate, divergedTemplate } = run;
  const here = sidebarFrom(hereCards, kin);

  const candidates = fosterableFrom(run.fromSources, sources, { includeArchived: true });
  const orphans = findRestorable(store, env, configDirs, [], {
    cards: [...run.fromSources, ...hereCards],
    transcripts: kin.transcripts(),
  }).map((entry) => entry.session);

  const forks = forksOf(
    [...hereCards, ...candidates, ...orphans]
      .map((session) => session.data.cliSessionId)
      .filter((id): id is string => Boolean(id)),
    kin,
  );
  const inFork = (session: DiscoveredSession): boolean =>
    forks.of(session.data.cliSessionId) !== undefined;

  const shared = { store, ledger, target, dryRun, live, env, kin, here, includeArchived: true };

  /**
   * A card that opens records no row here can reach.
   *
   * The split below sends forked conversations to the branch pass, which asks
   * `here.shows` — a question about the id. That is the wrong question when one
   * `cliSessionId` names more than one file: the account holds a row, so the
   * branch pass keeps it and retitles it, while the file holding the rest of the
   * work is never brought. Measured here: of the four conversations on this
   * store whose fuller file another account could open, three were forks, and
   * the sweep passed all three over while `foster foster` brought them.
   *
   * Sent to the ordinary pass instead, which weighs exactly this and refuses
   * when there is nothing beyond. It cannot double up: the branch pass only
   * brings a card when the account shows no row for that branch at all.
   */
  const opensMore = (session: DiscoveredSession): boolean =>
    here.unreached(session.data.cliSessionId, copyCwd(session.data)) > 0;

  const fostered = fosterSessions(
    candidates.filter((session) => !inFork(session) || opensMore(session)),
    { ...shared, prefix },
  );

  const ledgerEvents = ledger.read();
  const plans = planBranchCards({
    forks,
    here,
    hereCards,
    candidates: candidates.filter(inFork),
    orphans: orphans.filter(inFork),
    prefix,
    staleTemplate,
    divergedTemplate,
    live,
    state: project(ledgerEvents),
    events: ledgerEvents,
  });
  const branches = applyBranchCards(plans, { ...shared, prefix });

  // After the copies, deliberately. A conversation one of them now points at has
  // stopped being orphaned, and offering to restore it would only add a second
  // card for work that is already back.
  const restored = fosterSessions(
    orphans.filter((session) => !inFork(session)),
    { ...shared, prefix },
  );

  return { fostered, branches, restored };
}

/**
 * What a second run would still write.
 *
 * Planned rather than listed, and planned as a dry run so the check itself
 * cannot record anything: the question is whether the sweep has anything left to
 * do, not whether the scan still finds the files it already copied.
 *
 * Only the destination is read again. The sources were never written to, and
 * the transcripts are what they were; what changed is the one directory the
 * sweep wrote into.
 */
function confirm(run: SweepRun, syncTitles: boolean): SweepConfirmation {
  const { store, ledger, target } = run;
  const hereCards = scanAccount(store, target, copySessionIds(ledger.read()));
  const again = runPasses(run, hereCards, true);

  const fosterable = summariseOutcomes(again.fostered).fostered;
  const branches =
    summariseOutcomes(again.branches.outcomes).fostered +
    again.branches.retitled.filter((outcome) => outcome.status === 'retitled').length;
  const restorable = summariseOutcomes(again.restored).fostered;
  const worktreeClaims = planUnclaim(store, project(ledger.read())).items.length;
  const titlesOutOfStep = syncTitles
    ? planTitleSync(store, ledger, target).items.length
    : undefined;

  return {
    fosterable,
    branches,
    restorable,
    worktreeClaims,
    ...(titlesOutOfStep === undefined ? {} : { titlesOutOfStep }),
    exhausted:
      fosterable === 0 &&
      branches === 0 &&
      restorable === 0 &&
      worktreeClaims === 0 &&
      (titlesOutOfStep ?? 0) === 0,
  };
}

function phase(outcomes: Outcome[]): SweepPhase {
  return { outcomes, counts: summariseOutcomes(outcomes) };
}

/**
 * The pin pass: say which pinned rows the branch pass just marked stale, and
 * move the pin onto the branch that carried on when the store allows it — see
 * issue #23.
 *
 * Reading the pin list is one LevelDB read, the same one `foster pin` makes to
 * list what is pinned, and it is attempted on every sweep, dry run included.
 *
 * It usually fails. Measured with Claude Desktop open — the ordinary state
 * during a sweep, and the reason `--restart` exists — the read comes back
 * `MANIFEST-000001 names the log 000000.log, which is not there`: the app holds
 * its own database and does not share it. That is caught and read as "nothing
 * pinned", so the pass stays silent rather than wrong and the sweep never fails
 * for it. The practical consequence is that the naming half mostly runs once
 * the app has been closed, alongside the moving half. Reading a copy of a live
 * database instead would trade a clear refusal for a snapshot torn mid-write,
 * so that is left for a follow-up rather than guessed at here.
 *
 * Writing is not safe with the app open either, and is skipped rather than
 * failing the run: a pin that could not be moved is a line in the summary,
 * never a reason the sweep errors out.
 */
function runPinPass(
  store: StoreLayout,
  ledger: Ledger,
  branches: BranchesResult,
  dryRun: boolean,
  env: NodeJS.ProcessEnv,
  list: ProcessLister,
): PinFixesReport {
  const pins = readPinsQuietly(store);
  if (!pins) return { fixes: [], moved: false };

  const fixes = planPinFixes(branches, pins);
  // Nothing to move yet on a dry run: the branch pass wrote nothing, so a copy
  // this pass would bring the tip in as does not exist for the pin to point at.
  if (fixes.length === 0 || dryRun) return { fixes, moved: false };

  return { fixes, ...applyPinFixes(store, ledger, pins, fixes, env, list) };
}

/**
 * The database this asks about may not exist at all — a store the app has
 * never opened, which is every fixture store this test suite builds, and
 * plenty of real installations too. `readPinState` throws for that case (there
 * is nothing to read or write) and for a database it cannot make sense of;
 * either way the sweep has nothing to say about pins, not a reason to fail.
 */
function readPinsQuietly(store: StoreLayout): PinState | undefined {
  try {
    return readPinState(store);
  } catch {
    return undefined;
  }
}

/**
 * Which pinned rows the branch pass marked stale this run, and what to pin
 * instead. Only rows this very pass retitled to stale — a row already wearing
 * an older sweep's mark is a gap `foster pin` closes by hand today, not one
 * this pass claims to have just caused.
 */
function planPinFixes(branches: BranchesResult, pins: PinState): PinFix[] {
  const fixes: PinFix[] = [];
  for (const fork of branches.forks) {
    // Nothing resolvable to recommend or move to. Rare: it means the tip
    // arrived earlier through the ordinary pass rather than this one (see
    // `ForkOutcome.tipCard`), and this pass has no record of that copy's id.
    if (!fork.tipCard) continue;
    for (const outcome of fork.retitled) {
      if (outcome.status !== 'retitled' || outcome.as !== 'stale') continue;
      if (!pins.ids.includes(outcome.sessionId)) continue;
      fixes.push({
        staleSessionId: outcome.sessionId,
        // The row's own title before the mark went on, not the fork's shared
        // title — a branch can have been renamed independently of its sibling.
        staleTitle: outcome.from || outcome.to,
        cleanTitle: fork.tipCard.title,
        cleanSessionId: fork.tipCard.sessionId,
      });
    }
  }
  return fixes;
}

/**
 * Move every fix in one write, the same append `writePinState` always makes.
 * Guarded exactly the way `foster pin` guards its own write: the database is
 * the app's own and holds unflushed writes in memory while it runs, so a
 * write here would just be overwritten the moment the app flushes.
 */
function applyPinFixes(
  store: StoreLayout,
  ledger: Ledger,
  pins: PinState,
  fixes: PinFix[],
  env: NodeJS.ProcessEnv,
  list: ProcessLister,
): { moved: boolean; blocked?: string } {
  const app = inspectApp(store, env, list);
  if (app.running) {
    return {
      moved: false,
      blocked:
        `Claude Desktop is running (${app.evidence.join('; ')}), so the pin could not be moved yet. ` +
        'Its IndexedDB is locked while the app holds it open — re-run the sweep once it is closed, or ' +
        'move it by hand with "foster pin".',
    };
  }

  let next = pins.ids;
  for (const fix of fixes) {
    if (!fix.cleanSessionId) continue;
    next = next.filter((id) => id !== fix.staleSessionId);
    if (!next.includes(fix.cleanSessionId)) next = [...next, fix.cleanSessionId];
  }
  // Every movable fix turned out to be a no-op — the stale id was not actually
  // pinned any more, or the clean id already was. Nothing written, same as any
  // other pass that finds it has nothing to do.
  if (next === pins.ids) return { moved: false };

  try {
    backupPinState(
      store,
      path.join(path.dirname(ledger.path), 'backups', `pin-state-${Date.now()}`),
    );
    writePinState(pins, next);
    return { moved: true };
  } catch (error) {
    return { moved: false, blocked: `The pin list could not be updated: ${errorMessage(error)}.` };
  }
}

/**
 * The worktree-claim pass, dry or not.
 *
 * The plan alone is what a dry run reports; `--yes` applies it against the
 * store the rest of the sweep just wrote into. Idempotent by construction —
 * `planUnclaim` reads the file on disk, and a released copy no longer carries
 * a claim for the next plan to find.
 */
function runWorktreeClaims(
  store: StoreLayout,
  ledger: Ledger,
  dryRun: boolean,
): WorktreeClaimsPhase {
  const plan = planUnclaim(store, project(ledger.read()));
  const outcomes = dryRun ? [] : applyUnclaim(plan.items, { ledger });
  return { items: plan.items, outcomes, counts: countUnclaim(outcomes) };
}

function runTitleSync(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
  dryRun: boolean,
  runTemplates: readonly string[],
): TitleSyncPhase {
  const plan = planTitleSync(store, ledger, target, undefined, runTemplates);
  const outcomes = dryRun ? [] : applyTitleSync(plan.items, { ledger });
  const counts = { synced: 0, skipped: 0, failed: 0 };
  for (const outcome of outcomes) {
    if (outcome.status === 'retitled') counts.synced += 1;
    else counts[outcome.status] += 1;
  }
  return { items: plan.items, skipped: plan.skipped, outcomes, counts };
}

function countUnclaim(outcomes: UnclaimOutcome[]): {
  released: number;
  skipped: number;
  failed: number;
} {
  const counts = { released: 0, skipped: 0, failed: 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}

function countNeverComes(sessions: DiscoveredSession[]): NeverComes {
  const byReason: Partial<Record<Unfosterable, number>> = {};
  const named: NeverComeSession[] = [];
  let total = 0;

  for (const session of sessions) {
    // Judged the way the sweep judges it: archived is accepted, so a session
    // whose only mark is `archived` is not a gap.
    const blocking = blockingReasons(session, { includeArchived: true });
    const hopeless = NEVER_COMES.filter((reason) => blocking.includes(reason));
    if (hopeless.length === 0) continue;
    total += 1;
    // One session, one reason — the first that applies, in the order NEVER_COMES
    // lists them. Counting every reason it carried made the parts contradict the
    // whole: eight sessions, six of them scheduled tasks that had also never been
    // opened, printed as "8 sessions (8 scheduled task, 6 never opened)". A
    // breakdown that does not add up to its own total reads as a miscount, and
    // the second reason changes nothing about what to do with the session.
    byReason[hopeless[0]!] = (byReason[hopeless[0]!] ?? 0) + 1;
    // Named under the same reason the count used, so the list and the breakdown
    // can never tell different stories about the same session.
    named.push({ title: session.data.title, reason: hopeless[0]! });
  }

  return { total, byReason, sessions: named };
}

/**
 * How many of the copies arrive in the archived view.
 *
 * Worth its own number: they are the bulk of what a sweep brings and they are
 * exactly the rows nobody finds, because Recents does not list them.
 */
function countArchived(sources: DiscoveredSession[], outcomes: Outcome[]): number {
  const archived = new Set(sources.filter((s) => s.data.isArchived).map((s) => s.data.sessionId));
  return outcomes.filter(
    (outcome) => outcome.status === 'fostered' && archived.has(outcome.originSessionId),
  ).length;
}

/** Rows the branch pass marked stale, for callers that count rather than list. */
export function countRetitled(outcomes: RetitleOutcome[]): number {
  return outcomes.filter((outcome) => outcome.status === 'retitled').length;
}

export type { ForkOutcome };

/**
 * Whether foster may restart the app from where it is standing, and the line to
 * hand over when it may not.
 *
 * A Claude Code session opened from Claude Desktop's sidebar is a child process
 * of the app, so restarting it kills the caller part-way through — the same
 * ancestry question `isSelfHostedBy` answers about a live CLI session, asked here
 * about the app. `quitDesktop` already refuses on it; asking first is what lets a
 * sweep finish with a usable instruction instead of a refusal at the very end.
 */
export interface RestartPlan {
  possible: boolean;
  running: boolean;
  /** Why foster will not do it, when it will not. */
  reason?: string;
  /** The line to run in a terminal outside the app. */
  command: string;
}

export const RESTART_COMMAND = 'foster app restart';

export function restartPlan(
  store: StoreLayout,
  env: NodeJS.ProcessEnv = process.env,
  list: ProcessLister | undefined = readProcesses,
): RestartPlan {
  const state = inspectDesktopFor(storeIdentity(store.root, env), list ?? readProcesses, env);
  // An uncertain state means the process table could not tell the app from a
  // Code session at all (tasklist, no paths or command lines) — restarting on
  // that evidence risks starting a second instance on top of one that may
  // already be running. Same shape as the selfHosted refusal below: hand over
  // the command instead of a plan that could try and throw.
  if (state.uncertain) {
    return {
      possible: false,
      running: state.running,
      reason: state.uncertain,
      command: RESTART_COMMAND,
    };
  }
  if (!state.selfHosted) {
    return { possible: true, running: state.running, command: RESTART_COMMAND };
  }
  return {
    possible: false,
    running: state.running,
    reason:
      'foster is running inside Claude Desktop, so restarting it would kill this session part-way through.',
    command: RESTART_COMMAND,
  };
}
