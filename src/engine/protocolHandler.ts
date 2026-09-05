import { execFileSync } from 'node:child_process';
import { comparableUserDataDir, samePath, storeIdentity } from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import { desktopExecutable, runningStores, type ProcessLister } from './desktop.js';
import { readProcesses, regExePath } from '../util/processes.js';
import { readConfig } from '../store/config.js';
import { lockfileHeld } from './lockfile.js';
import { project, type LedgerState } from '../ledger/project.js';
import type { LedgerEvent, LedgerEventInput } from '../ledger/types.js';

/**
 * Signing a second profile in through the browser, without a permanent broker.
 *
 * Measured on 2026-09-05: Claude Desktop is an MSIX package, and its manifest
 * routes `claude://` through **package activation**, not through the classic
 * per-user registry key this module used to assume was the whole story. The
 * registry looks different depending on where you read it from:
 *
 *  - **Inside the app's container** (any process descended from it, including
 *    every Code session it hosts): `HKCU\Software\Classes\claude\shell\open\
 *    command` exists, holding the app's own executable — but this is MSIX
 *    registry virtualization's private copy. Browsers run outside the
 *    container and never see it. It is a decoy.
 *  - **Outside the container** (an ordinary terminal): the `claude` class key
 *    exists with just a `URL Protocol` marker; there is normally no `shell`
 *    subkey at all, because package activation does not need one.
 *
 * A classic `HKCU\...\command` key created in the *real* hive is reported to
 * take precedence over package activation for `ShellExecute` of a `claude:`
 * URL (anthropics/claude-code#31476) — that is the hypothesis this module
 * exists to test, not yet confirmed sign-in-to-sign-in. `app login` creates
 * that key (and only the levels of it that do not already exist) for the
 * length of one sign-in, then removes exactly what it added, or puts back
 * exactly what it overwrote. It refuses to run at all from inside the
 * container, where a change here is invisible to the browser regardless of
 * the hypothesis. See CLAUDE.md, "The registry has two views".
 *
 * The one registry subtree this ever touches sits behind `HandlerIo` so tests
 * never touch it — they hand in an in-memory fake and assert against that
 * instead.
 */
const CLASS_KEY = 'HKCU\\Software\\Classes\\claude';
const SHELL_KEY = `${CLASS_KEY}\\shell`;
const OPEN_KEY = `${SHELL_KEY}\\open`;
export const HANDLER_KEY = `${OPEN_KEY}\\command`;

/**
 * What reading the key came back with.
 *
 * `value` is undefined both when the key is genuinely absent and when it
 * exists but came back in a shape `read` cannot parse — that case was never
 * distinguishable from "absent" and still isn't. `error` is a different kind
 * of failure: `reg` itself never ran (a PATH that does not resolve it, a
 * missing binary, a policy block), so nothing was learned about the key at
 * all. Conflating the two used to print "start Claude Desktop once so it
 * registers itself" for a problem that had nothing to do with the app.
 */
export interface HandlerReadResult {
  value?: string;
  error?: string;
}

/** Which levels of the `claude\shell\open\command` subtree exist right now. */
export interface HandlerLevels {
  class: boolean;
  shell: boolean;
  open: boolean;
  command: boolean;
}

/** The one registry subtree foster ever writes, behind a seam so tests never touch the registry. */
export interface HandlerIo {
  /** Default value of HKCU\Software\Classes\claude\shell\open\command; error when reg itself failed. */
  read(): HandlerReadResult;
  /** Which of these keys exist right now: the class root, shell, shell\open, shell\open\command. */
  levels(): HandlerLevels;
  /** Create the missing levels and set the command's default value (reg add ... /ve /d ... /f creates intermediate keys). Throws on failure. */
  write(value: string): void;
  /** Delete a subtree: 'command' deletes shell\open\command, 'open' deletes shell\open, 'shell' deletes shell. Never the class root. */
  remove(level: 'shell' | 'open' | 'command'): void;
}

function regKeyExists(key: string): boolean {
  try {
    execFileSync(regExePath(), ['query', key], {
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

function keyForLevel(level: 'shell' | 'open' | 'command'): string {
  switch (level) {
    case 'shell':
      return SHELL_KEY;
    case 'open':
      return OPEN_KEY;
    case 'command':
      return HANDLER_KEY;
  }
}

/** `'shell'` -> `shell`, `'open'` -> `shell\open`, `'command'` -> `shell\open\command` — for messages. */
export function levelPath(level: 'shell' | 'open' | 'command'): string {
  switch (level) {
    case 'shell':
      return 'shell';
    case 'open':
      return 'shell\\open';
    case 'command':
      return 'shell\\open\\command';
  }
}

/**
 * The real implementation. `read` mirrors `readProtocolCommand` in desktop.ts
 * exactly — parsing after the `REG_SZ` marker rather than the (localised)
 * value name — so the two never disagree about what the key currently holds.
 */
export const registryHandlerIo: HandlerIo = {
  read(): HandlerReadResult {
    if (process.platform !== 'win32') return {};
    try {
      const out = execFileSync(regExePath(), ['query', HANDLER_KEY, '/ve'], {
        windowsHide: true,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      const marker = out.indexOf('REG_SZ');
      return { value: marker === -1 ? undefined : out.slice(marker + 'REG_SZ'.length).trim() };
    } catch (err) {
      // A spawn failure (reg.exe not found, denied, etc.) sets `code`; reg
      // running and exiting non-zero — the ordinary "key not found" — does
      // not. Only the former is worth telling apart: the latter is what the
      // level checks below already cover.
      const spawnFailure = err as NodeJS.ErrnoException & { stderr?: string };
      if (spawnFailure.code !== undefined) {
        return { error: spawnFailure.stderr?.trim() || spawnFailure.message };
      }
      return {};
    }
  },
  levels(): HandlerLevels {
    if (process.platform !== 'win32') {
      return { class: false, shell: false, open: false, command: false };
    }
    return {
      class: regKeyExists(CLASS_KEY),
      shell: regKeyExists(SHELL_KEY),
      open: regKeyExists(OPEN_KEY),
      command: regKeyExists(HANDLER_KEY),
    };
  },
  write(value: string): void {
    execFileSync(regExePath(), ['add', HANDLER_KEY, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  },
  remove(level: 'shell' | 'open' | 'command'): void {
    try {
      execFileSync(regExePath(), ['delete', keyForLevel(level), '/f'], {
        windowsHide: true,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch {
      // Already gone, or reg itself could not run — either way there is
      // nothing left to delete here. The caller verifies with levels()
      // afterward rather than trusting this call's exit code.
    }
  },
};

export interface ParsedHandler {
  exe: string;
  userDataDir?: string;
  raw: string;
}

/**
 * Parses `"<exe>" [--user-data-dir=<dir>] "%1"`, the only two shapes the
 * handler is ever seen in: what the app registers for itself, and what this
 * module arms it with. The dir may or may not be quoted — unquoted is what
 * `armedCommand` writes when it has no space to protect against.
 */
const HANDLER_PATTERN = /^"([^"]+)"(?:\s+--user-data-dir=(?:"([^"]+)"|(\S+)))?\s+"%1"\s*$/;

export function parseHandler(command: string | undefined): ParsedHandler | undefined {
  if (command === undefined) return undefined;
  const match = HANDLER_PATTERN.exec(command.trim());
  if (!match) return undefined;
  const exe = match[1]!;
  const userDataDir = match[2] ?? match[3];
  return { exe, ...(userDataDir !== undefined ? { userDataDir } : {}), raw: command };
}

/** `"<exe>" --user-data-dir=<spelling> "%1"` — quoted only when the spelling needs it. */
export function armedCommand(exe: string, spelling: string): string {
  const quoted = spelling.includes(' ') ? `"${spelling}"` : spelling;
  return `"${exe}" --user-data-dir=${quoted} "%1"`;
}

/**
 * What to put back once the sign-in window closes.
 *
 * `'command'` means a command already existed at `shell\open\command`, and
 * its verbatim value is what restore writes back. `'absent'` means no
 * command existed — `createdFrom` names the shallowest level foster has to
 * create to arm the handler, which is exactly the level restore deletes.
 */
export type PreviousHandler =
  | { kind: 'command'; value: string }
  | { kind: 'absent'; createdFrom: 'shell' | 'open' | 'command' };

export interface LoginPlan {
  root: string;
  /** Registered name, when the ledger has one — see `LedgerState.profiles`. */
  name?: string;
  running: boolean;
  signedInBefore: boolean;
  accountBefore?: string;
  exe?: string;
  /** The --user-data-dir spelling the running instance uses; see below. */
  spelling: string;
  /** What was at shell\open\command before this run, and what to restore. */
  previous?: PreviousHandler;
  armed?: string;
  blockers: string[];
  warnings: string[];
}

export interface PlanLoginOptions {
  io: HandlerIo;
  events: LedgerEvent[];
  env?: NodeJS.ProcessEnv;
  list?: ProcessLister;
  platform?: string;
}

/** The name registered for `root`, when there is one — the reverse of `LedgerState.profiles`. */
function registeredNameFor(state: LedgerState, root: string): string | undefined {
  for (const [name, registeredRoot] of state.profiles) {
    if (samePath(registeredRoot, root)) return name;
  }
  return undefined;
}

/**
 * The `--user-data-dir` spelling a running instance of this store actually
 * uses, or `store.root` when none is running.
 *
 * Electron keys its single-instance lock by the exact string on the command
 * line, so a callback process launched with a different spelling of the same
 * directory finds no window to forward its code to and the sign-in drops on
 * the floor. The running process's own spelling is the only one guaranteed to
 * work.
 */
function spellingFor(root: string, list: ProcessLister): string {
  const running = runningStores(list);
  const match = running.find((dir) => comparableUserDataDir(dir) === comparableUserDataDir(root));
  return match ?? root;
}

/**
 * Whether this process is descended from Claude Desktop.
 *
 * Both markers are set by the app when it hosts a Code session, and either
 * one surviving to this process is enough: `CLAUDE_CODE_ENTRYPOINT` is what
 * makes a `claude` CLI register itself as hosted, `CLAUDE_CODE_HOST_SESSION_ID`
 * is what `hostedByDesktop` (desktop.ts) reads for the same fact elsewhere.
 * Inside either, the registry this module reads and writes is the
 * container's private, virtualized copy — invisible to a browser running
 * outside it — so nothing done here from inside can ever reach the sign-in.
 */
function insideAppContainer(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' || Boolean(env.CLAUDE_CODE_HOST_SESSION_ID)
  );
}

const CONTAINER_BLOCKER =
  'app login must run from a terminal outside Claude Desktop: inside the app the registry is ' +
  'virtualized (MSIX), so a change made here never reaches the browser';

/** The container blocker message, or undefined when this process is not inside the app. */
export function containerBlocker(env: NodeJS.ProcessEnv): string | undefined {
  return insideAppContainer(env) ? CONTAINER_BLOCKER : undefined;
}

const OFF_WINDOWS_BLOCKER =
  'the claude:// handler is a Windows registry key; there is nothing to route elsewhere';

const CLASS_MISSING_BLOCKER =
  `${CLASS_KEY} does not exist: Claude Desktop has never registered the claude:// protocol for ` +
  'this user; start it once, then retry';

const NO_RUNNING_APP_BLOCKER =
  'no running Claude Desktop to read the executable from; start the app or the profile first';

const NOTHING_TO_ARM_BLOCKER =
  'foster could not work out what to arm the handler with (no executable or no command); ' +
  'nothing was changed';

const UNPARSEABLE_COMMAND_BLOCKER =
  `${HANDLER_KEY} exists but is not in the shape "<exe>" "%1"; foster will not guess what to ` +
  'put back, so nothing is armed';

/** reg ran and said nothing usable, as opposed to reg never running at all — see CLASS_MISSING_BLOCKER. */
function couldNotReadBlocker(detail: string): string {
  return `could not read ${HANDLER_KEY}: ${detail}`;
}

function alreadyRoutedBlocker(dir: string): string {
  return (
    `claude:// links are already routed to ${dir}: another login may be in flight, or a previous ` +
    'run was interrupted. foster app login --restore puts the handler back'
  );
}

function alreadyRoutedSameStoreWarning(dir: string): string {
  return (
    `claude:// links are already routed to ${dir}, this profile's own directory: reusing the ` +
    'login already armed rather than arming a second one'
  );
}

const INSTALLED_APP_BLOCKER =
  'the installed app already receives claude:// links; app login is for a second profile';

function signedInWarning(accountBefore: string | undefined): string {
  return (
    `this profile already holds a token cache (last seen as ${accountBefore ?? 'unknown'}); a new ` +
    'sign-in replaces it, and success is detected only by the account changing'
  );
}

function notRunningWarning(label: string): string {
  return `${label} is not running; app login starts it first`;
}

/**
 * What arming the handler for `store` would do, or why it refuses to.
 *
 * Every check runs and adds to `blockers`/`warnings` independently — the plan
 * always carries as much as it can work out, even when it ends up refused, so
 * a caller can explain the refusal with real facts rather than a bare message.
 * The two exceptions are the container and off-Windows checks: inside either,
 * nothing below has anything real to read, so the plan returns immediately
 * with just that one blocker rather than a page of guesses about a registry
 * this process cannot see.
 */
export function planLogin(store: StoreLayout, opts: PlanLoginOptions): LoginPlan {
  const { io, events, env = process.env, list = readProcesses, platform = process.platform } = opts;

  const state = project(events);
  const name = registeredNameFor(state, store.root);
  const config = readConfig(store);
  const running = lockfileHeld(store);
  const signedInBefore = config.hasTokenCache === true;
  const spelling = spellingFor(store.root, list);

  const blockers: string[] = [];
  const warnings: string[] = [];

  const plan: LoginPlan = {
    root: store.root,
    ...(name !== undefined ? { name } : {}),
    running,
    signedInBefore,
    ...(config.lastKnownAccountUuid !== undefined
      ? { accountBefore: config.lastKnownAccountUuid }
      : {}),
    spelling,
    blockers,
    warnings,
  };

  const inside = containerBlocker(env);
  if (inside !== undefined) {
    blockers.push(inside);
    return plan;
  }

  if (platform !== 'win32') {
    blockers.push(OFF_WINDOWS_BLOCKER);
    return plan;
  }

  const read = io.read();
  const current = read.value;
  const parsed = read.error === undefined ? parseHandler(current) : undefined;

  if (read.error !== undefined) {
    // reg itself never ran, so nothing below has anything to work with.
    blockers.push(couldNotReadBlocker(read.error));
  } else {
    const levels = io.levels();

    if (!levels.class) {
      // Foster never creates the class root — the `URL Protocol` marker
      // belongs to the app, and a user for whom it does not exist has never
      // run Claude Desktop at all.
      blockers.push(CLASS_MISSING_BLOCKER);
    } else if (!levels.command) {
      const createdFrom: 'shell' | 'open' | 'command' = !levels.shell
        ? 'shell'
        : !levels.open
          ? 'open'
          : 'command';
      plan.previous = { kind: 'absent', createdFrom };
      // No command to read from here — that is the whole point of this
      // branch — so the registry read is skipped and only the process table
      // is consulted. The packaged app's real command line cannot be listed
      // any other way: it lives inside a protected package directory a plain
      // directory listing cannot reach, so a running process is the only
      // source left for the executable to arm with.
      const fallback = desktopExecutable(() => undefined, list, env);
      if (fallback !== undefined) {
        plan.exe = fallback;
        plan.armed = armedCommand(fallback, spelling);
      } else {
        blockers.push(NO_RUNNING_APP_BLOCKER);
      }
    } else if (!parsed) {
      plan.previous = { kind: 'command', value: current! };
      blockers.push(UNPARSEABLE_COMMAND_BLOCKER);
    } else {
      plan.exe = parsed.exe;
      plan.previous = { kind: 'command', value: current! };

      if (parsed.userDataDir !== undefined) {
        const sameStore =
          comparableUserDataDir(parsed.userDataDir) === comparableUserDataDir(store.root);
        if (sameStore) {
          warnings.push(alreadyRoutedSameStoreWarning(parsed.userDataDir));
          plan.armed = current;
          // The ledger is the normal source for what to restore to, but a
          // reset or relocated FOSTER_HOME (or a key pointed at this store by
          // something other than a tracked foster run) can leave it with no
          // matching record. Falling back to "delete the command" mirrors
          // restoreHandler's own no-record fallback: outside the container
          // there is no natural plain command to rebuild, so deleting what
          // this run cannot otherwise account for is the safe answer.
          if (state.handlerArmed?.createdFrom !== undefined) {
            plan.previous = { kind: 'absent', createdFrom: state.handlerArmed.createdFrom };
          } else if (state.handlerArmed?.previous !== undefined) {
            plan.previous = { kind: 'command', value: state.handlerArmed.previous };
          } else {
            plan.previous = { kind: 'absent', createdFrom: 'command' };
          }
        } else {
          blockers.push(alreadyRoutedBlocker(parsed.userDataDir));
        }
      } else {
        plan.armed = armedCommand(parsed.exe, spelling);
      }
    }
  }

  if (storeIdentity(store.root, env).isDefault) {
    blockers.push(INSTALLED_APP_BLOCKER);
  }

  if (signedInBefore) {
    warnings.push(signedInWarning(plan.accountBefore));
  }
  if (!running) {
    warnings.push(notRunningWarning(name ?? store.root));
  }

  // Every branch above that reaches this point without a blocker is supposed
  // to have set both `exe` and `armed` — this is the guard against a branch
  // that quietly does not, so the CLI refuses before printing a single
  // instruction line rather than failing partway through `runLogin` after the
  // user has already started signing in (measured 2026-09-05: the absent-
  // command branch used to do exactly this).
  if (blockers.length === 0 && armingIncomplete(plan)) {
    blockers.push(NOTHING_TO_ARM_BLOCKER);
  }

  return plan;
}

/**
 * True when a plan has nothing left blocking it yet still lacks what
 * `runLogin` needs to arm the handler — the executable, or the command line
 * built from it. Kept as its own function so the guard above is exercisable
 * directly in tests, since every branch reachable through `planLogin` itself
 * now keeps the two in lock-step (this is a defense against a *future*
 * branch that does not, not a case any of today's branches can reach).
 */
export function armingIncomplete(plan: Pick<LoginPlan, 'exe' | 'armed'>): boolean {
  return plan.exe === undefined || plan.armed === undefined;
}

export type LoginOutcome = 'signed-in' | 'timeout' | 'aborted' | 'handler-rewritten';

export interface RunLoginOptions {
  io: HandlerIo;
  /** The ledger's append. */
  append: (event: LedgerEventInput) => void;
  /** Re-reads the store's config. Injectable. */
  readState: () => { hasTokenCache: boolean; accountUuid?: string };
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LoginResult {
  outcome: LoginOutcome;
  restored: boolean;
  accountAfter?: string;
  message: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageFor(outcome: LoginOutcome, accountAfter: string | undefined): string {
  switch (outcome) {
    case 'signed-in':
      return `signed in as ${accountAfter}; foster stores will show it.`;
    case 'timeout':
      return 'timed out waiting for the sign-in; the handler was put back and nothing was signed in.';
    case 'aborted':
      return 'cancelled; the handler was put back and nothing was signed in.';
    case 'handler-rewritten':
      return (
        'Claude Desktop restarted and rewrote the handler itself while this login was armed: the ' +
        'sign-in probably landed in the default app instead of this profile. Retry, and leave every ' +
        'Claude window alone while it runs.'
      );
  }
}

/**
 * Run one sign-in through the armed handler.
 *
 * The order below is the safety argument: the ledger records what is about to
 * be overwritten (or created) *before* it is touched, so a run that dies
 * between the two writes still leaves the next one (or `app login --restore`)
 * a record of what to put back. Nothing here is undone silently — the restore
 * step and its outcome are appended regardless of how the wait ended.
 */
export async function runLogin(plan: LoginPlan, opts: RunLoginOptions): Promise<LoginResult> {
  if (plan.blockers.length > 0) {
    throw new Error(plan.blockers.join('\n'));
  }
  if (plan.exe === undefined || plan.armed === undefined) {
    throw new Error('the plan has nothing to arm the handler with');
  }
  if (plan.previous === undefined) {
    // Never fall back to guessing here: a plan reaching this point should
    // already know what to restore to (a real command, or the level it is
    // about to create) — this is a refusal of last resort, not a path any
    // caller is expected to hit.
    throw new Error('the plan has nothing to restore to');
  }

  const {
    io,
    append,
    readState,
    timeoutMs = 300_000,
    pollMs = 1_000,
    signal,
    now = Date.now,
    sleep = defaultSleep,
  } = opts;

  const previous = plan.previous;
  const armed = plan.armed;

  append(
    previous.kind === 'command'
      ? { kind: 'handler_armed', root: plan.root, previous: previous.value, exe: plan.exe, armed }
      : {
          kind: 'handler_armed',
          root: plan.root,
          createdFrom: previous.createdFrom,
          exe: plan.exe,
          armed,
        },
  );

  io.write(armed);
  const readBack = io.read();
  if (readBack.value !== armed) {
    const detail = readBack.error !== undefined ? `: ${readBack.error}` : '';
    throw new Error(`could not arm the handler: read back "${readBack.value ?? ''}"${detail}`);
  }

  const deadline = now() + timeoutMs;
  let outcome: LoginOutcome = 'timeout';
  let accountAfter: string | undefined;

  for (;;) {
    if (signal?.aborted) {
      outcome = 'aborted';
      break;
    }

    const state = readState();
    const success =
      (!plan.signedInBefore && state.hasTokenCache) ||
      (state.accountUuid !== undefined && state.accountUuid !== plan.accountBefore);
    if (success) {
      outcome = 'signed-in';
      accountAfter = state.accountUuid;
      break;
    }

    if (io.read().value !== armed) {
      outcome = 'handler-rewritten';
      break;
    }

    if (now() >= deadline) {
      outcome = 'timeout';
      break;
    }

    await sleep(pollMs);
  }

  let restored = false;
  if (outcome !== 'handler-rewritten') {
    if (io.read().value === armed) {
      if (previous.kind === 'command') {
        io.write(previous.value);
        restored = io.read().value === previous.value;
      } else {
        io.remove(previous.createdFrom);
        restored = !io.levels()[previous.createdFrom];
      }
    }
  }

  append({ kind: 'handler_restored', root: plan.root, restored });

  return {
    outcome,
    restored,
    ...(accountAfter !== undefined ? { accountAfter } : {}),
    message: messageFor(outcome, accountAfter),
  };
}

/** For `app login --restore` and for `doctor`: what the ledger says is armed, versus what the key holds. */
export interface HandlerState {
  current?: ParsedHandler;
  armed?: LedgerState['handlerArmed'];
  /**
   * True when this process is inside Claude Desktop's container, where the
   * registry read above is the app's own virtualized copy rather than what a
   * browser would see. `doctor` shows this instead of judging the handler.
   */
  virtualizedView: boolean;
}

export function inspectHandler(
  state: LedgerState,
  io: HandlerIo,
  env: NodeJS.ProcessEnv = process.env,
): HandlerState {
  const current = parseHandler(io.read().value);
  return {
    ...(current !== undefined ? { current } : {}),
    ...(state.handlerArmed !== undefined ? { armed: state.handlerArmed } : {}),
    virtualizedView: insideAppContainer(env),
  };
}

/**
 * Puts the handler back — for `app login --restore` and for `doctor`.
 *
 * Three cases, in order: the ledger says this run *created* a level (nothing
 * existed before it), so that level is removed; the ledger says a *command*
 * existed before it (its verbatim value is what comes back); or the ledger
 * has no record at all but the key still carries a `--user-data-dir`, in
 * which case the safest answer is to delete `shell\open\command` — there is
 * no natural plain command to rebuild outside the app's container, so
 * inventing one would put back something that was never really there.
 */
export function restoreHandler(
  state: LedgerState,
  io: HandlerIo,
  append: (event: LedgerEventInput) => void,
): { ok: boolean; message: string } {
  const armed = state.handlerArmed;

  if (armed?.createdFrom !== undefined) {
    io.remove(armed.createdFrom);
    const ok = !io.levels()[armed.createdFrom];
    append({ kind: 'handler_restored', root: armed.root, restored: ok });
    return {
      ok,
      message: ok
        ? `removed ${levelPath(armed.createdFrom)}, which this login created`
        : `could not remove ${levelPath(armed.createdFrom)}; it may still be routed`,
    };
  }

  if (armed?.previous !== undefined) {
    io.write(armed.previous);
    const ok = io.read().value === armed.previous;
    append({ kind: 'handler_restored', root: armed.root, restored: ok });
    return {
      ok,
      message: ok
        ? `put the handler back to "${armed.previous}"`
        : `could not put the handler back to "${armed.previous}"`,
    };
  }

  const current = parseHandler(io.read().value);
  if (!current || current.userDataDir === undefined) {
    return { ok: false, message: 'the handler is not routed anywhere; nothing to restore' };
  }

  io.remove('command');
  const ok = !io.levels().command;
  append({ kind: 'handler_restored', root: current.userDataDir, restored: ok });
  return {
    ok,
    message: ok
      ? `no record of what the handler held before this login; deleted ${levelPath('command')}`
      : `no record of what the handler held before this login; could not delete ${levelPath('command')}`,
  };
}
