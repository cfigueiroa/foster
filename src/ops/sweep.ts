import { DEFAULT_PREFIX } from '../domain/fostering.js';
import { blockingReasons } from '../domain/filter.js';
import { listAccountDirs, storeIdentity } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout, Unfosterable } from '../domain/types.js';
import { requireCurrentAccount } from '../engine/account.js';
import { inspectDesktopFor, readProcesses, type ProcessLister } from '../engine/desktop.js';
import {
  fosterSessions,
  summariseOutcomes,
  type Outcome,
  type OutcomeStatus,
} from '../engine/executor.js';
import type { Ledger } from '../ledger/log.js';
import { findRestorable } from '../store/restore.js';
import { listFosterable, liveConversationIds, scanFosterable } from './foster.js';

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
 * Two operations, in this order, then a re-scan that proves they are exhausted:
 *
 *  1. copy every fosterable session from the other accounts, archived included —
 *     the copy keeps the flag, so it lands in the destination's archived view
 *     rather than quietly reappearing in Recents;
 *  2. bring back conversations the app deleted that nothing still points at.
 *
 * Order matters: a conversation a fresh copy now points at is not lost any more,
 * so restoring after fostering asks the second question against the answer to
 * the first rather than against the state before it.
 *
 * What is deliberately *not* here: `purge`, which destroys transcripts and is
 * part of no sweep, and `consolidate`, which decides which half of a fork
 * survives — a reading decision that hides records, and the user's to make. A
 * fork is counted and reported, and the sweep stops there.
 */

export interface SweepOptions {
  store: StoreLayout;
  ledger: Ledger;
  /** Where the copies go. Defaults to the account the app is signed into. */
  target?: AccountRef;
  prefix?: string;
  /** When true, plan everything and write nothing. */
  dryRun?: boolean;
  /** Extra Claude config directories to search for deleted conversations. */
  configDirs?: string[];
  env?: NodeJS.ProcessEnv;
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
 * The re-scan, so the result says the sweep is finished rather than leaving the
 * user to re-run it and find out.
 *
 * Both numbers are what a second run *would write*, not what a second scan would
 * list: an origin session stays on disk after being fostered and keeps showing up
 * in the scan, and a conversation the user deleted in the app is offered by
 * `restore` for ever while the engine rightly refuses to resurrect it. Counting
 * the plan instead of the listing is the only form of "0" that means finished.
 */
export interface SweepConfirmation {
  fosterable: number;
  restorable: number;
  exhausted: boolean;
}

export interface SweepReport {
  store: string;
  target: AccountRef;
  dryRun: boolean;
  fostered: SweepPhase;
  restored: SweepPhase;
  /** Copies that arrive in the destination's archived view rather than in Recents. */
  archived: number;
  /**
   * Sessions the destination refused because it already shows the half of a fork
   * that carried on. Reported with no command attached — see the module note.
   */
  forks: number;
  /**
   * What those forks would cost, summed: records the halves this account does not
   * show hold alone, and records its own halves hold alone.
   *
   * The count on its own does not say whether the reader is looking at a rounding
   * error or at half their work. One store had a fork worth 7 records against
   * 2625 and another worth 2352 against 3609; "1 session is the half of a fork"
   * described both, and only one of them was worth stopping for.
   */
  forkGap: { theirOnly: number; hereOnly: number };
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

export function runSweep(options: SweepOptions): SweepReport {
  const { store, ledger, dryRun = false } = options;
  const env = options.env ?? process.env;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
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

  // Counted before anything is written, from the unfiltered scan: the same set of
  // files, judged by the same rules that decide what the sweep may offer.
  const neverComes = countNeverComes(scanFosterable(store, sources, ledger));

  const candidates = fosterable(store, ledger, sources);
  const fosterOutcomes = fosterSessions(candidates, {
    store,
    ledger,
    target,
    prefix,
    dryRun,
    includeArchived: true,
    live,
    env,
  });

  // After the copies, deliberately. A conversation one of them now points at has
  // stopped being orphaned, and offering to restore it would only add a second
  // card for work that is already back.
  const restoreOutcomes = fosterSessions(restorable(store, env, configDirs), {
    store,
    ledger,
    target,
    prefix,
    dryRun,
    env,
  });

  const report: SweepReport = {
    store: store.root,
    target,
    dryRun,
    fostered: phase(fosterOutcomes),
    restored: phase(restoreOutcomes),
    archived: countArchived(candidates, fosterOutcomes),
    forks: fosterOutcomes.filter((outcome) => outcome.standing?.ahead).length,
    forkGap: fosterOutcomes.reduce(
      (gap, outcome) =>
        outcome.standing?.ahead
          ? {
              theirOnly: gap.theirOnly + outcome.standing.theirOnly,
              hereOnly: gap.hereOnly + outcome.standing.hereOnly,
            }
          : gap,
      { theirOnly: 0, hereOnly: 0 },
    ),
    liveWriters: [...fosterOutcomes, ...restoreOutcomes]
      .map((outcome) => outcome.live)
      .filter((id): id is string => Boolean(id)),
    neverComes,
  };

  // Nothing was written, so nothing has changed and a second pass would report
  // exactly what the first one just did. Saying "finished" off that would be a
  // claim about a run that never happened.
  if (dryRun) return report;

  return { ...report, confirmation: confirm(options, target, sources, prefix, live) };
}

function fosterable(
  store: StoreLayout,
  ledger: Ledger,
  sources: AccountRef[],
): DiscoveredSession[] {
  return listFosterable(store, sources, ledger, { includeArchived: true });
}

function restorable(
  store: StoreLayout,
  env: NodeJS.ProcessEnv,
  configDirs: string[],
): DiscoveredSession[] {
  return findRestorable(store, env, configDirs).map((entry) => entry.session);
}

/**
 * What a second run would still write.
 *
 * Planned rather than listed, and planned as a dry run so the check itself
 * cannot record anything: the question is whether the sweep has anything left to
 * do, not whether the scan still finds the files it already copied.
 */
function confirm(
  options: SweepOptions,
  target: AccountRef,
  sources: AccountRef[],
  prefix: string,
  live: ReadonlySet<string>,
): SweepConfirmation {
  const { store, ledger } = options;
  const env = options.env ?? process.env;
  const plan = (sessions: DiscoveredSession[], includeArchived: boolean): number =>
    summariseOutcomes(
      fosterSessions(sessions, {
        store,
        ledger,
        target,
        prefix,
        dryRun: true,
        includeArchived,
        live,
        env,
      }),
    ).fostered;

  const stillFosterable = plan(fosterable(store, ledger, sources), true);
  const stillRestorable = plan(restorable(store, env, options.configDirs ?? []), false);

  return {
    fosterable: stillFosterable,
    restorable: stillRestorable,
    exhausted: stillFosterable === 0 && stillRestorable === 0,
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
function countArchived(candidates: DiscoveredSession[], outcomes: Outcome[]): number {
  const archived = new Set(
    candidates.filter((s) => s.data.isArchived).map((s) => s.data.sessionId),
  );
  return outcomes.filter(
    (outcome) => outcome.status === 'fostered' && archived.has(outcome.originSessionId),
  ).length;
}

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
