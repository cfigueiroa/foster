import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  idsOnDisk,
  readScheduledTasks,
  scheduledTasksPath,
  writeScheduledTasks,
  type ScheduledTask,
} from '../src/store/routines.js';
import { makeStore, NEW_ACCOUNT } from './helpers/store.js';

const env = { FOSTER_HOME: mkdtempSync(path.join(tmpdir(), 'foster-home-')) };

function task(id: string): ScheduledTask {
  return {
    id,
    displayName: id,
    cronExpression: '0 9 * * 1',
    enabled: true,
    filePath: `C:\\tasks\\${id}\\SKILL.md`,
    cwd: 'C:\\work',
    createdAt: 1,
  } as ScheduledTask;
}

describe('writeScheduledTasks — entries it cannot validate survive a write', () => {
  it('keeps an unrecognised routine in place and still counts its id', () => {
    const store = makeStore();
    const target = scheduledTasksPath(store, NEW_ACCOUNT);
    mkdirSync(path.dirname(target), { recursive: true });
    // `cwd: null` fails validation; the app still runs this routine.
    const odd = {
      id: 'odd-one',
      displayName: 'Odd',
      enabled: true,
      filePath: 'x',
      cwd: null,
      createdAt: 1,
    };
    writeFileSync(
      target,
      JSON.stringify({ scheduledTasks: [odd, task('mine')], recordedSkips: { a: 1 } }),
    );

    const read = readScheduledTasks(store, NEW_ACCOUNT);
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.invalidTasks).toBe(1);

    writeScheduledTasks(
      store,
      NEW_ACCOUNT,
      { ...read.file, scheduledTasks: [...read.file.scheduledTasks, task('brought')] },
      { env },
    );

    // Before: the filtered list was written back and `odd-one` was gone for good.
    const after = JSON.parse(readFileSync(target, 'utf8')) as {
      scheduledTasks: { id: string }[];
      recordedSkips: unknown;
    };
    expect(after.scheduledTasks.map((entry) => entry.id)).toEqual(['odd-one', 'mine', 'brought']);
    expect(after.recordedSkips).toEqual({ a: 1 });
    expect(idsOnDisk(store, NEW_ACCOUNT)).toEqual(['odd-one', 'mine', 'brought']);
  });
});
