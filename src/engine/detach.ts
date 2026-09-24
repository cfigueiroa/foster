import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isSelfHostedBy, isSelfSession, type LiveCliSession } from '../store/liveSessions.js';
import {
  execFileSyncRunner,
  systemExePath,
  type CommandRunner,
  type ProcessRow,
} from '../util/processes.js';
import { fileExists, safeReaddir } from '../util/fs.js';
import { VERSION } from '../version.js';

/**
 * Restarting Claude Desktop from a session the app itself hosts.
 *
 * `restartPlan` (`src/ops/sweep.ts`) refuses this outright — quitting the app
 * kills the Code session part-way through, foster included — and hands over a
 * command for a terminal outside it. That refusal is correct and stays; this is
 * the escape hatch for someone who is *only* ever inside a hosted session and
 * still wants "one command finishes the job".
 *
 * Measured end to end on the real machine (22/09/2026):
 *
 *  1. `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments
 *     @{CommandLine='wscript.exe "<vbs>"'}` — the new process's parent is
 *     `WmiPrvSE.exe`, outside the app's tree and outside its MSIX container, so
 *     it survives the app quitting and `restartPlan` sees no app ancestor in it.
 *  2. The `.vbs` runs a `cmd.exe /c "ping … & echo … & node "<foster.js>" …
 *     & echo …"` line through `WScript.Shell.Run(cmd, 0, True)` — window style
 *     0 is what actually hides it; on this machine Windows Terminal is the
 *     default terminal and a console process pops a window even with
 *     `-WindowStyle Hidden`, `Run(…, 0, …)` does not.
 *  3. Result: the app quits, the write lands in the gap, the app starts again,
 *     the log is complete. The launching session dies with the app — expected,
 *     and said plainly by the CLI before it ever launches this.
 *
 * Pitfall measured writing the `.vbs` generator itself: `Log` is a VBScript
 * built-in function, and a variable named `Log` kills the script with an error
 * dialog before anything runs. None of the names this module writes may collide
 * with a VBScript built-in (`Log`, `Date`, `Time`, `Len`, …) — `vbsAssignsBuiltin`
 * exists so a test can hold that promise rather than trusting it by inspection.
 */

/** Characters that would break out of the `cmd.exe` compound line this builds. */
const CMD_UNSAFE = /["%&|<>^\r\n]/;

/** VBScript's own reserved names — see the module doc comment's pitfall. */
const VBS_BUILTINS = new Set([
  'log',
  'date',
  'time',
  'len',
  'now',
  'day',
  'month',
  'year',
  'hour',
  'minute',
  'second',
  'left',
  'right',
  'mid',
  'trim',
  'ltrim',
  'rtrim',
  'chr',
  'asc',
  'cstr',
  'cint',
  'sub',
  'function',
  'dim',
  'set',
  'call',
  'error',
]);

export interface PlanDetachedOptions {
  /** The foster arguments to re-run, `--detach`/`--detach-delay` included or not — both are stripped here. */
  argv: string[];
  delaySeconds: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** `process.execPath` — node itself, quoted into the launch line rather than trusted to PATH. */
  execPath: string;
  /** `process.argv[1]` — the running bundle, installed or `dist/`. */
  scriptPath: string;
  /** For the `.vbs` comment header. Defaults to this build's own version. */
  version?: string;
}

export interface DetachedPlan {
  vbsPath: string;
  logPath: string;
  vbsText: string;
  /** What launches the `.vbs`, hidden — the WMI `Create` call's own `CommandLine`. */
  commandLine: string;
  /** The argv actually re-run, after stripping `--detach`/`--detach-delay`. */
  argv: string[];
  delaySeconds: number;
}

function detachedDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.FOSTER_HOME ?? path.join(homedir(), '.foster'), 'detached');
}

/**
 * `--detach`, `--detach-delay <n>` (or `=<n>`) and `--detach-even-with-live`
 * stripped — what actually gets re-run. All three are meaningless (the last
 * two are outright unrecognised) on the command the detached process runs, so
 * every caller may simply hand this its own raw argv rather than reconstruct
 * one by hand from the options it parsed.
 */
export function stripDetachFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--detach' || arg === '--detach-even-with-live') continue;
    if (arg === '--detach-delay') {
      i++; // also drop its value
      continue;
    }
    if (arg.startsWith('--detach-delay=')) continue;
    out.push(arg);
  }
  return out;
}

/**
 * The command to hand over when a write could not restart the app itself: the
 * same invocation actually typed, `--detach`/`--detach-delay*`/
 * `--detach-even-with-live` dropped (they mean nothing without a live process
 * to detach from) and `--yes`/`--restart` guaranteed present. `view set` used
 * to hand over the bare template `'foster view set --yes --restart'`, which
 * dropped every filter flag the run actually carried and left "Nothing to
 * change." for whoever ran it; `layout` and `sweep` had the same shape of gap
 * for `--store`/`--ledger`/`--to`/`--to-org`. Echoing the real argv is what
 * `--detach` itself already does (`stripDetachFlags` above) — this is the same
 * idea for the line printed instead of run.
 */
export function restartCommandFromArgv(argv: string[]): string {
  const stripped = stripDetachFlags(argv);
  const withYes = stripped.includes('--yes') ? stripped : [...stripped, '--yes'];
  const withRestart = withYes.includes('--restart') ? withYes : [...withYes, '--restart'];
  return `foster ${withRestart.join(' ')}`;
}

/** Local time, second resolution — matches the run this launcher is a record of. */
function localStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The leading run of non-flag tokens (`app restart` → `app-restart`), for a readable filename. */
function verbOf(argv: string[]): string {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith('-')) break;
    words.push(token);
  }
  const joined = words.length > 0 ? words.join('-') : 'run';
  return joined.replace(/[^a-zA-Z0-9-]/g, '_');
}

/** A `<dir>/<stamp>-<verb>.vbs` this call alone will ever be given, a counter breaking any collision. */
function freshStamp(dir: string, stamp: string, verb: string): string {
  let candidate = stamp;
  let n = 2;
  while (existsSync(path.join(dir, `${candidate}-${verb}.vbs`))) {
    candidate = `${stamp}-${n}`;
    n++;
  }
  return candidate;
}

function quoteForCmd(value: string): string {
  return `"${value}"`;
}

/** VBScript string-literal escaping: a `"` inside one is written as `""`. */
function vbsStringLiteral(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Every VBScript variable this module's own generated text assigns to — asserted
 * against `VBS_BUILTINS` by a test, so a future rename cannot repeat the `Log`
 * mistake the module doc comment describes without the suite catching it.
 */
export const VBS_VARIABLE_NAMES = ['shellObject', 'launchLine'] as const;

function buildVbsText(input: {
  stamp: string;
  logPath: string;
  cmdLine: string;
  version: string;
  now: Date;
}): string {
  const { stamp, logPath, cmdLine, version, now } = input;
  return (
    "' Detached restart launcher — generated by foster, not hand-written.\n" +
    `' What it is: quits Claude Desktop, waits, re-runs a foster command, and starts\n` +
    "'   the app again — from a process tree outside the app's own, so the app\n" +
    "'   quitting does not take this script down with it.\n" +
    `' Written by foster ${version} at ${now.toISOString()} (${stamp} local).\n` +
    `' Log: ${logPath}\n` +
    "'\n" +
    '\' Pitfall (measured writing this generator): "Log" is a VBScript built-in\n' +
    "' function. A variable named Log kills this script with an error dialog before\n" +
    "' anything runs. Never name a variable here after a VBScript built-in (Log,\n" +
    "' Date, Time, Len, ...).\n" +
    '\n' +
    'Dim shellObject\n' +
    'Dim launchLine\n' +
    'Set shellObject = CreateObject("WScript.Shell")\n' +
    `launchLine = ${vbsStringLiteral(cmdLine)}\n` +
    '\n' +
    "' 0 = hidden window; True = wait for it. Window style 0 is what actually keeps\n" +
    "' this invisible — WT pops a window for a console process even under\n" +
    "' -WindowStyle Hidden, and Run(..., 0, ...) does not.\n" +
    'shellObject.Run launchLine, 0, True\n'
  );
}

/**
 * Everything a detached restart needs, computed and returned — nothing written,
 * nothing launched. Pure, so a test can check every part of it without touching
 * disk or a real machine.
 */
export function planDetached(options: PlanDetachedOptions): DetachedPlan {
  const {
    argv,
    delaySeconds,
    env = process.env,
    now = () => new Date(),
    execPath,
    scriptPath,
    version = VERSION,
  } = options;

  const cleanArgv = stripDetachFlags(argv);
  for (const arg of cleanArgv) {
    if (CMD_UNSAFE.test(arg)) {
      throw new Error(
        `--detach cannot carry an argument containing a character the cmd.exe line would ` +
          `misread: ${JSON.stringify(arg)}. Run it undetached, or drop that argument.`,
      );
    }
  }

  // Measured 24/09/2026: a process WMI's `Win32_Process.Create` starts does not
  // inherit the *calling* process's environment — a marker set only in this
  // shell's own `$env:` never reached a child launched that way, though the
  // logged-on user's persistent variables did. `FOSTER_HOME` set the same way
  // (a test harness, or a relocated ledger for one shell) would otherwise be
  // silently dropped the moment the restart detaches: the re-run would read
  // and write the *default* `~/.foster`, not the one this invocation meant.
  // Set explicitly in the launch line whenever this process has one, so the
  // detached re-run sees exactly what this one did.
  const fosterHome = env.FOSTER_HOME;
  if (fosterHome !== undefined && CMD_UNSAFE.test(fosterHome)) {
    throw new Error(
      `--detach cannot carry FOSTER_HOME through the launch line: ${JSON.stringify(fosterHome)} ` +
        'contains a character the cmd.exe line would misread. Run it undetached, or relocate FOSTER_HOME.',
    );
  }

  const dir = detachedDir(env);
  const nowValue = now();
  const stamp = freshStamp(dir, localStamp(nowValue), verbOf(cleanArgv));
  const verb = verbOf(cleanArgv);
  const vbsPath = path.join(dir, `${stamp}-${verb}.vbs`);
  const logPath = path.join(dir, `${stamp}-${verb}.log`);

  const pingCount = delaySeconds + 1;
  const quotedLog = quoteForCmd(logPath);
  const quotedExec = quoteForCmd(execPath);
  const quotedScript = quoteForCmd(scriptPath);
  const argsForLog = cleanArgv.join(' ');
  const argsForRun = cleanArgv.map(quoteForCmd).join(' ');
  const runLine = argsForRun
    ? `${quotedExec} ${quotedScript} ${argsForRun}`
    : `${quotedExec} ${quotedScript}`;
  const setFosterHome = fosterHome !== undefined ? `set FOSTER_HOME=${fosterHome}& ` : '';

  const cmdLine =
    `cmd.exe /c "${setFosterHome}ping -n ${pingCount} 127.0.0.1 >nul & ` +
    `echo ==== ${stamp} start: ${argsForLog} >> ${quotedLog} & ` +
    `${runLine} >> ${quotedLog} 2>&1 & ` +
    `echo ==== end >> ${quotedLog}"`;

  const vbsText = buildVbsText({ stamp, logPath, cmdLine, version, now: nowValue });
  const commandLine = `wscript.exe ${quoteForCmd(vbsPath)}`;

  return { vbsPath, logPath, vbsText, commandLine, argv: cleanArgv, delaySeconds };
}

export interface DetachLaunchResult {
  pid: number;
  via: 'PowerShell' | 'wmic';
}

export interface LaunchDetachedDeps {
  /** Injected in every test — the whole point of this seam is that nothing real ever launches. */
  launch?: (commandLine: string, env: NodeJS.ProcessEnv) => DetachLaunchResult;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

const CREATE_TIMEOUT_MS = 20_000;

function parseInvokeCimPid(stdout: string): number | undefined {
  const match = /(?:^|\D)(\d+)\s*$/.exec(stdout.trim());
  return match ? Number(match[1]) : undefined;
}

function parseWmicCreatePid(stdout: string): number | undefined {
  const match = /ProcessId\s*=\s*(\d+)/.exec(stdout);
  return match ? Number(match[1]) : undefined;
}

/**
 * The default launcher: PowerShell's `Invoke-CimMethod ... Win32_Process Create`
 * first, `wmic process call create` if that fails — the same order and the same
 * reason `readProcesses` falls back (`src/util/processes.ts`): PowerShell can
 * hang at start-up on this machine rather than fail quickly. `run` is the same
 * `CommandRunner` seam `src/util/processes.ts` tests inject, so this fallback is
 * exercised without ever spawning PowerShell or wmic for real.
 */
export function launchWithFallback(
  commandLine: string,
  env: NodeJS.ProcessEnv = process.env,
  run: CommandRunner = execFileSyncRunner,
): DetachLaunchResult {
  const escapedForPs = commandLine.replace(/'/g, "''");
  const psScript =
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments ` +
    `@{CommandLine='${escapedForPs}'}; ` +
    `if ($result.ReturnValue -ne 0) { Write-Error "ReturnValue $($result.ReturnValue)"; exit 1 }; ` +
    `Write-Output $result.ProcessId`;
  const psExe = systemExePath('WindowsPowerShell\\v1.0\\powershell.exe', env);
  const psOutcome = run(psExe, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    timeoutMs: CREATE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  const psFailure: string[] = [];
  if (psOutcome.ok) {
    const pid = parseInvokeCimPid(psOutcome.stdout);
    if (pid !== undefined) return { pid, via: 'PowerShell' };
    psFailure.push(`PowerShell ran but reported no pid: ${psOutcome.stdout.trim() || '(empty)'}`);
  } else {
    psFailure.push(
      `PowerShell ${psOutcome.reason}${psOutcome.detail ? `: ${psOutcome.detail}` : ''}`,
    );
  }

  const wmicExe = systemExePath('wbem\\wmic.exe', env);
  const wmicOutcome = run(wmicExe, ['process', 'call', 'create', commandLine], {
    timeoutMs: CREATE_TIMEOUT_MS,
    encoding: 'latin1',
  });
  if (wmicOutcome.ok) {
    const pid = parseWmicCreatePid(wmicOutcome.stdout);
    if (pid !== undefined) return { pid, via: 'wmic' };
    psFailure.push(`wmic ran but reported no pid: ${wmicOutcome.stdout.trim() || '(empty)'}`);
  } else {
    psFailure.push(
      `wmic ${wmicOutcome.reason}${wmicOutcome.detail ? `: ${wmicOutcome.detail}` : ''}`,
    );
  }

  throw new Error(`Could not launch the detached process.\n  ${psFailure.join('\n  ')}`);
}

/**
 * Writes the `.vbs` and launches it, outside the app's process tree. Windows
 * only — there is no WMI, and nothing this whole mechanism exists for, anywhere
 * else. `deps.launch` is what every test injects instead of this reaching a real
 * PowerShell or wmic; production never sets it.
 */
export function launchDetached(
  plan: DetachedPlan,
  deps: LaunchDetachedDeps = {},
): DetachLaunchResult {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error('--detach is Windows-only.');
  }
  const env = deps.env ?? process.env;
  mkdirSync(path.dirname(plan.vbsPath), { recursive: true });
  writeFileSync(plan.vbsPath, plan.vbsText, 'utf8');
  const launch =
    deps.launch ??
    ((commandLine: string, e: NodeJS.ProcessEnv) => launchWithFallback(commandLine, e));
  return launch(plan.commandLine, env);
}

/**
 * The live writers a restart would end, minus the session foster is itself
 * running in — `foster detach` refuses on a non-empty result the same way
 * `live --stop` refuses to end its own host, for the same reason: ending the
 * app takes every session it hosts with it, silently, and there is no undo.
 */
export function otherLiveWriters(
  sessions: LiveCliSession[],
  env: NodeJS.ProcessEnv = process.env,
  hostedBySelf: (pid: number) => boolean = () => false,
): LiveCliSession[] {
  return sessions.filter((session) => !isSelfSession(session, env) && !hostedBySelf(session.pid));
}

/** `isSelfHostedBy` bound to a single process-table read, the way `writers.ts`'s `stopWriters` uses it. */
export function selfHostedCheck(
  rows: ProcessRow[],
  selfPid: number = process.pid,
): (pid: number) => boolean {
  return (pid: number) => isSelfHostedBy(pid, () => rows, selfPid);
}

function writerLines(others: LiveCliSession[]): string {
  return others
    .map((session) => `  ${session.pid}  ${session.cwd ?? session.sessionId}`)
    .join('\n');
}

/** The line `--detach`'s refusal names the writers with. */
export function liveWritersRefusal(others: LiveCliSession[]): string {
  return (
    `Restarting the app would end these sessions: no way to warn them first, and no undo:\n` +
    `${writerLines(others)}\n` +
    'Close them yourself, or re-run with --detach-even-with-live.'
  );
}

/** The same writers, named once `--detach-even-with-live` has said to go ahead anyway. */
export function liveWritersEnding(others: LiveCliSession[]): string {
  return `The restart will also end these sessions (--detach-even-with-live):\n${writerLines(others)}`;
}

/** `--detach` without a restart on the way is pointless; refuse with the reason, or say nothing. */
export function detachNeedsRestart(input: {
  detach: boolean;
  restart: boolean;
  isRestartItself: boolean;
}): string | undefined {
  if (!input.detach) return undefined;
  if (input.restart || input.isRestartItself) return undefined;
  return '--detach only means something together with a restart: add --restart (or run it on app restart).';
}

/** `layout`/`view` refuse a detached dry run — there would be nothing to apply once it fires. */
export function detachNeedsYes(input: { detach: boolean; yes: boolean }): string | undefined {
  if (!input.detach) return undefined;
  if (input.yes) return undefined;
  return 'A detached run with nothing to write is pointless: --detach needs --yes too.';
}

/**
 * `--detach` is a no-op with the tray enabled — the app's default — unless the
 * re-run it launches can actually end the process.
 *
 * The detached process re-runs the same command from outside the app, which
 * eventually calls `quitDesktop` the ordinary way: with the tray on,
 * `closingWindowQuits` is false, and `quitDesktop` without `terminate` returns
 * `needs-terminate` rather than closing anything (`src/engine/desktop.ts`).
 * Nothing after that ever runs — the write this restart existed for, the start
 * that would bring the app back — and the only trace is a `.log` nobody is
 * watching. Refusing here, before the `.vbs` is even written, is cheaper than a
 * wasted wait. Checked directly against this machine's own default
 * installation 24/09/2026: `menuBarEnabled` is unset there — absent means the
 * app default, tray **on** — so `--detach` alone was silently broken on the
 * very machine this codebase is developed on; only a profile that had
 * explicitly turned the tray off would ever have seen it work.
 *
 * `--terminate` is not stripped by `stripDetachFlags` — only `app restart`
 * accepts it, but once it is on the command line it rides straight through to
 * the re-run, so the fix here is to ask for it rather than to invent a way to
 * add it to commands that were never given one.
 */
export function detachNeedsTerminate(input: {
  closingWindowQuits: boolean;
  argv: string[];
}): string | undefined {
  if (input.closingWindowQuits) return undefined;
  if (stripDetachFlags(input.argv).includes('--terminate')) return undefined;
  const isAppRestart = input.argv[0] === 'app' && input.argv[1] === 'restart';
  return (
    'Claude Desktop keeps a tray icon here: closing its window only hides it, so a detached ' +
    'restart would run, find the app still up, and finish nothing.\n' +
    (isAppRestart
      ? 'Add --terminate as well, to end the process instead of asking it to close.'
      : 'Only "foster app restart" can end it outright — close Claude Desktop yourself first, ' +
        'then re-run this, or run "foster app restart --detach --terminate" instead.')
  );
}

export const DETACH_DELAY_DEFAULT = 20;
export const DETACH_DELAY_MIN = 5;
export const DETACH_DELAY_MAX = 300;

/** `--detach-delay`, parsed and range-checked — commander hands this the raw string, or nothing. */
export function parseDetachDelay(raw: string | undefined): number | { error: string } {
  if (raw === undefined) return DETACH_DELAY_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { error: `--detach-delay wants a whole number of seconds, not "${raw}".` };
  }
  if (value < DETACH_DELAY_MIN || value > DETACH_DELAY_MAX) {
    return {
      error: `--detach-delay must be between ${DETACH_DELAY_MIN} and ${DETACH_DELAY_MAX} seconds, got ${value}.`,
    };
  }
  return value;
}

/**
 * What a sweep's own restart carries into the command it hands over or detaches
 * to: the global options that picked this installation and ledger out of every
 * other one, plus the exact account the sweep just wrote into.
 */
export interface SweepRestartCarry {
  store?: string;
  ledger?: string;
  /** The resolved target's own uuids — spelled out, not left to default, the
   *  same reasoning as `viewCopyRestartCommand`: a command run later, after
   *  whatever is signed in has changed, must still land on the account this
   *  sweep actually wrote. Only meaningful (and only added) when the handed-
   *  over command is `layout`, which is the only one of the two that takes a
   *  destination at all. */
  to?: string;
  toOrg?: string;
}

/**
 * Sweep's own choice between the two commands it can hand over, reused for what
 * it detaches.
 *
 * Built from scratch until this fixed it (measured 24/09/2026): `foster --store
 * work sweep --yes --restart --detach` handed the detached process a bare
 * `['layout', '--yes', '--restart']` or `['app', 'restart']`, with no `--store`
 * at all — so the restart it actually ran landed on the *default* installation,
 * silently, while the sweep itself had written into `work`. `carry` is what a
 * sweep read off its own global options and its own resolved target; it is
 * threaded through unconditionally rather than only when `--store`/`--to` were
 * given, because the account signed in when the detached process finally runs
 * — minutes later, after the app has quit and started again — is not
 * guaranteed to be the one that was current when the sweep ran.
 */
export function sweepDetachArgv(layoutPending: boolean, carry: SweepRestartCarry = {}): string[] {
  const global: string[] = [];
  if (carry.store) global.push('--store', carry.store);
  if (carry.ledger) global.push('--ledger', carry.ledger);
  if (!layoutPending) return [...global, 'app', 'restart'];
  const destination: string[] = [];
  if (carry.to) destination.push('--to', carry.to);
  if (carry.toOrg) destination.push('--to-org', carry.toOrg);
  return [...global, 'layout', '--yes', '--restart', ...destination];
}

// ---------------------------------------------------------------------------
// `foster detached` — listing runs already launched.
// ---------------------------------------------------------------------------

export type DetachedRunStatus = 'pending' | 'running' | 'done';

export interface DetachedRun {
  /** `<stamp>-<verb>`, the shared basename of the `.vbs` and `.log`. */
  id: string;
  vbsPath: string;
  logPath: string;
  status: DetachedRunStatus;
  /** The `.vbs` file's own mtime — used only to order runs newest first. */
  at?: number;
  /** The log's full text, when it exists. */
  log?: string;
}

/** Read from the log alone: no "start" line is `pending`, a "start" with no "end" is `running`. */
export function detachedRunStatus(log: string | undefined): DetachedRunStatus {
  if (log === undefined || !/^==== .*start:/m.test(log)) return 'pending';
  if (/^==== end\s*$/m.test(log)) return 'done';
  return 'running';
}

/** Every run under `<FOSTER_HOME>/detached`, newest first. */
export function listDetachedRuns(env: NodeJS.ProcessEnv = process.env): DetachedRun[] {
  const dir = detachedDir(env);
  const runs: DetachedRun[] = [];
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith('.vbs')) continue;
    const id = file.slice(0, -'.vbs'.length);
    const vbsPath = path.join(dir, file);
    const logPath = path.join(dir, `${id}.log`);
    let at: number | undefined;
    try {
      at = statSync(vbsPath).mtimeMs;
    } catch {
      // Gone between the readdir and here; still worth reporting with no order.
    }
    const log = fileExists(logPath) ? readFileSync(logPath, 'utf8') : undefined;
    runs.push({ id, vbsPath, logPath, status: detachedRunStatus(log), at, log });
  }
  return runs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The last N lines of a log, for the non-`--last` listing. `--last` prints `run.log` whole instead. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

/** Which VBS built-in a test failure names, if any of this module's own variable names collide. */
export function vbsBuiltinCollision(names: readonly string[]): string | undefined {
  return names.find((name) => VBS_BUILTINS.has(name.toLowerCase()));
}
