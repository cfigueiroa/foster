import { execFileSync } from 'node:child_process';
import { comparableUserDataDir, samePath, storeIdentity } from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import {
  desktopExecutable,
  inspectDesktopFor,
  packagedAppId,
  runningStores,
  type ProcessLister,
} from './desktop.js';
import {
  processPackageIdentity,
  readProcesses,
  regExePath,
  type PackageIdentity,
} from '../util/processes.js';
import { readConfig } from '../store/config.js';
import { lockfileHeld as lockfileHeldDefault } from './lockfile.js';
import { project, type LedgerState } from '../ledger/project.js';
import type { LedgerEvent, LedgerEventInput } from '../ledger/types.js';

/**
 * Signing a second profile in through the browser, without a permanent broker.
 *
 * Measured on 2026-09-05, against a real MSIX install
 * (`Claude_pzs8sxrjxfjjc`): Windows resolves the `claude:` protocol through
 * package activation, not the classic per-user registry key
 * (`HKCU\Software\Classes\claude\shell\open\command`) this module used to
 * write. That key is never consulted for a real `ShellExecute` of a
 * `claude:` URL — it is MSIX registry virtualization's private copy, visible
 * only from inside the app's own container.
 *
 * What actually decides the destination is a **packaged ProgID** —
 * `HKCU\Software\Classes\AppX<hash>`, one per URL-protocol/file-type an
 * installed package registers — whose `Shell\open` key carries:
 *
 *  - `AppUserModelID`, identifying which package this is (`Claude_pzs8sxrjxfjjc!Claude`);
 *  - `Parameters`, the argument string appended to the package's executable
 *    at activation time, normally just `"%1"`.
 *
 * `Parameters` is read at the moment a `claude:` link is activated, so
 * pointing it at `--user-data-dir=<profile> "%1"` for the length of one
 * sign-in routes the very next callback to that profile — and it is the
 * user's own key (`FullControl`), so no elevation is needed to change it.
 * This is the one registry VALUE foster ever writes: never a key, never a
 * level, always this one existing value, restored verbatim once the sign-in
 * lands, times out, or is cancelled.
 *
 * A second, independent fact the same measurement uncovered: the process
 * launched by activation only *finds* the profile it is meant to forward to
 * when that profile's own instance was itself started **with package
 * identity** (`Invoke-CommandInDesktopPackage`, not a bare `Claude.exe`
 * child process) — see `startDesktop` in `desktop.ts`. `planLogin` checks
 * this and refuses rather than arming a handler whose callback cannot land.
 *
 * The one registry subtree this ever touches sits behind `HandlerIo` so tests
 * never touch it — they hand in an in-memory fake and assert against that
 * instead. See CLAUDE.md, "The registry has two views".
 */
const CLASSES_ROOT = 'HKCU\\Software\\Classes';

/**
 * What reading a value came back with.
 *
 * `value` is undefined both when the value is genuinely absent and when it
 * exists but came back in a shape `read` cannot parse. `error` is a
 * different kind of failure: `reg` itself never ran (a PATH that does not
 * resolve it, a missing binary, a policy block), so nothing was learned about
 * the value at all.
 */
export interface HandlerReadResult {
  value?: string;
  error?: string;
}

/**
 * A small registry seam over string paths, so tests never touch the real
 * registry. Foster no longer creates or deletes keys — it only reads and
 * replaces the `Parameters` value of a key that already exists.
 */
export interface HandlerIo {
  /** Reads a named value from `key`; `error` when `reg` itself failed to run. */
  readValue(key: string, name: string): HandlerReadResult;
  /** Overwrites a named value on an existing key. Throws on failure. */
  writeValue(key: string, name: string, value: string): void;
  /** Whether `key` exists at all. */
  keyExists(key: string): boolean;
  /** The direct subkey names (not full paths) sitting right under `key`. */
  listSubkeys(key: string): string[];
}

/** The real implementation, entirely through `reg.exe`. */
export const registryHandlerIo: HandlerIo = {
  readValue(key: string, name: string): HandlerReadResult {
    if (process.platform !== 'win32') return {};
    try {
      const out = execFileSync(regExePath(), ['query', key, '/v', name], {
        windowsHide: true,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      // The value's own name can be localised in other places in this codebase,
      // but never here: `/v <name>` asks for it by the fixed, English names the
      // package itself writes (`AppUserModelID`, `Parameters`), so the type
      // marker is only needed to find where the value starts on the line.
      const marker = out.indexOf('REG_SZ');
      return { value: marker === -1 ? undefined : out.slice(marker + 'REG_SZ'.length).trim() };
    } catch (err) {
      // A spawn failure (reg.exe not found, denied, etc.) sets `code`; reg
      // running and exiting non-zero — key or value not found — does not.
      const spawnFailure = err as NodeJS.ErrnoException & { stderr?: string };
      if (spawnFailure.code !== undefined) {
        return { error: spawnFailure.stderr?.trim() || spawnFailure.message };
      }
      return {};
    }
  },
  writeValue(key: string, name: string, value: string): void {
    execFileSync(regExePath(), ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  },
  keyExists(key: string): boolean {
    if (process.platform !== 'win32') return false;
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
  },
  listSubkeys(key: string): string[] {
    if (process.platform !== 'win32') return [];
    try {
      const out = execFileSync(regExePath(), ['query', key], {
        windowsHide: true,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      // Plain `reg query <key>` (no /s) prints the key's own values first, then
      // one line per direct subkey, each the subkey's *full* path — so a name is
      // one of those lines with the parent's path (and a trailing backslash)
      // stripped off the front, and nothing else after it.
      const prefix = `${key}\\`.toLowerCase();
      const names = new Set<string>();
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.toLowerCase().startsWith(prefix)) continue;
        const rest = line.slice(prefix.length);
        if (rest === '' || rest.includes('\\')) continue;
        names.add(rest);
      }
      return [...names];
    } catch {
      return [];
    }
  },
};

/**
 * Finds the packaged ProgID this install registered for `claude:`, and
 * returns its `Shell\open` key — the key `Parameters` lives under.
 *
 * There is no direct path from the protocol name to the ProgID: enumerating
 * every `AppX*` subkey of `HKCU\Software\Classes` and checking each one's own
 * `AppUserModelID` against this install's (`packagedAppId`) is what the
 * measurement above actually did, so that is what this does too. Read-only,
 * and entirely through the injectable `io` — a test hands in a fake tree with
 * one matching entry rather than a real registry.
 */
export function findProtocolProgId(io: HandlerIo, store: StoreLayout): string | undefined {
  const appId = packagedAppId(store);
  if (appId === undefined) return undefined;

  for (const name of io.listSubkeys(CLASSES_ROOT)) {
    if (!name.toLowerCase().startsWith('appx')) continue;
    const openKey = `${CLASSES_ROOT}\\${name}\\Shell\\open`;
    if (!io.keyExists(openKey)) continue;
    if (io.readValue(openKey, 'AppUserModelID').value === appId) return openKey;
  }
  return undefined;
}

/** What `Parameters` holds, parsed. Absent `userDataDir` means the bare, unrouted `"%1"`. */
export interface ParsedParameters {
  userDataDir?: string;
}

/**
 * Parses `[--user-data-dir=<dir>] "%1"`, the only two shapes `Parameters` is
 * ever seen in: what the package registers for itself, and what this module
 * arms it with. The dir may or may not be quoted — unquoted is what
 * `armedParameters` writes when it has no space to protect against.
 */
const PARAMETERS_PATTERN = /^(?:--user-data-dir=(?:"([^"]+)"|(\S+))\s+)?"%1"\s*$/;

export function parseParameters(value: string | undefined): ParsedParameters | undefined {
  if (value === undefined) return undefined;
  const match = PARAMETERS_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const userDataDir = match[1] ?? match[2];
  return userDataDir !== undefined ? { userDataDir } : {};
}

/** `[--user-data-dir=<spelling>] "%1"` — quoted only when the spelling needs it. */
export function armedParameters(spelling: string): string {
  const quoted = spelling.includes(' ') ? `"${spelling}"` : spelling;
  return `--user-data-dir=${quoted} "%1"`;
}

export interface LoginPlan {
  root: string;
  /** Registered name, when the ledger has one — see `LedgerState.profiles`. */
  name?: string;
  running: boolean;
  signedInBefore: boolean;
  accountBefore?: string;
  /** The executable this install runs, kept for messages only — arming never needs it. */
  exe?: string;
  /** The --user-data-dir spelling the running instance uses; see below. */
  spelling: string;
  /** The ProgID's `Shell\open` key `Parameters` lives under, once found. */
  key?: string;
  /** Whether the running profile's main process has package identity. */
  identity?: PackageIdentity;
  /** The current value of `Parameters`, to restore once the sign-in ends. */
  previous?: string;
  /** What to write into `Parameters` to route the next callback here. */
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
  /** Injectable: reads the running profile's package identity. */
  identity?: (pid: number) => PackageIdentity;
  /**
   * Injectable: whether the store's lockfile is currently held. Real Electron
   * single-instance locking cannot be reproduced by a plain `writeFileSync` in
   * a test (a self-rename of an unlocked file always succeeds), so tests
   * asking about a "running" profile inject this rather than faking the file.
   */
  lockfileHeld?: (store: StoreLayout) => boolean;
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

const PROGID_NOT_FOUND_BLOCKER =
  'this Claude Desktop does not register claude:// as a packaged app; only the MSIX install is ' +
  'supported by app login';

const NOTHING_TO_ARM_BLOCKER =
  'foster could not work out what to arm the handler with; nothing was changed';

function couldNotReadBlocker(key: string, detail: string): string {
  return `could not read ${key}\\Parameters: ${detail}`;
}

function unparseableBlocker(key: string): string {
  return (
    `${key}\\Parameters exists but is not in the shape [--user-data-dir=<dir>] "%1"; foster will ` +
    'not guess what to put back, so nothing is armed'
  );
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

const PROFILE_NO_IDENTITY_BLOCKER =
  'the profile is running without package identity, so the callback process will not find it; ' +
  'close it and let app login start it again (or re-run with --restart-profile)';

const IDENTITY_UNKNOWN_WARNING =
  'could not tell whether the profile is running with package identity (no working PowerShell); ' +
  'if the sign-in does not land, close the profile and let app login start it again';

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
  const {
    io,
    events,
    env = process.env,
    list = readProcesses,
    platform = process.platform,
    identity: identityReader,
    lockfileHeld: lockfileHeldReader = lockfileHeldDefault,
  } = opts;

  const state = project(events);
  const name = registeredNameFor(state, store.root);
  const config = readConfig(store);
  const running = lockfileHeldReader(store);
  const signedInBefore = config.hasTokenCache === true;
  const spelling = spellingFor(store.root, list);
  const exe = desktopExecutable(() => undefined, list, env);

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
    ...(exe !== undefined ? { exe } : {}),
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

  const key = findProtocolProgId(io, store);
  if (key === undefined) {
    blockers.push(PROGID_NOT_FOUND_BLOCKER);
  } else {
    plan.key = key;
    const read = io.readValue(key, 'Parameters');

    if (read.error !== undefined) {
      blockers.push(couldNotReadBlocker(key, read.error));
    } else {
      const current = read.value;
      const parsed = parseParameters(current);

      if (!parsed) {
        blockers.push(unparseableBlocker(key));
      } else if (parsed.userDataDir !== undefined) {
        const sameStore =
          comparableUserDataDir(parsed.userDataDir) === comparableUserDataDir(store.root);
        if (sameStore) {
          warnings.push(alreadyRoutedSameStoreWarning(parsed.userDataDir));
          plan.armed = current;
          // The ledger is the normal source for what to restore to. Without a
          // matching record — a reset or relocated FOSTER_HOME, or Parameters
          // pointed at this store by something other than a tracked foster
          // run — the safest answer is the bare, unrouted value every fresh
          // install carries, since there is no other natural value to guess.
          plan.previous = state.handlerArmed?.key === key ? state.handlerArmed.previous : '"%1"';
        } else {
          blockers.push(alreadyRoutedBlocker(parsed.userDataDir));
        }
      } else {
        plan.previous = current;
        plan.armed = armedParameters(spelling);
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
  } else {
    // The callback process only finds a running profile whose own instance
    // was itself started with package identity — see the module docblock.
    // Only meaningful once there is a pid to ask about; a lockfile without a
    // process the table can attribute leaves this unresolved rather than
    // guessed at, same as everywhere else in this file.
    const desktopState = inspectDesktopFor(storeIdentity(store.root, env), list, env);
    if (desktopState.mainPid !== undefined) {
      const reader = identityReader ?? ((pid: number) => processPackageIdentity(pid, env));
      const idy = reader(desktopState.mainPid);
      plan.identity = idy;
      if (idy === 'none') blockers.push(PROFILE_NO_IDENTITY_BLOCKER);
      else if (idy === 'unknown') warnings.push(IDENTITY_UNKNOWN_WARNING);
    }
  }

  // Every branch above that reaches this point without a blocker is supposed
  // to have set both `key` and `armed` — this is the guard against a branch
  // that quietly does not, so the CLI refuses before printing a single
  // instruction line rather than failing partway through `runLogin` after the
  // user has already started signing in.
  if (blockers.length === 0 && armingIncomplete(plan)) {
    blockers.push(NOTHING_TO_ARM_BLOCKER);
  }

  return plan;
}

/**
 * True when a plan has nothing left blocking it yet still lacks what
 * `runLogin` needs to arm the handler — the key `Parameters` lives at, or the
 * value to write there.
 */
export function armingIncomplete(plan: Pick<LoginPlan, 'key' | 'armed'>): boolean {
  return plan.key === undefined || plan.armed === undefined;
}

export type LoginOutcome = 'signed-in' | 'timeout' | 'aborted' | 'handler-rewritten';

export interface RunLoginOptions {
  io: HandlerIo;
  /** The ledger's append. */
  append: (event: LedgerEventInput) => void;
  /** Re-reads the store's config. Injectable. */
  readState: () => { hasTokenCache: boolean; accountUuid?: string };
  /** Undefined means no time limit: the wait ends only on success, abort, or a rewritten handler. */
  timeoutMs?: number;
  pollMs?: number;
  /** How often `onHeartbeat` fires while waiting. Default 60_000; meaningless without `onHeartbeat`. */
  heartbeatMs?: number;
  /** Called once per `heartbeatMs` of waiting, with the elapsed time since the handler was armed. */
  onHeartbeat?: (elapsedMs: number) => void;
  /**
   * Called the instant the handler is armed and the write is read back —
   * before the wait begins. This is what lets the CLI print "claude:// links
   * now go to X" only once that is actually true, instead of before the
   * write has happened at all.
   */
  onArmed?: () => void;
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
        'the packaged registration was rewritten underneath this login (an app update or repair): ' +
        'the sign-in probably landed in the default app instead of this profile. Retry, and leave ' +
        'every Claude window alone while it runs.'
      );
  }
}

/**
 * Run one sign-in through the armed handler.
 *
 * The order below is the safety argument: the ledger records what is about to
 * be overwritten *before* it is touched, so a run that dies between the two
 * writes still leaves the next one (or `app login --restore`) a record of
 * what to put back. Nothing here is undone silently — the restore step and
 * its outcome are appended regardless of how the wait ended.
 */
export async function runLogin(plan: LoginPlan, opts: RunLoginOptions): Promise<LoginResult> {
  if (plan.blockers.length > 0) {
    throw new Error(plan.blockers.join('\n'));
  }
  if (plan.key === undefined || plan.armed === undefined || plan.previous === undefined) {
    // Never fall back to guessing here: a plan reaching this point should
    // already know what to arm and restore — this is a refusal of last
    // resort, not a path any caller is expected to hit.
    throw new Error('the plan has nothing to arm the handler with');
  }

  const {
    io,
    append,
    readState,
    timeoutMs,
    pollMs = 1_000,
    heartbeatMs = 60_000,
    onHeartbeat,
    onArmed,
    signal,
    now = Date.now,
    sleep = defaultSleep,
  } = opts;

  const key = plan.key;
  const previous = plan.previous;
  const armed = plan.armed;

  append({
    kind: 'handler_armed',
    root: plan.root,
    key,
    previous,
    ...(plan.exe !== undefined ? { exe: plan.exe } : {}),
    armed,
  });

  io.writeValue(key, 'Parameters', armed);
  const readBack = io.readValue(key, 'Parameters');
  if (readBack.value !== armed) {
    const detail = readBack.error !== undefined ? `: ${readBack.error}` : '';
    throw new Error(`could not arm the handler: read back "${readBack.value ?? ''}"${detail}`);
  }

  onArmed?.();

  const startedAt = now();
  const deadline = timeoutMs !== undefined ? startedAt + timeoutMs : undefined;
  let nextHeartbeat = onHeartbeat !== undefined ? startedAt + heartbeatMs : undefined;
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

    if (io.readValue(key, 'Parameters').value !== armed) {
      outcome = 'handler-rewritten';
      break;
    }

    if (deadline !== undefined && now() >= deadline) {
      outcome = 'timeout';
      break;
    }

    if (nextHeartbeat !== undefined && now() >= nextHeartbeat) {
      onHeartbeat!(now() - startedAt);
      nextHeartbeat += heartbeatMs;
    }

    await sleep(pollMs);
  }

  let restored = false;
  if (outcome !== 'handler-rewritten') {
    if (io.readValue(key, 'Parameters').value === armed) {
      io.writeValue(key, 'Parameters', previous);
      restored = io.readValue(key, 'Parameters').value === previous;
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
  /** The ProgID's `Shell\open` key, once found. */
  key?: string;
  current?: { userDataDir?: string; raw: string };
  armed?: LedgerState['handlerArmed'];
  /**
   * True when this process is inside Claude Desktop's container, where the
   * registry read above is the app's own virtualized copy rather than what a
   * browser would see. `doctor` shows this instead of judging the handler.
   */
  virtualizedView: boolean;
}

export function inspectHandler(
  store: StoreLayout,
  state: LedgerState,
  io: HandlerIo,
  env: NodeJS.ProcessEnv = process.env,
): HandlerState {
  const virtualizedView = insideAppContainer(env);
  const armed = state.handlerArmed;
  const key = findProtocolProgId(io, store);

  if (key === undefined) {
    return { ...(armed !== undefined ? { armed } : {}), virtualizedView };
  }

  const read = io.readValue(key, 'Parameters');
  const parsed = parseParameters(read.value);

  return {
    key,
    ...(parsed !== undefined
      ? {
          current: {
            raw: read.value!,
            ...(parsed.userDataDir !== undefined ? { userDataDir: parsed.userDataDir } : {}),
          },
        }
      : {}),
    ...(armed !== undefined ? { armed } : {}),
    virtualizedView,
  };
}

/**
 * Puts `Parameters` back — for `app login --restore` and for `doctor`.
 *
 * The ledger is the only source of truth for this: it names both the key
 * (`armed.key`) and the exact value to restore (`armed.previous`), recorded
 * before the arming write ever happened. Without a record there is nothing
 * safe to do — foster does not delete or guess a value it did not record
 * overwriting.
 */
export function restoreHandler(
  state: LedgerState,
  io: HandlerIo,
  append: (event: LedgerEventInput) => void,
): { ok: boolean; message: string } {
  const armed = state.handlerArmed;
  if (armed === undefined) {
    return { ok: false, message: 'no login is in flight; nothing to restore' };
  }

  io.writeValue(armed.key, 'Parameters', armed.previous);
  const ok = io.readValue(armed.key, 'Parameters').value === armed.previous;
  append({ kind: 'handler_restored', root: armed.root, restored: ok });
  return {
    ok,
    message: ok
      ? `put the handler back to "${armed.previous}"`
      : `could not put the handler back to "${armed.previous}"`,
  };
}
