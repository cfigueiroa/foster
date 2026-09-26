import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { comparablePath, listAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import {
  fetchCloudSession,
  fetchTeleportEvents,
  isCloudApiError,
  listCloudSessions,
  type CloudApiError,
  type CloudRepoHint,
  type CloudSessionSummary,
} from '../engine/cloudApi.js';
import { pullCloudSession, type CloudPullOutcome } from '../engine/cloudImportWrite.js';
import { scrubbedEnv } from '../engine/launchEnv.js';
import type { Ledger } from '../ledger/log.js';
import { project, type LedgerState } from '../ledger/project.js';
import { readCloudAuth, type CloudAuthRefusal } from '../store/cloudAuth.js';
import { listClients, type ClaudeClient } from '../store/clients.js';
import { isDirectory } from '../util/fs.js';
import { scanAccount } from '../store/scanner.js';

/**
 * `foster sweep --cloud` — the fourth thing "bring everything into this
 * account" has to reach: not only every other *local* account's sidebar
 * (`runSweep`'s own four passes), but every cloud session (code.claude.com)
 * any other signed-in CLI credential on this machine can see, brought in the
 * same way `foster cloud pull` brings one in by hand.
 *
 * Off by default, like every other optional sweep pass (`--sync-titles`,
 * `--dates`): unlike those, this one calls out to a private, undocumented API
 * (see `engine/cloudApi.ts`'s module comment) and writes into repositories it
 * has to guess at from a git remote, so it is asked for explicitly rather than
 * folded into a bare `foster sweep`.
 *
 * Split from `runSweep` itself rather than added as a fifth in-process pass:
 * every existing pass reads from a `DiscoveredSession` scan and a `Lineage`
 * built once up front, and this one instead makes network calls per
 * account — a different enough shape that bolting it onto `SweepRun`'s single
 * synchronous `runSweep` would have meant threading `async` through a
 * function that today has none. `runSweepCommand` (`cli/index.ts`) calls
 * `planCloudSweep`/`applyCloudSweep` after `runSweep` returns and folds the
 * result into the same `--json` object and text summary.
 */

export interface CloudSweepPlanItem {
  cloudSessionId: string;
  title: string;
  sourceAccountUuid?: string;
  sourceConfigDir: string;
  into: string;
  repo: CloudRepoHint;
}

export interface CloudSweepSkip {
  reason: string;
  count: number;
}

export interface CloudSweepAccountRefusal {
  configDir: string;
  reason: string;
}

export interface CloudSweepPlan {
  /** What would be pulled — one entry per session with a local checkout to open in. */
  items: CloudSweepPlanItem[];
  /** Sessions this pass will not bring, grouped by why, e.g. "already pulled", "archived in the cloud", "no local checkout for acme/widgets". */
  skipped: CloudSweepSkip[];
  /** Clients whose credential could not be used at all — expired, signed out, or no cached organization. */
  accountsNeedingLogin: CloudSweepAccountRefusal[];
  /** Clients whose session list itself could not be read (a network or API error, not a credential refusal). */
  accountErrors: CloudSweepAccountRefusal[];
}

export interface CloudSweepApplyResult extends CloudSweepPlan {
  outcomes: CloudPullOutcome[];
  pulled: number;
  failed: number;
}

export interface PlanCloudSweepOptions {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  /** Bring a session the cloud itself has archived — off by default, the same convention `--include-archived` follows elsewhere. */
  includeArchived?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injected for tests — see the individual fields for what each stands in for. */
  deps?: CloudSweepDeps;
}

export interface CloudSweepDeps {
  listClients?: typeof listClients;
  readCloudAuth?: typeof readCloudAuth;
  listCloudSessions?: typeof listCloudSessions;
  fetchCloudSession?: typeof fetchCloudSession;
  fetchTeleportEvents?: typeof fetchTeleportEvents;
  pullCloudSession?: typeof pullCloudSession;
  /** `git -C <dir> remote get-url origin`, normalized — swapped out in tests for a fake map. */
  gitRemoteOrigin?: (dir: string) => string | undefined;
  /** Extra candidate directories to check a git remote against, ahead of `C:\repos\*` — for tests. */
  repoRoots?: string[];
  platform?: NodeJS.Platform;
}

/** `owner/repo`, lowercased, from a clone URL or an already-bare `owner/repo` string — never used for a git operation, only compared. */
export function normalizeRepoSlug(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // Already bare, e.g. git_info.repo's own "acme/widgets".
  if (!trimmed.includes('://') && !trimmed.includes('@') && !trimmed.includes('\\')) {
    const parts = trimmed.replace(/\.git$/i, '').split('/');
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      return parts.join('/').toLowerCase();
    }
  }

  // git@host:owner/repo(.git)
  const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmed);
  if (scp) {
    const parts = scp[1]!
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('/').toLowerCase();
  }

  // https://host/owner/repo(.git), ssh://host/owner/repo
  try {
    const url = new URL(trimmed);
    const parts = url.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('/').toLowerCase();
  } catch {
    // Not a URL either — give up rather than guess.
  }
  return undefined;
}

function sessionRepoSlug(repo: CloudRepoHint): string | undefined {
  if (repo.repo) {
    const fromRepo = normalizeRepoSlug(repo.repo);
    if (fromRepo) return fromRepo;
  }
  if (repo.url) return normalizeRepoSlug(repo.url);
  return undefined;
}

/** `git -C <dir> remote get-url origin`, normalized. `undefined` for anything that is not a readable git checkout with an `origin` remote. */
function realGitRemoteOrigin(dir: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    });
    return normalizeRepoSlug(out.trim());
  } catch {
    return undefined;
  }
}

/** Every distinct, existing directory a set of cards' `cwd`/`originCwd` names. */
function cwdsOf(store: StoreLayout, account: AccountRef): string[] {
  const dirs = new Set<string>();
  for (const session of scanAccount(store, account, undefined, { slim: true })) {
    for (const cwd of [session.data.cwd, session.data.originCwd]) {
      if (typeof cwd === 'string' && cwd !== '') dirs.add(cwd);
    }
  }
  return [...dirs];
}

/** `C:\repos\*` on Windows, per AGENTS.md's own convention for where a repository checkout lives on this machine; nothing on any other platform. */
function repoRootCandidates(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [];
  const root = 'C:\\repos';
  if (!isDirectory(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * Find a local checkout of `slug` (`owner/repo`) among a set of candidate
 * directories, checking each one's git remote at most once per call — the
 * cache lives in `remoteCache` across the whole plan, since the same
 * candidate directories are checked against every session that needs a repo
 * match.
 */
function findCheckout(
  slug: string,
  candidates: readonly string[],
  remoteOf: (dir: string) => string | undefined,
  remoteCache: Map<string, string | undefined>,
): string | undefined {
  const seen = new Set<string>();
  for (const dir of candidates) {
    const key = comparablePath(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isDirectory(dir)) continue;

    let remote = remoteCache.get(key);
    if (remote === undefined && !remoteCache.has(key)) {
      remote = remoteOf(dir);
      remoteCache.set(key, remote);
    }
    if (remote === slug) return dir;
  }
  return undefined;
}

function addSkip(skips: Map<string, number>, reason: string): void {
  skips.set(reason, (skips.get(reason) ?? 0) + 1);
}

/** "run claude in <dir> to refresh" — never a refresh foster performs itself. See `cloudAuth.ts`. */
function refusalMessage(reason: CloudAuthRefusal, configDir: string): string {
  if (reason === 'expired') return `access token expired — run claude in ${configDir} to refresh`;
  if (reason === 'no-organization') {
    return `no cached organization for this client — run claude in ${configDir} once, signed in`;
  }
  return `not signed in — run claude in ${configDir} to sign in`;
}

/**
 * Plan `foster sweep --cloud`: read-only, and safe to call on a dry run.
 *
 * Every client `listClients` names (never a `foster client register`ed fleet
 * root — the same rule `resolveCloudClient` follows for a bare `foster cloud`)
 * is asked for a cloud credential; the target account's own client is
 * skipped, since its cloud sessions are already in its own sidebar.
 */
export async function planCloudSweep(options: PlanCloudSweepOptions): Promise<CloudSweepPlan> {
  const { store, target } = options;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const deps = options.deps ?? {};
  const list = deps.listClients ?? listClients;
  const auth = deps.readCloudAuth ?? readCloudAuth;
  const listSessions = deps.listCloudSessions ?? listCloudSessions;
  const platform = deps.platform ?? process.platform;
  const remoteOf = deps.gitRemoteOrigin ?? realGitRemoteOrigin;

  const state = project(options.ledger.read());
  const items: CloudSweepPlanItem[] = [];
  const skips = new Map<string, number>();
  const accountsNeedingLogin: CloudSweepAccountRefusal[] = [];
  const accountErrors: CloudSweepAccountRefusal[] = [];

  const targetCwds = cwdsOf(store, target);
  const repoRoots = deps.repoRoots ?? repoRootCandidates(platform);
  const remoteCache = new Map<string, string | undefined>();
  const seenAccountUuids = new Set<string>([target.accountUuid]);

  for (const client of list(env)) {
    if (!client.signedIn) continue;
    const result = auth(client.configDir, client.isDefault, home);
    if (!result.ok) {
      accountsNeedingLogin.push({
        configDir: client.configDir,
        reason: refusalMessage(result.reason, client.configDir),
      });
      continue;
    }

    const accountUuid = result.auth.accountUuid;
    // Skip the target's own account — its cloud sessions are already visible
    // in its own sidebar — and skip a second client signed into an account
    // this plan has already read, so two config directories sharing one
    // login never pull the same session twice.
    if (accountUuid !== undefined && seenAccountUuids.has(accountUuid)) continue;
    if (accountUuid !== undefined) seenAccountUuids.add(accountUuid);

    const sessions = await listSessions(result.auth);
    if (isCloudApiError(sessions)) {
      accountErrors.push({ configDir: client.configDir, reason: sessions.message });
      continue;
    }
    if (sessions.length === 0) continue;

    // "the target and source accounts' existing cards" — the source account
    // is identified by the credential's own accountUuid, matched against
    // every organization this store happens to have a directory for; a
    // credential for an account this store has never seen simply contributes
    // no extra candidate directories, not an error.
    const sourceCwds =
      accountUuid !== undefined
        ? listAccountDirs(store)
            .filter((a) => a.accountUuid === accountUuid)
            .flatMap((a) => cwdsOf(store, a))
        : [];
    const candidates = [...targetCwds, ...sourceCwds, ...repoRoots];

    for (const session of sessions) {
      const outcome = await planOneSession(session, {
        client,
        accountUuid,
        state,
        includeArchived: options.includeArchived ?? false,
        candidates,
        remoteOf,
        remoteCache,
      });
      if (outcome.kind === 'skip') addSkip(skips, outcome.reason);
      else items.push(outcome.item);
    }
  }

  return {
    items,
    skipped: [...skips.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    accountsNeedingLogin,
    accountErrors,
  };
}

type PlanOneResult = { kind: 'skip'; reason: string } | { kind: 'item'; item: CloudSweepPlanItem };

function planOneSession(
  session: CloudSessionSummary,
  ctx: {
    client: ClaudeClient;
    accountUuid: string | undefined;
    state: LedgerState;
    includeArchived: boolean;
    candidates: readonly string[];
    remoteOf: (dir: string) => string | undefined;
    remoteCache: Map<string, string | undefined>;
  },
): PlanOneResult {
  if (session.status === 'archived' && !ctx.includeArchived) {
    return { kind: 'skip', reason: 'archived in the cloud' };
  }
  if (ctx.state.imported.has(session.id)) {
    return { kind: 'skip', reason: 'already pulled' };
  }

  const slug = sessionRepoSlug(session.repo);
  if (!slug) return { kind: 'skip', reason: 'no repository named on the session' };

  const into = findCheckout(slug, ctx.candidates, ctx.remoteOf, ctx.remoteCache);
  if (!into) return { kind: 'skip', reason: `no local checkout for ${slug}` };

  return {
    kind: 'item',
    item: {
      cloudSessionId: session.id,
      title: session.title,
      ...(ctx.accountUuid !== undefined ? { sourceAccountUuid: ctx.accountUuid } : {}),
      sourceConfigDir: ctx.client.configDir,
      into,
      repo: session.repo,
    },
  };
}

export interface ApplyCloudSweepOptions {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  plan: CloudSweepPlan;
  now?: number;
  deps?: CloudSweepDeps;
}

/**
 * Write every planned item — one `pullCloudSession` per session, the same
 * write path `foster cloud pull --yes` uses by hand. Failures are per
 * session, never fatal to the run: one session whose history could not be
 * fetched a second time (network blip, a since-deleted session) must not
 * abort the rest of a sweep that is otherwise fine.
 */
export async function applyCloudSweep(
  options: ApplyCloudSweepOptions,
): Promise<CloudSweepApplyResult> {
  const { store, plan, target } = options;
  const deps = options.deps ?? {};
  const fetchDetail = deps.fetchCloudSession ?? fetchCloudSession;
  const fetchEvents = deps.fetchTeleportEvents ?? fetchTeleportEvents;
  const pull = deps.pullCloudSession ?? pullCloudSession;
  const auth = deps.readCloudAuth ?? readCloudAuth;
  const home = homedir();

  const outcomes: CloudPullOutcome[] = [];
  // Re-derive each item's own credential rather than carrying it in the plan:
  // `CloudSweepPlan` is what `--json` prints, and a bearer token has no
  // business sitting in that object waiting to be serialised. One extra
  // `readCloudAuth` per item is a local file read, not a network call.
  const authCache = new Map<string, ReturnType<typeof auth>>();

  for (const item of plan.items) {
    let clientAuth = authCache.get(item.sourceConfigDir);
    if (!clientAuth) {
      // `isDefault` only matters for where `.claude.json` is read from — see
      // `readCloudAuth`'s own candidate list — and every client this plan
      // named came from `listClients`, which already knows the answer; asking
      // again here would mean threading `ClaudeClient` through the plan just
      // for this one field, so it is measured directly instead.
      const isDefault =
        comparablePath(item.sourceConfigDir) === comparablePath(path.join(home, '.claude'));
      clientAuth = auth(item.sourceConfigDir, isDefault, home);
      authCache.set(item.sourceConfigDir, clientAuth);
    }
    if (!clientAuth.ok) {
      outcomes.push({
        cloudSessionId: item.cloudSessionId,
        title: item.title,
        status: 'failed',
        reason: `credential no longer usable: ${clientAuth.reason}`,
      });
      continue;
    }

    const detail = await fetchDetail(clientAuth.auth, item.cloudSessionId);
    if (isCloudApiError(detail)) {
      outcomes.push({
        cloudSessionId: item.cloudSessionId,
        title: item.title,
        status: 'failed',
        reason: describeApiError(detail),
      });
      continue;
    }
    const events = await fetchEvents(clientAuth.auth, item.cloudSessionId);
    if (isCloudApiError(events)) {
      outcomes.push({
        cloudSessionId: item.cloudSessionId,
        title: item.title,
        status: 'failed',
        reason: describeApiError(events),
      });
      continue;
    }

    // Re-read fresh for every write, the same as `runSweep`'s own passes do
    // between rounds: an earlier item in this same apply just appended to the
    // ledger, and a stale `state` would not see it.
    const state = project(options.ledger.read());
    outcomes.push(
      pull(item.cloudSessionId, detail, events, {
        store,
        ledger: options.ledger,
        state,
        target,
        cwd: item.into,
        dryRun: false,
        env: scrubbedEnv(process.env),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
    );
  }

  const pulled = outcomes.filter((o) => o.status === 'imported').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  return { ...plan, outcomes, pulled, failed };
}

function describeApiError(error: CloudApiError): string {
  return error.message;
}

/**
 * The lines `foster sweep --cloud`'s text output prints after `sweepSummary`
 * — the same "counts, then the gaps a caller cannot see" shape the rest of
 * that summary uses. Takes either a plan (dry run) or the applied result: the
 * only field the two do not share is `pulled`/`failed`, which only exist once
 * something was actually written.
 */
export function cloudSweepSummary(
  result: CloudSweepPlan | CloudSweepApplyResult,
  dryRun: boolean,
): string[] {
  const lines: string[] = [];
  const applied = 'outcomes' in result;
  if (applied) {
    lines.push(
      `Cloud: pulled ${result.pulled} session(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}.`,
    );
  } else if (result.items.length > 0) {
    lines.push(
      `Cloud: ${result.items.length} session(s) would be pulled.` +
        (dryRun ? ' Re-run with --yes to write.' : ''),
    );
  } else {
    lines.push('Cloud: nothing to pull.');
  }

  for (const skip of result.skipped) {
    lines.push(`  ${skip.count} skipped — ${skip.reason}`);
  }
  for (const refusal of result.accountsNeedingLogin) {
    lines.push(`  ${refusal.configDir}: ${refusal.reason}`);
  }
  for (const error of result.accountErrors) {
    lines.push(`  ${error.configDir}: ${error.reason}`);
  }
  return lines;
}

/** `cloud` as it goes into `--json` — a plan or an applied result, either way. */
export function cloudSweepJson(
  result: CloudSweepPlan | CloudSweepApplyResult,
): Record<string, unknown> {
  const { items, skipped, accountsNeedingLogin, accountErrors } = result;
  return {
    planned: items,
    skipped,
    accountsNeedingLogin,
    accountErrors,
    ...('outcomes' in result
      ? { pulled: result.pulled, failed: result.failed, outcomes: result.outcomes }
      : {}),
  };
}
