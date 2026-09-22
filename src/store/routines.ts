import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { accountDir } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { writeFileAtomic } from '../util/fsatomic.js';
import { backupFile, type BackupOptions } from '../util/backups.js';

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
  /**
   * Absent on routines an older build created — measured 22/09/2026: four
   * accounts' routines carry no `displayName` at all, and the app shows the id
   * in their place. Required here, it silently disqualified every one of them
   * as a source.
   */
  displayName?: string;
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

/**
 * The result of trying to read one account's routines — three shapes, because
 * "missing" and "there but unreadable" call for opposite treatment. Missing is
 * ordinary: `planLayout` treats it as an empty list, and a write creates the
 * file fresh. Unreadable is not: a source file's routines are simply
 * unavailable to a plan (reported, not fatal — see #A7), but a *target* file
 * `applyLayout` cannot read must never be overwritten wholesale on the strength
 * of what a plan alone would have written — that would destroy whatever tasks
 * and bookkeeping (`recordedSkips` and the rest) the unreadable file held
 * (#A3). It is refused instead, and named in the result so the run can say so.
 */
export type ScheduledTasksRead =
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string }
  | { status: 'ok'; file: ScheduledTasksFile; invalidTasks: number };

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === 'string' &&
    (task.displayName === undefined || typeof task.displayName === 'string') &&
    typeof task.enabled === 'boolean' &&
    typeof task.filePath === 'string' &&
    typeof task.cwd === 'string' &&
    typeof task.createdAt === 'number'
  );
}

/**
 * Strip a leading UTF-8 BOM. Windows editors and some export tools still
 * prepend one; Chromium and Node both write JSON without it, but `JSON.parse`
 * treats a leading `\uFEFF` as a syntax error rather than whitespace, so a
 * file the app itself would happily reopen looked unreadable here (#A3).
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readScheduledTasks(store: StoreLayout, account: AccountRef): ScheduledTasksRead {
  const target = scheduledTasksPath(store, account);
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch {
    return { status: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unreadable', reason: 'not a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const rawTasks = Array.isArray(record.scheduledTasks) ? record.scheduledTasks : [];
  const tasks: ScheduledTask[] = [];
  let invalidTasks = 0;
  for (const entry of rawTasks) {
    if (isScheduledTask(entry)) tasks.push(entry);
    else invalidTasks += 1;
  }

  return { status: 'ok', file: { ...record, scheduledTasks: tasks }, invalidTasks };
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
  options: BackupOptions = {},
): { backup: string | undefined } {
  const target = scheduledTasksPath(store, account);
  // An account with a session directory but no routine of its own yet has
  // never had a reason to write this file — a brand-new org, or one this
  // account/org pair's directory was only just resolved for. `writeFileAtomic`
  // needs somewhere to put its temp file, so the directory is made first.
  mkdirSync(path.dirname(target), { recursive: true });
  const backup = existsSync(target) ? backupFile(target, 'scheduledTasks', options) : undefined;
  writeFileAtomic(
    target,
    JSON.stringify(
      { ...file, scheduledTasks: keepingUnrecognised(target, file.scheduledTasks) },
      null,
      2,
    ),
  );
  return { backup };
}

/**
 * The list to write, with every entry this module could not validate put back
 * where it was.
 *
 * `readScheduledTasks` hands callers only the tasks it recognises, which is the
 * right thing to plan from and the wrong thing to write from: an entry with a
 * `cwd` of `null`, or one a later build shaped differently, is still a routine
 * the app runs, and writing back the filtered list deleted it for good. So the
 * file on disk is read again here and its unrecognised entries survive in
 * place; a recognised one is replaced by the caller's version of the same id
 * (or dropped, if the caller dropped it), and whatever the caller added that
 * the file never held goes at the end.
 */
function keepingUnrecognised(target: string, tasks: ScheduledTask[]): unknown[] {
  let onDisk: unknown[] = [];
  try {
    const parsed = JSON.parse(stripBom(readFileSync(target, 'utf8'))) as {
      scheduledTasks?: unknown;
    };
    if (Array.isArray(parsed.scheduledTasks)) onDisk = parsed.scheduledTasks;
  } catch {
    // Missing or unreadable: nothing to preserve. An unreadable file never
    // reaches here — the caller refuses it before writing (#A3).
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const placed = new Set<string>();
  const out: unknown[] = [];
  for (const entry of onDisk) {
    if (!isScheduledTask(entry)) {
      out.push(entry);
      continue;
    }
    const next = byId.get(entry.id);
    if (next && !placed.has(entry.id)) {
      out.push(next);
      placed.add(entry.id);
    }
  }
  for (const task of tasks) if (!placed.has(task.id)) out.push(task);
  return out;
}

/**
 * The ids of every entry in the file, recognised or not — what "this account
 * already has that routine" has to be asked against. An entry this module
 * cannot validate still claims its id in the app, and bringing a second
 * routine under the same id would shadow it.
 */
export function idsOnDisk(store: StoreLayout, account: AccountRef): string[] {
  try {
    const parsed = JSON.parse(
      stripBom(readFileSync(scheduledTasksPath(store, account), 'utf8')),
    ) as {
      scheduledTasks?: unknown;
    };
    if (!Array.isArray(parsed.scheduledTasks)) return [];
    return parsed.scheduledTasks.flatMap((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
        ? [(entry as { id: string }).id]
        : [],
    );
  } catch {
    return [];
  }
}
