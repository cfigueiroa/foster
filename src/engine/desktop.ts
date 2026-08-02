import { execFileSync, spawn } from 'node:child_process';
import type { StoreLayout } from '../domain/types.js';
import { closingWindowQuits } from '../store/config.js';
import { lockfileHeld } from './lockfile.js';

/**
 * Closing and reopening Claude Desktop.
 *
 * The sidebar is built once, when the app initialises its session store, so a
 * change on disk is only visible after the app goes through that again. Telling
 * the user to do it by hand was never the interesting part of the job, so foster
 * does it — with two hard rules:
 *
 *  - it never closes an app it is running inside, because the Code session
 *    driving foster is a child of that app and would be killed mid-write;
 *  - it asks the app to quit rather than terminating it, so the app runs its own
 *    shutdown (flushing pending session writes, warning about work in progress).
 *    Terminating is available, but only as an explicit escalation.
 */

/** One row of the process table, reduced to what the decisions here need. */
export interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  /** Empty when the path could not be read, which is normal for other users' processes. */
  path: string;
  /** The full command line, which is where a profile's --user-data-dir shows up. */
  commandLine: string;
  /** Epoch milliseconds, or undefined when the creation time was unavailable. */
  startedAt?: number;
}

export type ProcessLister = () => ProcessRow[];

const POWERSHELL_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,' +
  'CommandLine,' +
  "@{n='Started';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | " +
  'ConvertTo-Csv -NoTypeInformation';

/**
 * The process table, with parent links.
 *
 * `tasklist` cannot report a parent pid, and the parent link is what separates
 * the app's main process from its dozen helpers — and what tells foster whether
 * it is itself running inside the app. Windows PowerShell 5.1 ships with every
 * supported Windows, so this needs nothing installed.
 */
export function readProcesses(): ProcessRow[] {
  if (process.platform !== 'win32') return [];
  let csv: string;
  try {
    csv = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_QUERY],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    );
  } catch {
    return [];
  }
  return parseProcessCsv(csv);
}

/** Exported for tests: the parser is the part with edge cases, not the spawn. */
export function parseProcessCsv(csv: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  // The first line is the header; ConvertTo-Csv quotes every field.
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    if (fields.length < 4) continue;
    // Number('') is 0, not NaN, so an empty field would otherwise become a
    // process with pid 0 — and pid 0 is a plausible-looking parent link.
    const pid = fields[0]?.trim() ? Number(fields[0]) : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const started = fields[5] ? Date.parse(fields[5]) : Number.NaN;
    rows.push({
      pid,
      parentPid: Number(fields[1]) || 0,
      name: fields[2] ?? '',
      path: fields[3] ?? '',
      commandLine: fields[4] ?? '',
      ...(Number.isFinite(started) ? { startedAt: started } : {}),
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      // A doubled quote inside a quoted field is a literal quote.
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields;
}

/**
 * Both the desktop app and the Code CLI it spawns are called claude.exe. Only
 * the path tells them apart, and only the CLI lives under a claude-code
 * directory.
 */
function isDesktopProcess(row: ProcessRow): boolean {
  return row.name.toLowerCase() === 'claude.exe' && !isCodeCliProcess(row);
}

function isCodeCliProcess(row: ProcessRow): boolean {
  return (
    row.name.toLowerCase() === 'claude.exe' && row.path.toLowerCase().includes('\\claude-code\\')
  );
}

export interface DesktopState {
  running: boolean;
  /** The process owning the window; the one to ask to quit. */
  mainPid?: number;
  /** When the app started, used to reason about what it has already loaded. */
  startedAt?: number;
  /** Claude Code sessions the app is hosting; quitting interrupts every one. */
  codeSessions: number;
  /**
   * True when foster is a descendant of the app. Quitting would kill the process
   * asking for it, part-way through whatever it was doing.
   */
  selfHosted: boolean;
}

/**
 * The userData directory of every running instance.
 *
 * A second profile can be started either by environment variable or by the
 * `--user-data-dir` switch, and only the first is visible to a process that did
 * not launch it. Electron passes the switch down to every child, so the running
 * processes themselves are the one place both spellings show up — which makes
 * this the only way to tell someone what to point `--store` at.
 */
export function runningStores(list: ProcessLister = readProcesses): string[] {
  const dirs = new Set<string>();
  for (const row of list()) {
    if (row.name.toLowerCase() !== 'claude.exe') continue;
    const match = /--user-data-dir="?([^"]+?)"?(?:\s|$)/.exec(row.commandLine);
    if (match?.[1]) dirs.add(match[1]);
  }
  return [...dirs];
}

/**
 * Whether this process was spawned by a Code session inside the app.
 *
 * The app stamps the session it hosts into the environment of the CLI it starts,
 * and every descendant inherits it — so this survives where the parent chain does
 * not. It has to: an intermediate process that has already exited breaks the
 * chain, leaving foster looking like an unrelated program that is free to close
 * the app it is in fact running inside. Observed once, and once is enough for a
 * check whose failure mode is killing the caller.
 */
export function hostedByDesktop(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLAUDE_CODE_HOST_SESSION_ID);
}

export function inspectDesktop(
  list: ProcessLister = readProcesses,
  env: NodeJS.ProcessEnv = process.env,
): DesktopState {
  const rows = list();
  const desktop = rows.filter(isDesktopProcess);

  if (desktop.length === 0) {
    return { running: false, codeSessions: 0, selfHosted: hostedByDesktop(env) };
  }

  const desktopPids = new Set(desktop.map((row) => row.pid));
  // The main process is the one nothing else in the app spawned; its helpers all
  // descend from it.
  const main = desktop.find((row) => !desktopPids.has(row.parentPid)) ?? desktop[0]!;

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const codeSessions = rows.filter(
    (row) => isCodeCliProcess(row) && descendsFrom(row, main.pid, byPid),
  ).length;

  const self = byPid.get(process.pid);
  const selfHosted = hostedByDesktop(env) || (self ? descendsFrom(self, main.pid, byPid) : false);

  return {
    running: true,
    mainPid: main.pid,
    ...(main.startedAt !== undefined ? { startedAt: main.startedAt } : {}),
    codeSessions,
    selfHosted,
  };
}

/** Walks the parent chain, bounded so a cycle in a stale snapshot cannot hang. */
function descendsFrom(
  row: ProcessRow,
  ancestorPid: number,
  byPid: Map<number, ProcessRow>,
): boolean {
  let current: ProcessRow | undefined = row;
  for (let depth = 0; current && depth < 64; depth++) {
    if (current.pid === ancestorPid) return true;
    const parent: ProcessRow | undefined = byPid.get(current.parentPid);
    // A recycled pid can point at a process younger than its supposed child.
    if (parent && current.startedAt !== undefined && parent.startedAt !== undefined) {
      if (parent.startedAt > current.startedAt) return false;
    }
    current = parent;
  }
  return false;
}

/**
 * The identifier that launches the packaged app.
 *
 * Claude Desktop ships as an MSIX package, whose executable lives under a
 * protected directory and is meant to be activated through the shell rather than
 * run directly. The package family name is already part of the store path foster
 * resolved, so it is derived rather than hardcoded — the publisher hash is stable
 * across machines, but the store path is the thing actually verified to exist.
 */
export function packagedAppId(store: StoreLayout): string | undefined {
  const match = /[\\/]Packages[\\/]([^\\/]+)/i.exec(store.root);
  if (!match) return undefined;
  const family = match[1]!;
  const application = family.split('_')[0];
  if (!application) return undefined;
  return `${family}!${application}`;
}

export class DesktopControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopControlError';
  }
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. EPERM means the process exists but belongs to someone else.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export interface QuitOptions {
  /** How long to wait for the app to shut itself down. */
  timeoutMs?: number;
  /**
   * End the process rather than asking. Required whenever the tray is on, which
   * is the default — see quitDesktop.
   */
  terminate?: boolean;
  list?: ProcessLister;
  /** Injectable for tests: the suite itself runs inside a hosted session. */
  env?: NodeJS.ProcessEnv;
}

export type QuitResult =
  /** The app is gone. */
  | { outcome: 'quit' }
  /** It was not running to begin with. */
  | { outcome: 'not-running' }
  /**
   * Nothing was done, because asking would not have worked: this app keeps
   * running in the tray, so closing its window only hides it. Ending the process
   * is the only way, and that needs saying out loud rather than doing quietly.
   */
  | { outcome: 'needs-terminate'; mainPid: number }
  /** It was asked to close and is still up. */
  | { outcome: 'still-running'; mainPid: number };

/**
 * Close Claude Desktop.
 *
 * There are two worlds here, and which one you are in is a setting.
 *
 * With the tray **off**, the main window's close handler quits the app, so
 * `taskkill` without /F — which posts WM_CLOSE, exactly what the close button
 * does — shuts it down through its own path: pending session writes are flushed
 * and Cowork sandboxes are stopped.
 *
 * With the tray **on**, which is the default, that same handler cancels the close
 * and hides the window. Posting WM_CLOSE would make the user's window disappear
 * and change nothing else, so this does not send it at all. The only way out is
 * to end the process, which is offered as an explicit answer rather than a silent
 * escalation: it skips the app's own shutdown.
 *
 * Ending the process cannot corrupt a session file — the app writes through a
 * temporary and renames — but it can lose a metadata update from the last few
 * seconds, and Cowork sandboxes do not get stopped cleanly.
 */
export async function quitDesktop(
  store: StoreLayout,
  options: QuitOptions = {},
): Promise<QuitResult> {
  const { timeoutMs = 30_000, terminate = false, list = readProcesses, env } = options;
  const state = inspectDesktop(list, env);

  if (!state.running || state.mainPid === undefined) return { outcome: 'not-running' };
  if (state.selfHosted) {
    throw new DesktopControlError(
      'foster is running inside Claude Desktop, so closing the app would kill this session part-way through.\n' +
        'Run foster from a terminal outside the app, or quit the app yourself.',
    );
  }

  const pid = state.mainPid;
  const asking = closingWindowQuits(store);
  if (!asking && !terminate) return { outcome: 'needs-terminate', mainPid: pid };

  if (terminate) {
    // The app saves on a trailing debounce of up to three seconds. Waiting that
    // out first turns "probably lost the last edit" into "probably did not",
    // which is cheap at this point — the user has already decided to close it.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    taskkill(['/F', '/T', '/PID', String(pid)]);
  } else {
    taskkill(['/PID', String(pid)]);
  }

  // The lockfile is held for as long as the app runs and is released on exit, so
  // it corroborates the pid check — a recycled pid cannot fake it.
  const gone = await waitFor(() => !processAlive(pid) && !lockfileHeld(store), timeoutMs);
  return gone ? { outcome: 'quit' } : { outcome: 'still-running', mainPid: pid };
}

/** Long enough to outlast the app's save debounce (1s idle, 3s while running). */
const SETTLE_MS = 3_500;

function taskkill(args: string[]): void {
  try {
    execFileSync('taskkill', args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  } catch (error) {
    // taskkill exits non-zero when a process has no window to close, which is
    // expected here: the wait below decides the outcome, not the exit code.
    void error;
  }
}

export interface StartOptions {
  timeoutMs?: number;
  /** Injectable so tests never launch anything. */
  launch?: (appId: string) => void;
}

/**
 * Start the app and wait until it has taken the store.
 *
 * Waiting matters: the point of starting it is that the sidebar gets rebuilt, and
 * returning before that has happened would report success for work still in
 * flight.
 */
export async function startDesktop(
  store: StoreLayout,
  options: StartOptions = {},
): Promise<boolean> {
  const { timeoutMs = 60_000, launch = launchPackagedApp } = options;
  const appId = packagedAppId(store);
  if (!appId) {
    throw new DesktopControlError(
      'Could not work out how to start Claude Desktop: this store is not inside an installed app\n' +
        'package. A store reached through CLAUDE_USER_DATA_DIR is a separate profile, and only\n' +
        'whatever launched it knows how. Start it yourself; everything else still works.',
    );
  }

  launch(appId);
  return waitFor(() => lockfileHeld(store), timeoutMs, 500);
}

function launchPackagedApp(appId: string): void {
  // Explorer is the documented way to activate a packaged application by its
  // model id from a plain process; the executable itself sits in a directory
  // ordinary users may not run from.
  const child = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
