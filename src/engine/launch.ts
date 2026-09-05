import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { samePath } from '../domain/paths.js';
import { hasCredential } from '../store/cliCredential.js';
import { readClientIdentity } from '../store/clients.js';
import { configDirCandidates, looksLikeClient } from '../store/configDirs.js';
import { writerAlive, type WriterCheck } from '../store/liveSessions.js';
import { isDirectory } from '../util/fs.js';
import { scrubbedEnv } from './launchEnv.js';
import { inspectPointer } from './pointer.js';
import { clobberersIn } from './switch.js';

/**
 * A terminal tab signed in as one client, without touching any other terminal.
 *
 * `switch` and `point` change which account a config directory or a link
 * answers to — a machine-wide or consumer-wide fact. This changes neither: it
 * opens one Windows Terminal tab with `CLAUDE_CONFIG_DIR` set for that tab
 * alone, so a fleet of clients can each get their own terminal without any of
 * them touching the others' credential. Nothing is logged in, nothing is
 * switched, and nothing is written to the ledger — the one exception is
 * `--guard`, which is the existing vault write, opted into explicitly.
 *
 * Two measurements this rests on were never made, so the code assumes the
 * more dangerous answer to both:
 *
 *  - **P7** — whether `wt -w 0 new-tab` inherits the *target* window's own
 *    environment rather than the one this process hands the new process. If it
 *    does, a `CLAUDE_CONFIG_DIR` (or any other `CLAUDE*` variable) already set
 *    in that window would leak into the new tab's shell before the `-Command`
 *    ever runs. So both defences are applied, not one: `spawnSync` gets a
 *    scrubbed copy of the environment (`scrubbedEnv`, in case `wt` forwards
 *    what it was launched with), and the `-Command` itself starts by deleting
 *    every `CLAUDE*` variable a moment before setting `CLAUDE_CONFIG_DIR`
 *    fresh (in case the shell that opens is the target window's own, carrying
 *    whatever that window set).
 *  - **P11** — whether opening a terminal directly on the directory a fleet
 *    junction currently targets interferes with that fleet's own rotation.
 *    Unmeasured, so this warns rather than refuses, and there is no `--fleet`
 *    flag to make it stricter: a warning that turns out to be unnecessary
 *    costs a line of output, a refusal that turns out to be unnecessary costs
 *    someone their afternoon.
 */

/** The seams a caller supplies explicitly — never read from the ledger in here. */
export interface LaunchOptions {
  /**
   * Registered client roots and registered-container children (D4's
   * registry) — `registeredClientDirs(project(ledger.read()))`, passed in by
   * the caller. This module never reads the ledger itself, the same rule
   * `listClients` follows for the same reason: a default that quietly grew to
   * include registered roots would hand fleet directories to a resolver
   * nobody asked to widen.
   */
  clients: string[];
  /** Where the tab's shell starts. Defaults to the current directory. */
  cwd?: string;
  /** Open on a junction's target instead of refusing to open on the link. */
  followLink?: boolean;
  /** Arguments handed to `claude` inside the tab, typed after `--`. */
  claudeArgs?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injectable so a test can name a pid alive without a real process. */
  alive?: WriterCheck;
}

export interface LaunchPlan {
  blockers: string[];
  warnings: string[];
  /** The directory that would become `CLAUDE_CONFIG_DIR` — the link's target, when followed. */
  configDir?: string;
  /** The `wt --title` value: `<slug>·<email|signed-out>`, hyphenated. */
  title?: string;
  /** The executable `openTerminalTab` spawns — always `'wt'` when there are no blockers. */
  command?: string;
  /** The argv `openTerminalTab` spawns it with. */
  args?: string[];
  /** The environment the spawn gets — `scrubbedEnv` of whatever `env` named. */
  env?: NodeJS.ProcessEnv;
}

/**
 * What `client open <name>` would do, without opening anything.
 *
 * Resolution tries four readings of `<name>`, in order, and stops at the first
 * that applies:
 *
 *  1. An existing path — absolute, or relative to the current directory.
 *  2. `~/.claude-<name>`, the sibling-directory convention `clients` already
 *     enumerates on its own.
 *  3. The basename of a registered root, or of a registered container's
 *     child (`clients` in `LaunchOptions`) — refused as ambiguous, listing
 *     both, when more than one shares that basename.
 *  4. The literal name `default`, for `~/.claude`.
 *
 * A name that clears none of these is refused with the clients this machine
 * actually knows about, rather than a bare "not found" — the same reasoning
 * `resolveStoreArg` uses for `--store`.
 */
export function planLaunch(client: string, opts: LaunchOptions): LaunchPlan {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const claudeArgs = opts.claudeArgs ?? [];
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  if (!client.trim()) {
    return { blockers: ['a client name or path is required'], warnings: [] };
  }
  // Checked on the raw argument, before resolution even looks at disk: the
  // embedded value is whatever directory this resolves to, and a directory
  // Windows will actually create can never hold one of these characters in
  // the first place — so the useful place to catch a hostile argument is
  // here, not after a doomed `isDirectory` lookup reports "does not exist".
  if (hasQuoteOrControlChar(client)) {
    return {
      blockers: [
        `"${client}" contains a quote or control character and cannot be embedded in a ` +
          'terminal command — rename it.',
      ],
      warnings: [],
    };
  }
  // Every claude argument ends up single-quoted in the `-Command` string
  // (`quoteArg`), which closes off subexpressions and backticks, but a raw
  // control character is refused outright anyway — the same rule and the same
  // message the config directory gets below, for consistency.
  const badArg = claudeArgs.find(hasQuoteOrControlChar);
  if (badArg !== undefined) {
    return {
      blockers: [
        `"${badArg}" contains a quote or control character and cannot be embedded in a ` +
          'terminal command.',
      ],
      warnings: [],
    };
  }

  const resolution = resolveClientDir(client, home, opts.clients);
  if (resolution.blockers.length > 0) {
    return { blockers: resolution.blockers, warnings: [] };
  }
  const configDir = resolution.configDir!;

  const blockers: string[] = [];
  if (!isDirectory(configDir)) {
    blockers.push(`${configDir} does not exist`);
    return { blockers, warnings: [], configDir };
  }
  if (!looksLikeClient(configDir)) {
    blockers.push(`${configDir} does not look like a Claude Code client`);
    return { blockers, warnings: [], configDir };
  }

  // A junction is a pointer, not a client: opening straight on the link means
  // whatever runs there keeps writing through it after the next repoint
  // (`pointer.ts`'s own warning, `foster point`). `--follow-link` is the
  // explicit override, and it opens on the target rather than the link.
  const pointer = inspectPointer(configDir);
  let effectiveConfigDir = configDir;
  if (pointer.kind === 'junction') {
    if (!opts.followLink) {
      blockers.push(
        `${configDir} is a junction to ${pointer.target ?? '(unreadable target)'}; a tab opened ` +
          'on the link keeps writing through it after the next `foster point`. Run again with ' +
          '--follow-link to open on the target instead.',
      );
      return { blockers, warnings: [], configDir };
    }
    if (!pointer.target) {
      blockers.push(`${configDir} is a junction with no readable target`);
      return { blockers, warnings: [], configDir };
    }
    effectiveConfigDir = pointer.target;
    if (!isDirectory(effectiveConfigDir)) {
      blockers.push(`${configDir} points at ${effectiveConfigDir}, which does not exist`);
      return { blockers, warnings: [], configDir: effectiveConfigDir };
    }
  }

  // The directory ends up single-quoted inside a `pwsh -Command` string that
  // is itself one argv element. A control character breaks that string
  // outright; a literal double quote is refused too, because Windows'
  // own argv-to-command-line quoting uses `"`, and a stray one in a value we
  // did not choose is exactly the shape of an injection nobody measured.
  if (hasQuoteOrControlChar(effectiveConfigDir)) {
    blockers.push(
      `${effectiveConfigDir} contains a quote or control character and cannot be embedded in a ` +
        'terminal command — rename it.',
    );
    return { blockers, warnings: [], configDir: effectiveConfigDir };
  }
  if (!isDirectory(cwd)) {
    blockers.push(`${cwd} does not exist`);
    return { blockers, warnings: [], configDir: effectiveConfigDir };
  }

  const warnings = warningsFor(effectiveConfigDir, home, env, opts);
  const isDefault = samePath(effectiveConfigDir, path.join(home, '.claude'));
  const identity = readClientIdentity(effectiveConfigDir, isDefault, home);
  const signedIn = hasCredential(effectiveConfigDir);
  const who = identity?.email ?? (signedIn ? 'signed-in' : 'signed-out');
  const slug = clientNameOf(effectiveConfigDir, home);
  const title = `${slug}·${who}`.replace(/\s+/g, '-');

  const scrubbed = scrubbedEnv(env);
  const args = [
    '-w',
    '0',
    'new-tab',
    '--title',
    title,
    '-d',
    cwd,
    'pwsh',
    '-NoLogo',
    '-NoExit',
    '-Command',
    buildPsCommand(effectiveConfigDir, claudeArgs),
  ];

  return {
    blockers: [],
    warnings,
    configDir: effectiveConfigDir,
    title,
    command: 'wt',
    args,
    env: scrubbed,
  };
}

interface Resolution {
  configDir?: string;
  blockers: string[];
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value) || value === '.';
}

function resolveClientDir(client: string, home: string, registered: string[]): Resolution {
  if (isPathLike(client)) {
    const resolved = path.resolve(client);
    if (isDirectory(resolved)) return { configDir: resolved, blockers: [] };
    return { blockers: [`${resolved} does not exist`] };
  }

  const slugDir = path.join(home, `.claude-${client}`);
  if (isDirectory(slugDir)) return { configDir: slugDir, blockers: [] };

  const registeredMatches = registered.filter((dir) => path.basename(dir) === client);
  if (registeredMatches.length > 1) {
    return {
      blockers: [
        `"${client}" matches more than one registered client: ${registeredMatches.join(', ')} — ` +
          'rename one of them, or pass the full path.',
      ],
    };
  }
  if (registeredMatches.length === 1) {
    const candidate = registeredMatches[0]!;
    if (!isDirectory(candidate)) return { blockers: [`${candidate} does not exist`] };
    return { configDir: candidate, blockers: [] };
  }

  if (client === 'default') {
    const defaultDir = path.join(home, '.claude');
    if (!isDirectory(defaultDir)) return { blockers: [`${defaultDir} does not exist`] };
    return { configDir: defaultDir, blockers: [] };
  }

  const known = knownClientNames(home, registered);
  return {
    blockers: [
      known.length > 0
        ? `No client named "${client}". Known clients: ${known.join(', ')}.`
        : `No client named "${client}", and no clients are known yet — see \`foster clients\`.`,
    ],
  };
}

/** Every name `client open` would currently resolve, for the "not found" message. */
function knownClientNames(home: string, registered: string[]): string[] {
  const names = new Set<string>();
  for (const dir of configDirCandidates({}, [], home)) {
    if (looksLikeClient(dir)) names.add(clientNameOf(dir, home));
  }
  for (const dir of registered) {
    if (looksLikeClient(dir)) names.add(path.basename(dir));
  }
  return [...names].sort();
}

/**
 * The slug a directory would be opened by: `default` for `~/.claude`, the rest by
 * convention (`~/.claude-<slug>` strips the prefix; anything else is its own basename).
 *
 * This is a display name, not a promise that `client open <name>` resolves back to
 * `dir` — a registered, non-sibling directory gets a readable basename here (used for
 * the `wt` tab title and the "known clients" listing) even though that bare basename
 * only actually resolves once it has been registered. `seed.ts`'s success message
 * cares about the stronger guarantee and layers its own check on top instead of
 * duplicating the convention here — see the comment at its call site.
 *
 * Exported so callers that print "open it with `foster client open <name>`" — `seed.ts`'s
 * success message is the one that exists today — name the argument this same resolver will
 * actually accept, instead of a raw `path.basename` that only happens to agree for names
 * outside the `.claude-<slug>` convention.
 */
export function clientNameOf(dir: string, home: string): string {
  if (samePath(dir, path.join(home, '.claude'))) return 'default';
  const base = path.basename(dir);
  return base.startsWith('.claude-') ? base.slice('.claude-'.length) : base;
}

function warningsFor(
  configDir: string,
  home: string,
  env: NodeJS.ProcessEnv,
  opts: LaunchOptions,
): string[] {
  const warnings: string[] = [];

  if (!hasCredential(configDir)) {
    warnings.push(
      "not signed in — the tab lands on the CLI login. A new client's first login wants a " +
        'private browser window.',
    );
  }

  const clobberers = clobberersIn(configDir, opts.alive ?? writerAlive);
  if (clobberers.length > 0) {
    const named = clobberers.map((c) => `pid ${c.pid}${c.cwd ? `  ${c.cwd}` : ''}`).join(', ');
    warnings.push(
      `${clobberers.length} live session(s) in this client can rewrite the credential: ${named}. ` +
        'A switch underneath this tab can put the old account back minutes later.',
    );
  }

  // P11: unmeasured whether opening straight on a fleet junction's target
  // competes with that fleet's own rotation. Every directory this process
  // already knows about — the ordinary `~/.claude*` siblings and the
  // registered roots — is cheap to check with the same `inspectPointer` the
  // refusal above uses, so a live junction pointed here is named rather than
  // silently opened under.
  const known = [...configDirCandidates(env, [], home), ...opts.clients];
  const seen = new Set<string>();
  for (const dir of known) {
    if (samePath(dir, configDir) || seen.has(comparableFor(dir))) continue;
    seen.add(comparableFor(dir));
    const pointer = inspectPointer(dir);
    if (pointer.kind === 'junction' && pointer.target && samePath(pointer.target, configDir)) {
      warnings.push(
        `${dir} is a junction pointing here right now; a terminal opened directly on the target ` +
          "spends that rotation's quota (see `foster point`).",
      );
    }
  }

  warnings.push(
    "the title is the CLI's own cached claim, checked only by `foster switch`/`guard`.",
  );

  return warnings;
}

function comparableFor(dir: string): string {
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

/**
 * Whether a value would break out of the `-Command` string it gets embedded
 * in: a literal double quote, or any C0/DEL control character (newline
 * included). Written as a character-code scan rather than a regex literal —
 * a control-character class in a regex trips `no-control-regex`, and the
 * lint is right that a regex holding an invisible byte is hard to review.
 */
function hasQuoteOrControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function quoteSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Every `claude` argument is single-quoted unconditionally, not just the ones
 * that look like they need it. A single-quoted PowerShell string is always
 * literal — no subexpression evaluation, no interpolation, no backtick
 * escapes — so this is the one form that is safe for a value this module did
 * not choose. Quoting only on whitespace or an apostrophe (the earlier rule)
 * let anything else — `$(...)`, backticks, `;` — pass through unquoted and
 * run in the tab's shell before `claude` itself ever started.
 */
function quoteArg(value: string): string {
  return quoteSingle(value);
}

/**
 * The command a fresh `wt` tab runs, deleting `CLAUDE*` a second time before
 * setting it — see P7 in the module doc for why this is not redundant with
 * `scrubbedEnv`.
 */
function buildPsCommand(configDir: string, claudeArgs: string[]): string {
  const cleanup = 'Get-ChildItem Env:CLAUDE* | Remove-Item -ErrorAction SilentlyContinue';
  const setConfigDir = `$env:CLAUDE_CONFIG_DIR=${quoteSingle(configDir)}`;
  const invocation = ['claude', ...claudeArgs.map(quoteArg)].join(' ');
  return `${cleanup}; ${setConfigDir}; ${invocation}`;
}

/** The line `--print`, a platform that is not win32, and a failed spawn all show. */
export function formatLaunchCommand(plan: LaunchPlan): string {
  if (!plan.command || !plan.args) return '(nothing to run)';
  const display = (arg: string) =>
    arg.length === 0 || /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
  return [plan.command, ...plan.args.map(display)].join(' ');
}

export type TabOpener = (plan: LaunchPlan) => void;

/** The real opener: `wt`, with the plan's own scrubbed environment. */
export function spawnWt(plan: LaunchPlan): void {
  const result = spawnSync(plan.command!, plan.args!, {
    stdio: 'ignore',
    windowsHide: true,
    env: plan.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wt exited with ${result.status}`);
}

export type LaunchOutcome =
  | { outcome: 'opened' }
  | { outcome: 'not-windows'; line: string }
  | { outcome: 'failed'; line: string };

/**
 * Open the tab, or say what to run instead.
 *
 * A missing `wt`, a nonzero exit, or any other spawn failure never throws
 * past here — it comes back as `failed` carrying the exact line `--print`
 * would have shown, so the caller has something to hand the user rather than
 * a stack trace.
 *
 * `wt` only exists on Windows, so a platform other than `win32` is checked
 * before the opener is ever called and comes back as its own `not-windows`
 * outcome carrying the same line — testable here, with an injected
 * `platform`, rather than living only inside the CLI action where nothing in
 * `tests/launch.test.ts` could reach it.
 */
export function openTerminalTab(
  plan: LaunchPlan,
  open: TabOpener = spawnWt,
  platform: NodeJS.Platform = process.platform,
): LaunchOutcome {
  if (plan.blockers.length > 0 || !plan.command || !plan.args) {
    return { outcome: 'failed', line: formatLaunchCommand(plan) };
  }
  if (platform !== 'win32') {
    return { outcome: 'not-windows', line: formatLaunchCommand(plan) };
  }
  try {
    open(plan);
    return { outcome: 'opened' };
  } catch {
    return { outcome: 'failed', line: formatLaunchCommand(plan) };
  }
}
