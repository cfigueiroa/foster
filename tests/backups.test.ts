import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupFile } from '../src/util/backups.js';

/**
 * `backupFile`'s destination name used to be `<kind>-<ms>-<counter>` — unique
 * within one process, but not across two: a detached `foster layout --restart`
 * and the in-app process it was restarting around are two different pids that
 * can both compute a backup in the same millisecond, and `copyFileSync`
 * overwrote whichever landed second. The fix folds `process.pid` into the name
 * (closing the gap for two real processes) and opens the destination
 * `COPYFILE_EXCL`-only, retrying under a new suffix on `EEXIST` rather than
 * overwriting — the backstop for whatever the pid alone does not catch (a
 * clock that does not tick between two calls sharing a pid, reproduced below
 * by pre-occupying the name a second call would otherwise land on).
 */

function tempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), 'foster-backups-test-'));
  return { ...process.env, FOSTER_HOME: home };
}

function writeSource(env: NodeJS.ProcessEnv, contents: string): string {
  const file = path.join(env.FOSTER_HOME as string, 'source.txt');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('backupFile', () => {
  it('names the backup with this process’s own pid', () => {
    const env = tempEnv();
    const source = writeSource(env, 'a');

    const dest = backupFile(source, 'kind', { env, now: () => new Date('2026-09-24T10:00:00Z') });

    expect(path.basename(dest)).toContain(`-${process.pid}-`);
  });

  it('never reuses a name two calls in the same run would otherwise share', () => {
    const env = tempEnv();
    const source = writeSource(env, 'a');
    const now = () => new Date('2026-09-24T10:00:00Z');

    const first = backupFile(source, 'kind', { env, now });
    const second = backupFile(source, 'kind', { env, now });

    expect(first).not.toBe(second);
  });

  it('does not overwrite a backup already sitting at the name this call would otherwise land on', () => {
    const env = tempEnv();
    const source = writeSource(env, 'first');
    const now = () => new Date('2026-09-24T10:00:00Z');

    const first = backupFile(source, 'kind', { env, now });

    // Reproduces the cross-process race: something else — a second `foster`
    // process sharing the same millisecond and, in the real bug, a different
    // pid — has already claimed the exact name a naive next call would reuse
    // (same kind/ms/pid, counter advanced by exactly one).
    const match = /^(.+-)(\d+)(\.txt)$/.exec(path.basename(first));
    if (!match) throw new Error(`unexpected backup name shape: ${first}`);
    const [, prefix, counter, ext] = match;
    const claimed = path.join(path.dirname(first), `${prefix}${Number(counter) + 1}${ext}`);
    writeFileSync(claimed, 'a stranger already sitting there', 'utf8');

    writeSource(env, 'second');
    const second = backupFile(source, 'kind', { env, now });

    // The stranger survives untouched...
    expect(readFileSync(claimed, 'utf8')).toBe('a stranger already sitting there');
    // ...and this call's own backup still landed, just under a different name.
    expect(second).not.toBe(claimed);
    expect(readFileSync(second, 'utf8')).toBe('second');
  });
});
