import { statSync } from 'node:fs';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { readGroupScopes, scopeKey, type GroupScope } from '../store/groupScopes.js';
import type { LayoutAssignment } from './layout.js';

/**
 * Did the groups `applyLayout` wrote survive the app starting again?
 *
 * Measured 23/09/2026: the app read the config `foster layout` had just
 * written, and three seconds later rewrote it without the target's scope —
 * `dframe-store` is synced with the account's server copy, and startup
 * replaced the signed-in account's groups with the server's (AGENTS.md, "What
 * the app trusts at startup"). `applyLayout` now also marks the local state as
 * a pending edit so startup uploads it instead, but that rests on reading the
 * page's code, not on a restart anyone watched — so the restart path checks.
 *
 * What it reads is the config file, which the page rewrites from the same
 * in-memory state the sidebar draws from, once it has settled at startup (one
 * write, ~3 s after start, in the measurement). It waits for that rewrite —
 * any change of the file's mtime from `writtenMtimeMs`, the moment foster's
 * own write left it — then for `quietMs` without a further one, capped at
 * `timeoutMs`; and then says, per card, whether it is still filed under a
 * group of the name foster gave it. A window that closes with no rewrite at
 * all is reported as such: nothing was dropped by then, which is not the same
 * as proof that nothing will be.
 */
export interface LayoutGroupsCheck {
  /** Whether the app rewrote the config inside the window. */
  appRewrote: boolean;
  /** How long the check waited, in milliseconds. */
  waitedMs: number;
  kept: LayoutAssignment[];
  dropped: LayoutAssignment[];
}

export interface VerifyLayoutGroupsOptions {
  /** The config's mtime right after foster's own write. */
  writtenMtimeMs: number;
  timeoutMs?: number;
  quietMs?: number;
  stepMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mtimeOf?: (file: string) => number | undefined;
  readScope?: () => GroupScope | undefined;
}

const TIMEOUT_MS = 30_000;
const QUIET_MS = 5_000;
const STEP_MS = 500;

function fileMtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function verifyLayoutGroups(
  store: StoreLayout,
  target: AccountRef,
  assigned: readonly LayoutAssignment[],
  options: VerifyLayoutGroupsOptions,
): Promise<LayoutGroupsCheck> {
  const {
    writtenMtimeMs,
    timeoutMs = TIMEOUT_MS,
    quietMs = QUIET_MS,
    stepMs = STEP_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    mtimeOf = fileMtime,
    readScope = () => readGroupScopes(store)[scopeKey(target)],
  } = options;

  const started = now();
  let seen = writtenMtimeMs;
  let lastChange: number | undefined;

  for (;;) {
    const mtime = mtimeOf(store.desktopConfigFile);
    if (mtime !== undefined && mtime !== seen) {
      seen = mtime;
      lastChange = now();
    }
    const at = now();
    if (lastChange !== undefined && at - lastChange >= quietMs) break;
    if (at - started >= timeoutMs) break;
    await sleep(stepMs);
  }

  let scope: GroupScope | undefined;
  try {
    scope = readScope();
  } catch {
    // A config caught mid-rewrite, or one the app left unreadable: nothing in
    // it can be vouched for, which is what "dropped" means to the caller.
    scope = undefined;
  }
  const nameOf = new Map((scope?.groups ?? []).map((group) => [group.id, group.name]));
  const kept: LayoutAssignment[] = [];
  const dropped: LayoutAssignment[] = [];
  for (const entry of assigned) {
    const groupId = scope?.assignments[entry.cardId];
    if (groupId !== undefined && nameOf.get(groupId) === entry.groupName) kept.push(entry);
    else dropped.push(entry);
  }

  return { appRewrote: lastChange !== undefined, waitedMs: now() - started, kept, dropped };
}
