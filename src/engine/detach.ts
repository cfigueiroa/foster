import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isSelfHostedBy, isSelfSession, type LiveCliSession } from '../store/liveSessions.js';
import {
  execFileSyncRunner,
  readProcesses,
  systemExePath,
  type CommandRunner,
  type ProcessLister,
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
function stripDetachFlags(argv: string[]): string[] {
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

  const dir = detachedDir(env);
  const nowValue = now();
  const stamp = freshStamp(dir, localStamp(nowValue), verbOf(cleanArgv));
  const verb = verbOf(cleanArgv);
  const vbsPath = path.join(dir, `${stamp}-${verb}.vbs`);
  const logPath = path.join(dir, `${stamp}-${verb}.log`);

  // `cleanArgv` above is checked because it comes from whoever invoked
  // `foster ... --detach`; these three come from the machine's own
  // environment and this build's own paths (`logPath` folds in `FOSTER_HOME`;
  // `execPath` and `scriptPath` are `process.execPath` and `process.argv[1]`)
  // — no less able to carry a `%` or a `"` that would break the cmd.exe
  // compound line this builds. A `%` in `FOSTER_HOME` passed silently before
  // this check existed.
  for (const [name, value] of [
    ['the log path (FOSTER_HOME)', logPath],
    ['the node executable path', execPath],
    ['the running script path', scriptPath],
  ] as const) {
    if (CMD_UNSAFE.test(value)) {
      throw new Error(
        `--detach cannot run: ${name} contains a character the cmd.exe line would misread: ` +
          `${JSON.stringify(value)}.`,
      );
    }
  }

  const pingCount = delaySeconds + 1;
  const quotedLog = quoteForCmd(logPath);
  const quotedExec = quoteForCmd(execPath);
  const quotedScript = quoteForCmd(scriptPath);
  const argsForLog = cleanArgv.join(' ');
  const argsForRun = cleanArgv.map(quoteForCmd).join(' ');
  const runLine = argsForRun
    ? `${quotedExec} ${quotedScript} ${argsForRun}`
    : `${quotedExec} ${quotedScript}`;

  const cmdLine =
    `cmd.exe /c "ping -n ${pingCount} 127.0.0.1 >nul & ` +
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
 * A `wscript.exe` already running the exact `.vbs` this `commandLine`
 * (`wscript.exe "<vbsPath>"`) names — from the process table `launchWithFallback`
 * below is given.
 *
 * `Invoke-CimMethod ... Create` submits the request to WMI and the process it
 * creates lives independently of the PowerShell client that asked for it: a
 * client that times out waiting for the reply does not undo a `Create` that
 * had already gone through by the time the timeout fired. Falling straight to
 * the `wmic` fallback on that timeout, as this used to unconditionally,
 * risked launching a SECOND detached process — two quit/restart cycles, the
 * first one started by the call this treated as failed. Checked only when
 * `launchWithFallback` actually asks (a PowerShell timeout, never a `missing`
 * or outright `failed` result, which never got far enough to plausibly have
 * submitted anything).
 */
function findLaunchedWscript(commandLine: string, rows: ProcessRow[]): ProcessRow | undefined {
  const vbsPath = /"([^"]+)"/.exec(commandLine)?.[1];
  if (!vbsPath) return undefined;
  return rows.find(
    (row) => row.name.toLowerCase() === 'wscript.exe' && row.commandLine.includes(vbsPath),
  );
}

/**
 * The default launcher: PowerShell's `Invoke-CimMethod ... Win32_Process Create`
 * first, `wmic process call create` if that fails — the same order and the same
 * reason `readProcesses` falls back (`src/util/processes.ts`): PowerShell can
 * hang at start-up on this machine rather than fail quickly. `run` is the same
 * `CommandRunner` seam `src/util/processes.ts` tests inject, so this fallback is
 * exercised without ever spawning PowerShell or wmic for real. `list` is the
 * same seam for the process-table check a timeout triggers, below.
 */
export function launchWithFallback(
  commandLine: string,
  env: NodeJS.ProcessEnv = process.env,
  run: CommandRunner = execFileSyncRunner,
  list: ProcessLister = readProcesses,
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
    if (psOutcome.reason === 'timeout') {
      const already = findLaunchedWscript(commandLine, list());
      if (already) return { pid: already.pid, via: 'PowerShell' };
    }
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
  // wscript.exe reads a .vbs with no byte-order mark as the system's ANSI code
  // page, not UTF-8 — a non-ASCII FOSTER_HOME or node install path (the same
  // "ô" case util/processes.ts measures) silently breaks the script with no
  // log line at all, because the corruption is in the very first statements
  // that would open the log. UTF-16LE with a BOM is what wscript recognises
  // unambiguously; `'\uFEFF' + text` encoded as 'utf16le' writes the BOM as
  // its own correct little-endian bytes (FF FE), not the UTF-8 spelling of it.
  writeFileSync(plan.vbsPath, `\uFEFF${plan.vbsText}`, 'utf16le');
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

/** Sweep's own choice between the two commands it can hand over, reused for what it detaches. */
export function sweepDetachArgv(layoutPending: boolean): string[] {
  return layoutPending ? ['layout', '--yes', '--restart'] : ['app', 'restart'];
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
