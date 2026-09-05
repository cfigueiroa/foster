import { DEFAULT_PREFIX } from '../domain/fostering.js';
import { blockingReasons } from '../domain/filter.js';
import { listAccountDirs, storeIdentity } from '../domain/paths.js';
import { DEFAULT_STALE_TEMPLATE } from '../domain/stale.js';
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
import { sidebarFrom } from '../engine/sidebar.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, project } from '../ledger/project.js';
import { findRestorable } from '../store/restore.js';
import { fromAccounts, scanAccount, scanStore } from '../store/scanner.js';
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
 *  3. bring back conversations the app deleted that nothing still points at.
 *
 * Order matters. A conversation a fresh copy now points at is not lost any more,
 * so restoring after fostering asks the third question against the answer to
 * the first rather than against the state before it; and a fork's members are
 * kept out of the first pass so each row is written once, with its final title.
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
}

export interface SweepPhase {
  outcomes: Outcome[];
  counts: Record<OutcomeStatus, number>;
}

/** The branch pass: what it brought, what it marked, per fork. */
export interface BranchesPhase extends BranchesResult {
  counts: Record<OutcomeStatus, number>;
  /** The template the stale rows were marked with, for the summary to quote. */
  staleTemplate: string;
}

/**
 * What no sweep can bring, counted by the reason it cannot.
 *
 * Reported rather than left as a silent gap: without it, a run that brought 141
 * of 154 sessions reads as having brought everything, and the 13 only surface if
 * somebody thinks to ask `list --all --json`.
 */
export interface NeverComes {
  /** Sessions blocked by at least one of the reasons below. */
  total: number;
  byReason: Partial<Record<Unfosterable, number>>;
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
  exhausted: boolean;
}

export interface SweepReport {
  store: string;
  target: AccountRef;
  dryRun: boolean;
  fostered: SweepPhase;
  branches: BranchesPhase;
  restored: SweepPhase;
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
export const NEVER_COMES: readonly Unfosterable[] = ['scheduled-task', 'never-opened', 'too-large'];

/** What every pass of one run shares, read once. */
interface SweepRun {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  sources: AccountRef[];
  prefix: string;
  staleTemplate: string;
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
  const configDirs = options.configDirs ?? [];
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

  const report: SweepReport = {
    store: store.root,
    target,
    dryRun,
    fostered: phase(passes.fostered),
    branches: {
      ...passes.branches,
      counts: summariseOutcomes(passes.branches.outcomes),
      staleTemplate,
    },
    restored: phase(passes.restored),
    archived: countArchived(run.fromSources, passes.fostered) + passes.branches.archived,
    liveWriters: [...passes.fostered, ...passes.branches.outcomes, ...passes.restored]
      .map((outcome) => outcome.live)
      .filter((id): id is string => Boolean(id)),
    neverComes,
  };

  // Nothing was written, so nothing has changed and a second pass would report
  // exactly what the first one just did. Saying "finished" off that would be a
  // claim about a run that never happened.
  if (dryRun) return report;

  return { ...report, confirmation: confirm(run) };
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
  const { store, ledger, target, sources, prefix, staleTemplate, configDirs, env, live, kin } = run;
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

  const fostered = fosterSessions(
    candidates.filter((session) => !inFork(session)),
    { ...shared, prefix },
  );

  const plans = planBranchCards({
    forks,
    here,
    hereCards,
    candidates: candidates.filter(inFork),
    orphans: orphans.filter(inFork),
    prefix,
    staleTemplate,
    live,
    state: project(ledger.read()),
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
function confirm(run: SweepRun): SweepConfirmation {
  const { store, ledger, target } = run;
  const hereCards = scanAccount(store, target, copySessionIds(ledger.read()));
  const again = runPasses(run, hereCards, true);

  const fosterable = summariseOutcomes(again.fostered).fostered;
  const branches =
    summariseOutcomes(again.branches.outcomes).fostered +
    again.branches.retitled.filter((outcome) => outcome.status === 'retitled').length;
  const restorable = summariseOutcomes(again.restored).fostered;

  return {
    fosterable,
    branches,
    restorable,
    exhausted: fosterable === 0 && branches === 0 && restorable === 0,
  };
}

function phase(outcomes: Outcome[]): SweepPhase {
  return { outcomes, counts: summariseOutcomes(outcomes) };
}

function countNeverComes(sessions: DiscoveredSession[]): NeverComes {
  const byReason: Partial<Record<Unfosterable, number>> = {};
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
  }

  return { total, byReason };
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
