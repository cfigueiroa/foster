import { execFileSync } from 'node:child_process';
import { comparableUserDataDir, samePath, storeIdentity } from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import { desktopExecutable, runningStores, type ProcessLister } from './desktop.js';
import { readProcesses } from '../util/processes.js';
import { readConfig } from '../store/config.js';
import { lockfileHeld } from './lockfile.js';
import { project, type LedgerState } from '../ledger/project.js';
import type { LedgerEvent, LedgerEventInput } from '../ledger/types.js';

/**
 * Signing a second profile in through the browser, without a permanent broker.
 *
 * Windows routes every `claude://` link through one per-user registry key —
 * `HKCU\Software\Classes\claude\shell\open\command` — whatever it says wins,
 * and the app rewrites it to point at itself on every start. That rules out
 * anything permanent: a broker sitting on the key would fight the app for it
 * on every launch. What is left is temporary and scoped instead — point the
 * key at the profile only for the duration of one sign-in, wait for the
 * sign-in to land, then put the exact previous value back. The user keeps the
 * ordinary browser flow, nothing captures URLs, and foster never sees the
 * callback.
 *
 * The one registry key this ever writes sits behind `HandlerIo` so tests never
 * touch it — they hand in an in-memory fake and assert against that instead.
 */
export const HANDLER_KEY = 'HKCU\\Software\\Classes\\claude\\shell\\open\\command';

/** The one registry key foster ever writes, behind a seam so tests never touch the registry. */
export interface HandlerIo {
  /** The key's default value, or undefined when absent/unreadable. */
  read(): string | undefined;
  /** Replace the key's default value (REG_SZ). Throws on failure. */
  write(value: string): void;
}

/**
 * The real implementation. `read` mirrors `readProtocolCommand` in desktop.ts
 * exactly — parsing after the `REG_SZ` marker rather than the (localised)
 * value name — so the two never disagree about what the key currently holds.
 */
export const registryHandlerIo: HandlerIo = {
  read(): string | undefined {
    if (process.platform !== 'win32') return undefined;
    try {
      const out = execFileSync('reg', ['query', HANDLER_KEY, '/ve'], {
        windowsHide: true,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      const marker = out.indexOf('REG_SZ');
      return marker === -1 ? undefined : out.slice(marker + 'REG_SZ'.length).trim();
    } catch {
      return undefined;
    }
  },
  write(value: string): void {
    execFileSync('reg', ['add', HANDLER_KEY, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8',
    });
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
  /** The key's current raw value, verbatim. */
  previous?: string;
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

const OFF_WINDOWS_BLOCKER =
  'the claude:// handler is a Windows registry key; there is nothing to route elsewhere';

const MISSING_KEY_BLOCKER =
  'HKCU\\...\\command is missing or not in the shape "<exe>" "%1"; start Claude Desktop once so ' +
  'it registers itself, then retry';

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

  if (platform !== 'win32') {
    blockers.push(OFF_WINDOWS_BLOCKER);
    return plan;
  }

  const current = io.read();
  if (current !== undefined) plan.previous = current;
  const parsed = parseHandler(current);

  if (!parsed) {
    blockers.push(MISSING_KEY_BLOCKER);
    // Nothing parsed out of the registry, but a running instance's own process
    // still names the executable Windows would launch — the same fallback
    // `desktopExecutable` already uses, reading through `io` rather than a
    // fresh registry query of its own.
    const fallback = desktopExecutable(() => io.read(), list, env);
    if (fallback !== undefined) plan.exe = fallback;
  } else {
    plan.exe = parsed.exe;

    if (parsed.userDataDir !== undefined) {
      const sameStore =
        comparableUserDataDir(parsed.userDataDir) === comparableUserDataDir(store.root);
      if (sameStore) {
        warnings.push(alreadyRoutedSameStoreWarning(parsed.userDataDir));
        plan.armed = current;
        plan.previous = state.handlerArmed?.previous;
      } else {
        blockers.push(alreadyRoutedBlocker(parsed.userDataDir));
      }
    } else {
      plan.armed = armedCommand(parsed.exe, spelling);
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

  return plan;
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
 * be overwritten *before* it is overwritten, so a run that dies between the
 * two writes still leaves the next one (or `app login --restore`) a record of
 * what belongs back in the key. Nothing here is undone silently — the restore
 * step and its outcome are appended regardless of how the wait ended.
 */
export async function runLogin(plan: LoginPlan, opts: RunLoginOptions): Promise<LoginResult> {
  if (plan.blockers.length > 0) {
    throw new Error(plan.blockers.join('\n'));
  }
  if (plan.exe === undefined || plan.armed === undefined) {
    throw new Error('the plan has nothing to arm the handler with');
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

  const previous = plan.previous ?? '';
  const armed = plan.armed;

  append({ kind: 'handler_armed', root: plan.root, previous, exe: plan.exe, armed });

  io.write(armed);
  const readBack = io.read();
  if (readBack !== armed) {
    throw new Error(`could not arm the handler: read back "${readBack ?? ''}"`);
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

    if (io.read() !== armed) {
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
    if (io.read() === armed) {
      io.write(previous);
      restored = io.read() === previous;
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
  armed?: { root: string; previous: string; at: number };
}

export function inspectHandler(state: LedgerState, io: HandlerIo): HandlerState {
  const current = parseHandler(io.read());
  return {
    ...(current !== undefined ? { current } : {}),
    ...(state.handlerArmed !== undefined ? { armed: state.handlerArmed } : {}),
  };
}

/** Puts the previous value back when the key still carries a --user-data-dir. Appends handler_restored. */
export function restoreHandler(
  state: LedgerState,
  io: HandlerIo,
  append: (event: LedgerEventInput) => void,
): { ok: boolean; message: string } {
  const current = parseHandler(io.read());
  if (!current || current.userDataDir === undefined) {
    return { ok: false, message: 'the handler is not routed anywhere; nothing to restore' };
  }

  const armed = state.handlerArmed;
  const rebuilt = armed === undefined;
  const previous = armed ? armed.previous : `"${current.exe}" "%1"`;

  io.write(previous);
  const ok = io.read() === previous;
  append({ kind: 'handler_restored', root: armed?.root ?? current.userDataDir, restored: ok });

  return {
    ok,
    message: rebuilt
      ? `no record of what the handler held before this login; rebuilt "${previous}" from the ` +
        'current executable and wrote it back'
      : `put the handler back to "${previous}"`,
  };
}
