import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { accountDir } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { writeFileAtomic } from '../util/fsatomic.js';

/**
 * Scheduled tasks ("routines"), one file per account/org.
 *
 * Measured 22/09/2026, real MSIX store:
 * `<store.root>/claude-code-sessions/<accountUuid>/<orgUuid>/scheduled-tasks.json`.
 * Every account/org directory has one, often with an empty list — the SKILL.md a
 * task points at lives in the shared CLI config dir, so the same `filePath` is
 * valid from any account. Like the group scopes, this is written only while the
 * app is closed.
 */

export interface ScheduledTask {
  id: string;
  displayName: string;
  cronExpression?: string;
  /** Epoch ms — a one-shot task, mutually exclusive with `cronExpression`. */
  fireAt?: number;
  enabled: boolean;
  filePath: string;
  createdAt: number;
  cwd: string;
  lastRunAt?: number;
  lastScheduledFor?: number;
  notifySessionId?: string;
  /** Fields this build does not know about yet, carried through verbatim. */
  [key: string]: unknown;
}

export interface ScheduledTasksFile {
  scheduledTasks: ScheduledTask[];
  /** Everything else the file carries, preserved verbatim on a write. */
  [key: string]: unknown;
}

export function scheduledTasksPath(store: StoreLayout, account: AccountRef): string {
  return path.join(accountDir(store, account), 'scheduled-tasks.json');
}

/** `undefined` when the file is missing or unreadable — not the same as an empty list. */
export function readScheduledTasks(
  store: StoreLayout,
  account: AccountRef,
): ScheduledTasksFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(scheduledTasksPath(store, account), 'utf8')) as Record<
      string,
      unknown
    >;
    const tasks = Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
    return { ...parsed, scheduledTasks: tasks as ScheduledTask[] };
  } catch {
    return undefined;
  }
}

/**
 * Write the whole file back, only `scheduledTasks` changed.
 *
 * Every other key (`recordedSkips`, `sundayAliasBoundaryStamped`,
 * `dayFieldsOrBoundaryStamped`, and anything a future build adds) travels
 * through unread and unmodified, the same restraint `writeGroupScope` keeps for
 * its own file. A backup is written first when the file already exists; a
 * target account that had no file yet — the fold's fallback, an account with a
 * session directory but no tasks of its own on record — gets none to back up.
 */
export function writeScheduledTasks(
  store: StoreLayout,
  account: AccountRef,
  file: ScheduledTasksFile,
  options: { now?: () => Date } = {},
): { backup: string | undefined } {
  const target = scheduledTasksPath(store, account);
  // An account with a session directory but no routine of its own yet has
  // never had a reason to write this file — a brand-new org, or one this
  // account/org pair's directory was only just resolved for. `writeFileAtomic`
  // needs somewhere to put its temp file, so the directory is made first.
  mkdirSync(path.dirname(target), { recursive: true });
  let backup: string | undefined;
  if (existsSync(target)) {
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '').slice(0, 15);
    backup = `${target}.bak-${stamp}`;
    copyFileSync(target, backup);
  }
  writeFileAtomic(target, JSON.stringify(file, null, 2));
  return { backup };
}
