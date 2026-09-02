import { bareSessionId } from '../domain/naming.js';
import { listAccountDirs, storeRootOfCopy } from '../domain/paths.js';
import type { DiscoveredSession, StoreLayout } from '../domain/types.js';
import { currentAccount, requireCurrentAccount } from '../engine/account.js';
import { inspectDesktopFor, type ProcessLister } from '../engine/desktop.js';
import { findDuplicates } from '../engine/duplicates.js';
import {
  fosterSessions,
  returnFosterings,
  summariseOutcomes,
  type Outcome,
} from '../engine/executor.js';
import { resumeConversation, type ResumeRunner } from '../engine/resume.js';
import { AppRunningError, inspectApp, type RemovalGuard } from '../engine/safety.js';
import { storeIdentity } from '../domain/paths.js';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import type { SessionFilter } from '../domain/filter.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import { readConfig } from '../store/config.js';
import { summarise } from '../store/scanner.js';
import { viewTranscript } from '../store/transcripts.js';
import {
  listFosterable,
  liveConversationIds,
  matchAccountPrefix,
  selectFosterSessions,
} from '../ops/foster.js';
import { inThisStore, selectReturnTargets } from '../ops/active.js';
import { restartPlan, runSweep } from '../ops/sweep.js';
import { applyLabel } from '../ops/label.js';

/**
 * The operations `foster agent` hands to the model, as plain functions.
 *
 * Everything here is the same engine the CLI drives, behind the same gates: a
 * mutation is a dry run unless the *user* started the agent with --yes AND the
 * model asked for `apply` — the model alone can never enable writing. The
 * handlers know nothing about MCP; the server wraps them, and the tests call
 * them directly against a synthetic store.
 */

export interface AgentToolContext {
  store: StoreLayout;
  ledger: Ledger;
  /** True only when the user started `foster agent` with --yes. */
  allowWrites: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; production always gets the real removal gate. */
  removalGuard?: RemovalGuard;
  /** Injectable for tests; production runs the real `claude -p --resume`. */
  resumeRunner?: ResumeRunner;
  /**
   * Injectable for tests; production reads the real process table. Only the
   * sweep asks, and only to work out whether foster may restart the app itself.
   */
  processes?: ProcessLister;
}

export type { ResumeRunner } from '../engine/resume.js';

/** What a refused mutation tells the model, so it can tell the user. */
export const WRITES_DISABLED =
  'Writes are disabled: foster agent was started without --yes, so this was a dry run. ' +
  'Ask the user to re-run `foster agent` with --yes if they want it applied.';

const RESTART_NOTE =
  'The sidebar is built at startup: changes appear only after Claude Desktop is restarted ' +
  '(the user can run `foster app restart`).';

function envOf(ctx: AgentToolContext): NodeJS.ProcessEnv {
  return ctx.env ?? process.env;
}

/* ------------------------------------------------------------------ *
 * Read-only tools
 * ------------------------------------------------------------------ */

export function scanAccounts(ctx: AgentToolContext): unknown {
  const { store, ledger } = ctx;
  const config = readConfig(store);
  const labels = project(ledger.read()).labels;
  const rows = summarise(store, config.lastKnownAccountUuid, copySessionIds(ledger.read()));

  return {
    store: store.root,
    accounts: rows.map((row) => ({
      accountUuid: row.account.accountUuid,
      organizationUuid: row.account.organizationUuid,
      label: labels.get(row.account.accountUuid) ?? null,
      isCurrent: row.isCurrent,
      sessions: row.nativeCount,
      fostered: row.copyCount,
    })),
  };
}

export interface ListSessionsArgs {
  /** Unique prefix of the account to list; without it, every account except the current one. */
  accountUuid?: string;
  title?: string;
  cwd?: string;
  sinceDays?: number;
  includeUnfosterable?: boolean;
  limit?: number;
}

export function listSessions(ctx: AgentToolContext, args: ListSessionsArgs): unknown {
  const { store, ledger } = ctx;
  const accounts = listAccountDirs(store);
  const current = currentAccount(store, accounts);

  // Without an explicit account this mirrors `foster list`: the current
  // account's sessions are already in the sidebar and are not candidates. Naming
  // an account — any account, the current one included — lists exactly it.
  let sources = accounts;
  if (args.accountUuid) {
    sources = matchAccountPrefix(accounts, args.accountUuid, 'accountUuid');
  } else {
    sources = accounts.filter((ref) => ref.accountUuid !== current?.accountUuid);
  }

  const filter: SessionFilter = { includeUnfosterable: args.includeUnfosterable ?? false };
  if (args.title) filter.title = args.title;
  if (args.cwd) filter.cwd = args.cwd;
  if (args.sinceDays !== undefined) filter.since = Date.now() - args.sinceDays * 86_400_000;

  const all = listFosterable(store, sources, ledger, filter);

  const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
  const shown = all.slice(0, limit);

  return {
    total: all.length,
    shown: shown.length,
    ...(all.length > shown.length
      ? { note: `truncated to ${shown.length} — narrow with title/cwd/sinceDays or raise limit` }
      : {}),
    sessions: shown.map(sessionRow),
  };
}

function sessionRow(session: DiscoveredSession): Record<string, unknown> {
  return {
    sessionId: session.data.sessionId,
    title: session.data.title ?? null,
    cwd: session.data.cwd ?? null,
    lastActivityAt: iso(session.data.lastActivityAt),
    cliSessionId: session.data.cliSessionId ?? null,
    accountUuid: session.account.accountUuid,
    organizationUuid: session.account.organizationUuid,
    fosterable: session.reasons.length === 0,
    ...(session.reasons.length > 0 ? { reasons: session.reasons } : {}),
  };
}

function iso(ms: number | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

export function fosterStatus(ctx: AgentToolContext): unknown {
  const { store, ledger } = ctx;
  const active = listActive(project(ledger.read()));
  const here = active.filter((f) => inThisStore(f, store));
  const duplicates = findDuplicates(store, here);

  return {
    active: active.map((f) => ({
      originSessionId: f.originSessionId,
      copySessionId: f.copySessionId,
      originalTitle: f.originalTitle ?? null,
      cliSessionId: f.cliSessionId ?? null,
      fosteredAt: iso(f.fosteredAt),
      fromAccountUuid: f.origin.accountUuid,
      store: storeRootOfCopy(f.copyPath),
      inThisStore: inThisStore(f, store),
    })),
    duplicateCopies: duplicates.copies.length,
    // Reported apart from the duplicates and with no command attached: a branch
    // is not the same conversation twice but one piece of work that forked, and
    // which half to keep is a reading decision, not a cleanup.
    branchCopies: duplicates.branches.length,
    ...(duplicates.copies.length > 0
      ? { note: 'duplicate copies can be removed with return_fosterings duplicatesOnly' }
      : {}),
  };
}

export function appStatus(ctx: AgentToolContext): unknown {
  const { store } = ctx;
  const app = inspectApp(store);
  const desktop = inspectDesktopFor(storeIdentity(store.root));
  return {
    running: app.running,
    evidence: app.evidence,
    mainPid: desktop.mainPid ?? null,
    startedAt: iso(desktop.startedAt),
    hostedCodeSessions: desktop.codeSessions,
    fosterRunsInsideIt: desktop.selfHosted,
    notes: [
      'Fostering (adding copies) is safe while the app runs; the copies appear after a restart.',
      'Returning (removing copies) refuses while the app may hold them in memory.',
    ],
  };
}

export interface ReadTranscriptArgs {
  cliSessionId: string;
  /** 'head' reads the start of the conversation, 'tail' (default) the most recent part. */
  part?: 'head' | 'tail';
  maxChars?: number;
}

export function readTranscript(ctx: AgentToolContext, args: ReadTranscriptArgs): unknown {
  const view = viewTranscript(
    bareSessionId(args.cliSessionId),
    envOf(ctx),
    args.part ?? 'tail',
    args.maxChars ?? 20_000,
  );

  return {
    cliSessionId: view.cliSessionId,
    path: view.path,
    title: view.title ?? null,
    cwd: view.cwd ?? null,
    createdAt: iso(view.createdAt),
    lastActivityAt: iso(view.lastActivityAt),
    sizeBytes: view.sizeBytes,
    part: view.part,
    truncated: view.truncated,
    format:
      'jsonl — one record per line; partial first/last lines are possible on a truncated read',
    text: view.text,
  };
}

/* ------------------------------------------------------------------ *
 * Mutations — gated exactly like the CLI
 * ------------------------------------------------------------------ */

export interface LabelAccountArgs {
  accountUuid: string;
  label: string;
}

export function labelAccount(ctx: AgentToolContext, args: LabelAccountArgs): unknown {
  // Not gated on --yes deliberately: this writes only to foster's own ledger,
  // never to the app's store — the same reason the CLI's `label` has no --yes.
  const accounts = listAccountDirs(ctx.store);
  const { accountUuid, label } = applyLabel(
    ctx.ledger,
    args.accountUuid,
    args.label,
    accounts.map((ref) => ref.accountUuid),
    readConfig(ctx.store).lastKnownAccountUuid,
  );
  return { labelled: accountUuid, label };
}

export interface FosterSessionsArgs {
  /** Session ids (or unique prefixes) to foster. Without them, filters select the batch. */
  sessionIds?: string[];
  fromAccountUuid?: string;
  title?: string;
  cwd?: string;
  sinceDays?: number;
  prefix?: string;
  /** Actually write. Only honoured when the user started the agent with --yes. */
  apply?: boolean;
}

export function fosterSessionsTool(ctx: AgentToolContext, args: FosterSessionsArgs): unknown {
  const { store, ledger } = ctx;
  const accounts = listAccountDirs(store);
  const target = requireCurrentAccount(store, accounts);

  let sources = accounts.filter(
    (ref) =>
      !(ref.accountUuid === target.accountUuid && ref.organizationUuid === target.organizationUuid),
  );
  if (args.fromAccountUuid) {
    sources = matchAccountPrefix(sources, args.fromAccountUuid, 'fromAccountUuid');
  }

  const filter: SessionFilter = { includeUnfosterable: false };
  if (args.title) filter.title = args.title;
  if (args.cwd) filter.cwd = args.cwd;
  if (args.sinceDays !== undefined) filter.since = Date.now() - args.sinceDays * 86_400_000;

  let candidates = listFosterable(store, sources, ledger, filter);

  if (args.sessionIds?.length) {
    try {
      candidates = selectFosterSessions(candidates, args.sessionIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} — check with list_sessions.`);
    }
  }

  if (candidates.length === 0) return { dryRun: true, counts: {}, note: 'nothing matches' };

  const gated = Boolean(args.apply) && !ctx.allowWrites;
  const dryRun = !args.apply || gated;
  const outcomes = fosterSessions(candidates, {
    store,
    ledger,
    target,
    prefix: args.prefix ?? DEFAULT_PREFIX,
    dryRun,
    explicit: Boolean(args.sessionIds?.length),
    live: liveConversationIds(envOf(ctx)),
  });

  return mutationReport(outcomes, dryRun, gated, RESTART_NOTE);
}

export interface ReturnFosteringsArgs {
  /** Origin session ids (or unique prefixes) to return. Without them, filters select the batch. */
  sessionIds?: string[];
  title?: string;
  /** Only copies duplicating a conversation their account already had. */
  duplicatesOnly?: boolean;
  /** Include copies written into other installations. */
  allStores?: boolean;
  /** Actually remove. Only honoured when the user started the agent with --yes. */
  apply?: boolean;
}

export function returnFosteringsTool(ctx: AgentToolContext, args: ReturnFosteringsArgs): unknown {
  const { store, ledger } = ctx;
  const { selected: active, elsewhere } = selectReturnTargets(store, ledger, {
    allStores: args.allStores,
    duplicates: args.duplicatesOnly,
    title: args.title,
    sessionIds: args.sessionIds,
  });

  if (active.length === 0) {
    return {
      dryRun: true,
      counts: {},
      note: 'nothing is fostered that matches',
      ...(elsewhere > 0 ? { inOtherStores: elsewhere } : {}),
    };
  }

  const gated = Boolean(args.apply) && !ctx.allowWrites;
  const dryRun = !args.apply || gated;

  let outcomes: Outcome[];
  try {
    outcomes = returnFosterings(active, {
      store,
      ledger,
      dryRun,
      ...(ctx.removalGuard ? { guard: ctx.removalGuard } : {}),
    });
  } catch (error) {
    if (error instanceof AppRunningError) {
      // The same refusal the CLI prints, shaped for the model: nothing was
      // removed, and the way forward is the user closing the app.
      return { refused: error.message, removed: 0 };
    }
    throw error;
  }

  return {
    ...mutationReport(outcomes, dryRun, gated, RESTART_NOTE),
    ...(elsewhere > 0 ? { inOtherStores: elsewhere } : {}),
  };
}

function mutationReport(
  outcomes: Outcome[],
  dryRun: boolean,
  gated: boolean,
  appliedNote: string,
): Record<string, unknown> {
  return {
    dryRun,
    ...(gated ? { note: WRITES_DISABLED } : dryRun ? {} : { note: appliedNote }),
    counts: summariseOutcomes(outcomes),
    outcomes: outcomes.map((outcome) => ({
      originSessionId: outcome.originSessionId,
      title: outcome.title,
      status: outcome.status,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * The whole sweep
 * ------------------------------------------------------------------ */

export interface SweepEverythingArgs {
  prefix?: string;
  /** Extra Claude config directories to search for deleted conversations. */
  configDirs?: string[];
  /** Actually write. Only honoured when the user started the agent with --yes. */
  apply?: boolean;
}

/** How many outcome rows a sweep hands back before it stops listing and counts. */
const SWEEP_OUTCOME_LIMIT = 50;

/**
 * "Bring everything here", as one tool.
 *
 * The gap this closes is not convenience. `restore` was never one of the agent's
 * tools, so a task phrased as "bring it all, including the deleted ones" was
 * literally unanswerable — the model could foster and then had to tell the user
 * to run a command itself. And `foster_sessions` sweeps without archived
 * sessions, which on a real store is the difference between 15 and 141.
 */
export function sweepEverything(ctx: AgentToolContext, args: SweepEverythingArgs): unknown {
  const { store, ledger } = ctx;
  const env = envOf(ctx);
  const target = requireCurrentAccount(store, listAccountDirs(store));

  const gated = Boolean(args.apply) && !ctx.allowWrites;
  const dryRun = !args.apply || gated;

  const report = runSweep({
    store,
    ledger,
    target,
    dryRun,
    env,
    ...(args.prefix ? { prefix: args.prefix } : {}),
    ...(args.configDirs ? { configDirs: args.configDirs } : {}),
  });

  const outcomes = [
    ...report.fostered.outcomes,
    ...report.branches.outcomes,
    ...report.restored.outcomes,
  ];
  const restart = restartPlan(store, env, ctx.processes);
  const { branches } = report;
  const retitled = branches.retitled.filter((outcome) => outcome.status === 'retitled').length;

  return {
    dryRun,
    ...(gated ? { note: WRITES_DISABLED } : dryRun ? {} : { note: RESTART_NOTE }),
    target,
    counts: {
      fostered: report.fostered.counts.fostered + branches.counts.fostered,
      restored: report.restored.counts.fostered,
      skipped:
        report.fostered.counts.skipped + branches.counts.skipped + report.restored.counts.skipped,
      failed:
        report.fostered.counts.failed + branches.counts.failed + report.restored.counts.failed,
    },
    archived: report.archived,
    archivedNote:
      'Copies of archived sessions stay archived: they are in the app’s archived view, not in Recents.',
    ...(report.confirmation ? { confirmation: report.confirmation } : {}),
    neverComes: report.neverComes,
    branches: {
      forks: branches.forks.length,
      added: branches.counts.fostered,
      retitled,
      archived: branches.archived,
    },
    ...(branches.forks.length > 0
      ? {
          branchesNote:
            'A forked conversation gets one row per branch: the branch that carried on keeps its ' +
            `title, the others wear "${branches.staleTemplate.trim()}" and sit in the archived view. ` +
            'Nothing is hidden and no decision is needed; consolidate is an optional tidy-up.',
        }
      : {}),
    ...(report.liveWriters.length > 0
      ? {
          liveWriters: report.liveWriters,
          liveWritersNote:
            'A live `claude` process is writing these right now — the pid was checked against the ' +
            'creation time the record kept for it, not taken on its own. Opening the copy branches ' +
            'the conversation instead of continuing it, so tell the user to finish there first; ' +
            '`foster live` names the process and the directory it runs in.',
        }
      : {}),
    restart: {
      possible: restart.possible,
      appRunning: restart.running,
      command: restart.command,
      ...(restart.reason ? { reason: restart.reason } : {}),
    },
    outcomes: outcomes.slice(0, SWEEP_OUTCOME_LIMIT).map((outcome) => ({
      originSessionId: outcome.originSessionId,
      title: outcome.title,
      status: outcome.status,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    })),
    ...(outcomes.length > SWEEP_OUTCOME_LIMIT
      ? { outcomesNote: `${outcomes.length - SWEEP_OUTCOME_LIMIT} more not listed; see counts` }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Headless resume
 * ------------------------------------------------------------------ */

export interface ResumeHeadlessArgs {
  cliSessionId: string;
  prompt: string;
  timeoutSeconds?: number;
}

const RESUME_TIMEOUT_DEFAULT = 300;

export function resumeHeadless(ctx: AgentToolContext, args: ResumeHeadlessArgs): unknown {
  // Resuming appends to the conversation's transcript, so it is a write and sits
  // behind the same switch as the store mutations. The live-writer gate itself
  // lives in the engine, shared with the `foster resume` command.
  if (!ctx.allowWrites) return { refused: WRITES_DISABLED };

  const timeoutMs =
    Math.max(30, Math.min(args.timeoutSeconds ?? RESUME_TIMEOUT_DEFAULT, 3600)) * 1000;
  return resumeConversation(args.cliSessionId, args.prompt, {
    env: envOf(ctx),
    timeoutMs,
    ...(ctx.resumeRunner ? { runner: ctx.resumeRunner } : {}),
  });
}
