import { execFileSync, spawn } from 'node:child_process';
import type { StoreLayout } from '../domain/types.js';
import {
  candidateStoreRoots,
  comparableUserDataDir,
  storeHoldsSession,
  storeIdentity,
  type StoreIdentity,
} from '../domain/paths.js';
import { closingWindowQuits } from '../store/config.js';
import {
  isCodeCliProcess,
  parseProcessCsv,
  partialTable,
  readProcesses,
  regExePath,
  type ProcessLister,
  type ProcessRow,
} from '../util/processes.js';
import { lockfileHeld } from './lockfile.js';
import { scrubbedEnv } from './launchEnv.js';

export { parseProcessCsv, readProcesses, type ProcessLister, type ProcessRow };

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

/**
 * Both the desktop app and the Code CLI it spawns are called claude.exe. Only
 * the path tells them apart, and only the CLI lives under a claude-code
 * directory. The separation itself lives in util/processes: the session registry
 * asks the same question of a pid, and must not import desktop control to do it.
 *
 * A row whose path could not be read is *not* the app. That is the whole point:
 * the path is the only evidence, so without it "not a CLI" is an absence rather
 * than a finding — and a claude.exe launched by another tool, or by a user whose
 * processes this one cannot read, arrives here looking exactly like the app.
 * Treating it as the app put a stranger's pid in front of `taskkill /F /T`, which
 * killed it and left the real app running to report "still running". Requiring
 * proof costs at most a manual restart when the app's own path is unreadable;
 * the other way round ends someone else's process.
 *
 * "Not the CLI" alone is not enough, either. A standalone `claude.exe` — a
 * `~/.local/bin/claude.exe` run from a terminal, never installed as the app at
 * all — is not under `\claude-code\` and so passed every check above, which is
 * exactly the failure this function exists to close: with the app closed, a
 * machine carrying a dozen such CLIs turned every one of them into an orphaned
 * `desktop` row, and the tie-break in `inspectDesktop` handed `taskkill /F /T`
 * whichever was oldest. So absence of proof that a row is the CLI no longer
 * qualifies it; presence of proof that it is the app does. Two are cheap and
 * available without spawning anything new: its path sits under a store root
 * this environment already knows about (`candidateStoreRoots`, or the MSIX
 * package directory itself — a fresh install without a `claude-code-sessions`
 * folder yet still lives under `\Packages\Claude...`), or it has at least one
 * child carrying `--type=`, which only Electron's own helpers ever do. Without
 * either, the row is a stranger and stays out of `DesktopState` — same rule
 * `util/processes.ts` already argues in prose for the CLI side of this line.
 */
function isDesktopProcess(row: ProcessRow, rows: ProcessRow[], env: NodeJS.ProcessEnv): boolean {
  if (row.name.toLowerCase() !== 'claude.exe') return false;
  if (row.path === '') return false;
  if (isCodeCliProcess(row)) return false;
  return hasProofOfBeingTheApp(row, rows, env);
}

/** A path under a store root this environment already knows about. */
function underKnownStoreRoot(candidatePath: string, env: NodeJS.ProcessEnv): boolean {
  const candidate = comparableUserDataDir(candidatePath);
  return candidateStoreRoots(env).some((root) => {
    const known = comparableUserDataDir(root);
    return candidate === known || candidate.startsWith(`${known}\\`);
  });
}

/** A path under the MSIX package directory, whoever's family folder it is. */
function underAppPackageDirectory(candidatePath: string): boolean {
  return /[\\/]Packages[\\/]Claude/i.test(candidatePath);
}

/** Whether some other row is a child of this one and carries an Electron `--type=`. */
function hasTypedHelperChild(row: ProcessRow, rows: ProcessRow[]): boolean {
  return rows.some(
    (other) =>
      other.parentPid === row.pid &&
      other.name.toLowerCase() === 'claude.exe' &&
      /--type=/.test(other.commandLine),
  );
}

function hasProofOfBeingTheApp(
  row: ProcessRow,
  rows: ProcessRow[],
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    underKnownStoreRoot(row.path, env) ||
    underAppPackageDirectory(row.path) ||
    hasTypedHelperChild(row, rows)
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
  /**
   * Set when the process table could not tell the app from a Claude Code
   * session; `running` is then false for want of proof, not because the app is
   * absent. Only a partial table (tasklist: no paths, parents or command lines)
   * can produce this — a full table always has enough evidence to say either
   * way — and only when there is something to be uncertain about at all: a
   * `claude.exe` row it cannot attribute. A partial table with no `claude.exe`
   * anywhere is a certain "not running", because a name is proof enough of
   * absence even when it proves nothing about identity.
   */
  uncertain?: string;
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
    // A partial row (tasklist) has no command line at all, so `--user-data-dir`
    // can never be read out of it — skipped explicitly rather than relying on
    // the empty string to fail the match below, so a reader added later that
    // happens to leave `commandLine` non-empty on a partial row cannot silently
    // start attributing profiles it has no evidence for.
    if (row.partial) continue;
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

/**
 * The instance running one particular store.
 *
 * With two profiles up there are two main processes, and "is the app running"
 * stops being a single question. Anything reasoning about a specific store — such
 * as whether a copy in it is held in memory — has to ask about that store's
 * instance, not whichever one happens to be found first.
 */
export function inspectDesktopFor(
  identity: StoreIdentity,
  list: ProcessLister = readProcesses,
  env: NodeJS.ProcessEnv = process.env,
): DesktopState {
  const wanted = identity.roots.map(comparableUserDataDir);
  const allRows = list();

  // A partial table (tasklist) carries no command line, so every claude.exe on
  // it would fail the --user-data-dir match below and land on the switchless
  // rule — attributing it to the default installation and turning a profile
  // store's "cannot tell" into a confident, wrong "not running". Keeping every
  // row instead of filtering lets inspectDesktop's own partial-table handling
  // see every claude.exe there is, so the uncertain note it produces reaches
  // this store too instead of the filter silently deciding the question first.
  const rows = partialTable(allRows)
    ? allRows
    : allRows.filter((row) => {
        // Everything that is not the app stays: the ancestry walk needs those rows to
        // work out whether foster is running inside the instance.
        if (row.name.toLowerCase() !== 'claude.exe') return true;
        const match = /--user-data-dir="?([^"]+?)"?(?:\s|$)/.exec(row.commandLine);
        // A switchless process belongs to the default installation, and only to it.
        if (!match?.[1]) return identity.isDefault;
        return wanted.includes(comparableUserDataDir(match[1]));
      });

  // Ancestry is already scoped — the rows above are this instance's — so only the
  // environment marker still needs narrowing to this store.
  const scoped = hostedElsewhere(identity, env, list)
    ? { ...env, CLAUDE_CODE_HOST_SESSION_ID: undefined }
    : env;

  return inspectDesktop(() => rows, scoped);
}

/**
 * Whether the app hosting foster is a different installation from this one.
 *
 * The hosted-session marker says foster is inside *an* instance; it does not say
 * which. Left global it made every store refuse — `--store <profile> app restart`
 * declined to close a profile that foster was demonstrably not running inside,
 * from a session hosted by the default app.
 *
 * The instance that stamped the marker is the one holding that session file, so
 * the file settles it. When no store holds it — deleted mid-session, say — this
 * says nothing and the refusal stands: over-refusing costs a manual restart,
 * while under-refusing kills the caller.
 *
 * A partial table (tasklist) makes `runningStores` below name nothing at all —
 * it has no command lines to read a profile out of — so on a partial table this
 * can only ever find the environment marker's own store, never "some other
 * store the marker might belong to". The refusal stands in that case too, for
 * the same reason: it is the safe side, and unchanged by what caused it.
 */
function hostedElsewhere(
  identity: StoreIdentity,
  env: NodeJS.ProcessEnv,
  list: ProcessLister,
): boolean {
  const hosted = env.CLAUDE_CODE_HOST_SESSION_ID;
  if (!hosted) return false;
  if (identity.roots.some((root) => storeHoldsSession(root, hosted))) return false;
  // Every other store there is: the installations this environment knows about,
  // plus the profiles only their own command lines name.
  const others = [...candidateStoreRoots(env), ...runningStores(list)];
  return others.some((root) => storeHoldsSession(root, hosted));
}

export function inspectDesktop(
  list: ProcessLister = readProcesses,
  env: NodeJS.ProcessEnv = process.env,
): DesktopState {
  const rows = list();
  const desktop = rows.filter((row) => isDesktopProcess(row, rows, env));

  if (desktop.length === 0) {
    // isDesktopProcess demands a readable path, so a partial table (tasklist)
    // never passes it — every claude.exe on one looks exactly like a stranger.
    // A claude.exe that could not be attributed is not evidence the app is
    // absent; it is evidence foster cannot currently tell. The asymmetry below
    // matters: a partial table with NO claude.exe at all still says "not
    // running" with no note, because a name is proof enough of absence — it is
    // only the identity question, "which claude.exe is this", that a partial
    // table cannot answer.
    const claudeCount = partialTable(rows)
      ? rows.filter((row) => row.name.toLowerCase() === 'claude.exe').length
      : 0;
    if (claudeCount > 0) {
      return {
        running: false,
        codeSessions: 0,
        selfHosted: hostedByDesktop(env),
        uncertain:
          `${claudeCount} claude.exe process(es) are running, but the process table was read ` +
          'through tasklist, which reports no paths, parent links or command lines — foster ' +
          'cannot tell the app from a Claude Code session',
      };
    }
    return { running: false, codeSessions: 0, selfHosted: hostedByDesktop(env) };
  }

  const desktopPids = new Set(desktop.map((row) => row.pid));
  // The main process is the one nothing else in the app spawned; its helpers all
  // descend from it.
  //
  // More than one row can answer that description — a second installation the
  // store filter did not narrow away, or a leftover from a crashed instance — and
  // then "the first one listed" is whatever order the process table came back in.
  // That order is not stable, so the same machine could pick a different pid on
  // two consecutive runs and `--terminate` would kill whichever it happened to
  // find. Rank instead, on the evidence that actually distinguishes a main
  // process: the app's own helpers point at it, a stray has none. Oldest, then
  // lowest pid, settle the rest so the answer is at least the same every time.
  const orphans = desktop.filter((row) => !desktopPids.has(row.parentPid));
  const helpersOf = (pid: number): number =>
    desktop.reduce((total, row) => total + (row.parentPid === pid ? 1 : 0), 0);
  const main =
    [...orphans].sort(
      (a, b) =>
        helpersOf(b.pid) - helpersOf(a.pid) ||
        (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY) ||
        a.pid - b.pid,
    )[0] ?? desktop[0]!;

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
  /**
   * It was asked to close and is still up.
   *
   * `refused` carries what the kill itself said, when it said anything. Without
   * it every failure looked the same from outside — a thirty-second wait ending
   * in "quit it from the tray icon" — whether the process had ignored the
   * request or `taskkill` had never been allowed to touch it.
   */
  | { outcome: 'still-running'; mainPid: number; refused?: string };

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
  // Scoped to the installation being closed. With two profiles up, the global
  // question would happily quit whichever main process came first.
  const state = inspectDesktopFor(storeIdentity(store.root, env), list, env);

  if (!state.running && state.uncertain) {
    // Returning 'not-running' here would let a restart flow start a second
    // instance on top of one that may well be running — the exact failure mode
    // `selfHosted` guards against below, reached by a different route (a
    // process table too thin to see the app at all, rather than one that sees
    // it and finds foster inside it).
    throw new DesktopControlError(
      `foster cannot tell whether Claude Desktop is running: ${state.uncertain}.\n` +
        'Quit it yourself, or see "foster doctor" for why the process table could not be read in full.',
    );
  }
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

  let refused: string | undefined;
  if (terminate) {
    // The app saves on a trailing debounce of up to three seconds. Waiting that
    // out first turns "probably lost the last edit" into "probably did not",
    // which is cheap at this point — the user has already decided to close it.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // Kept, unlike the asking form's: `/F` does not fail for want of a window, so
    // a non-zero exit here means the process was not ended — access denied, or a
    // pid that had already gone. Discarding it spent the full timeout and then
    // blamed the app for still running.
    refused = taskkill(['/F', '/T', '/PID', String(pid)]);
  } else {
    taskkill(['/PID', String(pid)]);
  }

  // The lockfile is held for as long as the app runs and is released on exit, so
  // it corroborates the pid check — a recycled pid cannot fake it.
  const gone = await waitFor(() => !processAlive(pid) && !lockfileHeld(store), timeoutMs);
  if (gone) return { outcome: 'quit' };
  return { outcome: 'still-running', mainPid: pid, ...(refused ? { refused } : {}) };
}

/** Long enough to outlast the app's save debounce (1s idle, 3s while running). */
const SETTLE_MS = 3_500;

/**
 * Why a `needs-terminate` left the app alone, and how to insist.
 *
 * The way out is a parameter because it is not the same sentence everywhere:
 * `--terminate` is an option of "foster app quit" and "foster app restart", and
 * a write that was merely asked to restart the app has no such flag. Saying
 * "re-run with --terminate" there sent people to an unknown option.
 */
export function trayNote(retry: string): string {
  return (
    'Claude Desktop keeps running in its tray icon, so asking the window to close\n' +
    'would only hide it. Ending the process is the only way, and it skips the\n' +
    "app's shutdown: a change from the last few seconds may not be saved, and\n" +
    'Cowork sandboxes will not be stopped cleanly.\n' +
    `${retry} to do it, or quit from the tray icon yourself.`
  );
}

/**
 * End a process and everything it spawned.
 *
 * `/T` matters: a Code session starts children of its own, and killing only the
 * parent leaves them holding the conversation the kill was meant to release.
 * There is no gentler form to try first — the CLI has no window to post a close
 * to — so this is what ending one means, and the callers say so before doing it.
 */
export function endProcess(pid: number): void {
  taskkill(['/F', '/T', '/PID', String(pid)]);
}

/**
 * Run taskkill, and report what it said when it refused.
 *
 * The exit code never decides the outcome — the wait that follows does, because
 * a kill can succeed and the process still take a moment to go. It is kept for
 * the one thing the wait cannot supply: the reason. "ERROR: The process ... could
 * not be terminated. Access is denied." is the whole diagnosis, and throwing it
 * away left a thirty-second silence in its place.
 *
 * Returns undefined when taskkill was happy, which is also what the asking form
 * gets when the process simply had no window to close.
 */
function taskkill(args: string[]): string | undefined {
  try {
    execFileSync('taskkill', args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    return undefined;
  } catch (error) {
    const said = error as { stderr?: string | Buffer; stdout?: string | Buffer };
    const text = `${String(said.stderr ?? '')}${String(said.stdout ?? '')}`.trim();
    return text === '' ? undefined : text.split(/\r?\n/)[0];
  }
}

export interface StartOptions {
  timeoutMs?: number;
  /** Injectable so tests never launch anything. */
  launch?: (appId: string) => void;
  /**
   * Injectable: starting a profile takes the executable, not the app identity.
   * Receives the environment already scrubbed of `CLAUDE*` — see launchEnv.ts —
   * so a profile started from inside a hosted Code session does not inherit the
   * markers that would make the new instance think it, too, is hosted.
   */
  launchProfile?: (executable: string, root: string, env: NodeJS.ProcessEnv) => void;
  executable?: () => string | undefined;
  /** The environment to scrub before handing it to a launched profile. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Start the app and wait until it has taken the store.
 *
 * Waiting matters: the point of starting it is that the sidebar gets rebuilt, and
 * returning before that has happened would report success for work still in
 * flight.
 *
 * The installed app is activated by its application id, which is what Windows
 * does from the Start menu. A profile has no identity of its own — it is the same
 * application pointed at another `userData` — so it is started by running the
 * executable with the switch that relocates it.
 */
export async function startDesktop(
  store: StoreLayout,
  options: StartOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 60_000,
    launch = launchPackagedApp,
    launchProfile = launchProfileApp,
    executable = desktopExecutable,
    env = process.env,
  } = options;

  const appId = packagedAppId(store);
  if (appId) launch(appId);
  else {
    const exe = executable();
    if (!exe) {
      throw new DesktopControlError(
        'Could not work out how to start Claude Desktop: this store is a separate profile, and the\n' +
          'installed app was not found to start it with. Start it yourself; everything else still works.',
      );
    }
    launchProfile(exe, store.root, scrubbedEnv(env));
  }

  return waitFor(() => lockfileHeld(store), timeoutMs, 500);
}

export interface DeliverOptions {
  /** Injectable so tests never launch anything. */
  launch?: (executable: string, args: string[]) => void;
  executable?: () => string | undefined;
}

/**
 * Hand a `claude://` link to one particular installation.
 *
 * Windows registers the protocol for the installed package, so a callback from
 * the browser always lands there — which is why a signed-out profile sits on the
 * sign-in screen for ever while the default installation opens instead. The
 * registration is a plain executable with the URL as an argument, and a second
 * invocation carrying the same `--user-data-dir` forwards its argv to the
 * instance holding that profile's lock. So the link can simply be delivered.
 *
 * Only `claude://` links: this is a way to reach one instance, not a way to make
 * foster run arbitrary things. The URL is never printed or recorded — a sign-in
 * callback carries a single-use code, and foster has no business keeping it.
 */
export function deliverUrl(store: StoreLayout, url: string, options: DeliverOptions = {}): void {
  const { launch = launchWithArgs, executable = desktopExecutable } = options;

  if (!/^claude:\/\//i.test(url)) {
    throw new DesktopControlError('Only claude:// links can be handed to an installation.');
  }

  const exe = executable();
  if (!exe) {
    throw new DesktopControlError(
      'Could not find the Claude Desktop executable to hand the link to.\n' +
        'Nothing is registered for claude:// links and no instance is running.',
    );
  }

  // The switch goes even to the installed store: without it this process would
  // be a second instance of whichever profile the environment names.
  launch(exe, [`--user-data-dir=${store.root}`, url]);
}

function launchWithArgs(executable: string, args: string[]): void {
  // Scrubbed rather than inherited: see launchEnv.ts for why a launch foster
  // starts must not hand the child the markers of the session foster itself
  // might be running inside.
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: scrubbedEnv(process.env),
  });
  child.unref();
}

function launchPackagedApp(appId: string): void {
  // Explorer is the documented way to activate a packaged application by its
  // model id from a plain process; the executable itself sits in a directory
  // ordinary users may not run from.
  const child = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: scrubbedEnv(process.env),
  });
  child.unref();
}

function launchProfileApp(executable: string, root: string, env: NodeJS.ProcessEnv): void {
  // Not through explorer: activating the application id would start it on the
  // default userData, which is the installation this profile exists to avoid.
  // Running the executable is allowed even though listing its directory is not.
  // `env` arrives already scrubbed — see startDesktop.
  const child = spawn(executable, [`--user-data-dir=${root}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
}

/**
 * Where the installed app's executable is.
 *
 * Windows records it when it registers the `claude://` handler, as a plain
 * command line with the URL as an argument — so the registry names the same
 * executable Windows itself would run, without any of the guessing that reading
 * a versioned package directory would need. A running instance is the fallback:
 * its path is right there in the process table.
 */
export function desktopExecutable(
  read: () => string | undefined = readProtocolCommand,
  list: ProcessLister = readProcesses,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const registered = /"([^"]+\.exe)"/i.exec(read() ?? '')?.[1];
  if (registered) return registered;
  const rows = list();
  return rows.find((row) => isDesktopProcess(row, rows, env))?.path;
}

function readProtocolCommand(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync(
      regExePath(),
      ['query', 'HKCU\\Software\\Classes\\claude\\shell\\open\\command', '/ve'],
      { encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
    );
    // The value's name is localised — "(Default)" is "(padrão)" on this machine —
    // so the type marker is the only stable thing to cut on.
    const marker = out.indexOf('REG_SZ');
    return marker === -1 ? undefined : out.slice(marker + 'REG_SZ'.length).trim();
  } catch {
    return undefined;
  }
}
