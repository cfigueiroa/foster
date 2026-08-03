import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { bareSessionId } from '../domain/naming.js';
import { listAccountDirs, samePath, storeRootOfCopy } from '../domain/paths.js';
import type { DiscoveredSession, StoreLayout } from '../domain/types.js';
import { currentAccount, requireCurrentAccount } from '../engine/account.js';
import { inspectDesktopFor } from '../engine/desktop.js';
import { findDuplicates } from '../engine/duplicates.js';
import {
  fosterSessions,
  returnFosterings,
  summariseOutcomes,
  type Outcome,
} from '../engine/executor.js';
import { AppRunningError, inspectApp, type RemovalGuard } from '../engine/safety.js';
import { storeIdentity } from '../domain/paths.js';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import { readConfig } from '../store/config.js';
import { scanAccount, summarise } from '../store/scanner.js';
import { liveSessionFor, sessionRegistryRoots } from '../store/liveSessions.js';
import { indexTranscripts, readTranscriptFacts, transcriptRoots } from '../store/transcripts.js';
import { applyFilter, byRecency, selectByIds, type SessionFilter } from '../cli/filters.js';

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
}

export type ResumeRunner = (cliSessionId: string, prompt: string, timeoutMs: number) => string;

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
    sources = accounts.filter((ref) => ref.accountUuid.startsWith(args.accountUuid!));
    if (sources.length === 0) throw new Error(`No account matches "${args.accountUuid}".`);
  } else {
    sources = accounts.filter((ref) => ref.accountUuid !== current?.accountUuid);
  }

  const filter: SessionFilter = { includeUnfosterable: args.includeUnfosterable ?? false };
  if (args.title) filter.title = args.title;
  if (args.cwd) filter.cwd = args.cwd;
  if (args.sinceDays !== undefined) filter.since = Date.now() - args.sinceDays * 86_400_000;

  const copies = copySessionIds(ledger.read());
  const all = byRecency(
    applyFilter(
      sources.flatMap((account) => scanAccount(store, account, copies)),
      filter,
    ),
  );

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
  const here = active.filter((f) => samePath(storeRootOfCopy(f.copyPath), store.root));
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
      inThisStore: samePath(storeRootOfCopy(f.copyPath), store.root),
    })),
    duplicateCopies: duplicates.copies.length,
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
  const id = bareSessionId(args.cliSessionId);
  const index = indexTranscripts(transcriptRoots(envOf(ctx)));
  const file = index.get(id);
  if (!file) {
    throw new Error(
      `No transcript found for conversation ${id}. ` +
        "list_sessions shows each session's cliSessionId; only conversations that ran on this machine have one.",
    );
  }

  const facts = readTranscriptFacts(file, id);
  const maxChars = Math.max(1000, Math.min(args.maxChars ?? 20_000, 200_000));
  const part = args.part ?? 'tail';
  const { text, sizeBytes } = readPart(file, part, maxChars);

  return {
    cliSessionId: id,
    path: file,
    title: facts.title ?? null,
    cwd: facts.cwd ?? null,
    createdAt: iso(facts.createdAt),
    lastActivityAt: iso(facts.lastActivityAt),
    sizeBytes,
    part,
    truncated: sizeBytes > maxChars,
    format:
      'jsonl — one record per line; partial first/last lines are possible on a truncated read',
    text,
  };
}

function readPart(
  file: string,
  part: 'head' | 'tail',
  maxChars: number,
): { text: string; sizeBytes: number } {
  const size = statSync(file).size;
  const length = Math.min(size, maxChars);
  const position = part === 'head' ? 0 : size - length;

  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return { text: buffer.subarray(0, read).toString('utf8'), sizeBytes: size };
  } finally {
    closeSync(fd);
  }
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
  if (!args.label.trim()) throw new Error('The label must not be empty.');
  ctx.ledger.append({ kind: 'account_labelled', accountUuid: args.accountUuid, label: args.label });
  return { labelled: args.accountUuid, label: args.label };
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
    sources = sources.filter((ref) => ref.accountUuid.startsWith(args.fromAccountUuid!));
    if (sources.length === 0) throw new Error(`No account matches "${args.fromAccountUuid}".`);
  }

  const filter: SessionFilter = { includeUnfosterable: false };
  if (args.title) filter.title = args.title;
  if (args.cwd) filter.cwd = args.cwd;
  if (args.sinceDays !== undefined) filter.since = Date.now() - args.sinceDays * 86_400_000;

  const copies = copySessionIds(ledger.read());
  let candidates = byRecency(
    applyFilter(
      sources.flatMap((account) => scanAccount(store, account, copies)),
      filter,
    ),
  );

  if (args.sessionIds?.length) {
    const { selected, unmatched } = selectByIds(candidates, args.sessionIds);
    if (unmatched.length > 0) {
      throw new Error(`No session matches ${unmatched.join(', ')} — check with list_sessions.`);
    }
    candidates = byRecency(selected);
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
  let active = listActive(project(ledger.read()));
  let elsewhere = 0;

  if (!args.allStores) {
    elsewhere = active.filter((f) => !samePath(storeRootOfCopy(f.copyPath), store.root)).length;
    active = active.filter((f) => samePath(storeRootOfCopy(f.copyPath), store.root));
  }
  if (args.duplicatesOnly) {
    const duplicated = new Set(findDuplicates(store, active).copies.map((f) => f.copySessionId));
    active = active.filter((f) => duplicated.has(f.copySessionId));
  }
  if (args.title) {
    const needle = args.title.toLowerCase();
    active = active.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(needle));
  }
  if (args.sessionIds?.length) {
    const wanted = args.sessionIds.map((id) => bareSessionId(id).toLowerCase());
    active = active.filter((f) =>
      wanted.some((id) => bareSessionId(f.originSessionId).toLowerCase().startsWith(id)),
    );
  }

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
  // behind the same switch as the store mutations.
  if (!ctx.allowWrites) return { refused: WRITES_DISABLED };

  const id = bareSessionId(args.cliSessionId);
  if (!/^[0-9a-f][0-9a-f-]{7,63}$/i.test(id)) {
    throw new Error(`"${args.cliSessionId}" does not look like a conversation id.`);
  }
  if (!args.prompt.trim()) throw new Error('The prompt must not be empty.');

  // Two writers on one transcript corrupt it. The CLI registers every live
  // process under <configDir>/sessions, so a conversation someone is using right
  // now — in the app or in a terminal — is refused rather than raced.
  const live = liveSessionFor(id, sessionRegistryRoots(envOf(ctx)));
  if (live) {
    return {
      refused:
        `A live claude process (pid ${live.pid}) is using this conversation right now` +
        (live.cwd ? ` in ${live.cwd}` : '') +
        '. Resuming it from outside would put two writers on one transcript.',
    };
  }

  const timeoutMs =
    Math.max(30, Math.min(args.timeoutSeconds ?? RESUME_TIMEOUT_DEFAULT, 3600)) * 1000;
  const run = ctx.resumeRunner ?? runClaudeResume;
  const output = run(id, args.prompt, timeoutMs);
  const capped =
    output.length > 100_000 ? `${output.slice(0, 100_000)}\n[output truncated]` : output;
  return { cliSessionId: id, output: capped };
}

/**
 * `claude -p --resume` with the prompt on stdin.
 *
 * stdin on purpose: on Windows the command resolves through a shell (the CLI is
 * a .cmd shim, which Node refuses to spawn directly), and an argument that came
 * from a model has no business being interpreted by one. The only argv values
 * are literals and an id validated to [0-9a-f-].
 */
function runClaudeResume(cliSessionId: string, prompt: string, timeoutMs: number): string {
  try {
    return execFileSync('claude', ['-p', '--resume', cliSessionId], {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Running \`claude -p --resume\` failed: ${detail}\n` +
        'The Claude Code CLI must be installed and signed in for headless resume.',
    );
  }
}
