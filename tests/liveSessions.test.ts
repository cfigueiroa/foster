import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveBranchNote } from '../src/engine/continued.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import { describeWriters, isSelfHostedBy } from '../src/store/liveSessions.js';

const CONVERSATION = '00000000-0000-4000-8000-0000000000e1';

/** A process table: a CLI session, foster under it, and an unrelated session. */
const TREE: ProcessRow[] = [
  { pid: 100, parentPid: 1, name: 'claude.exe', path: '', commandLine: '', startedAt: 1_000 },
  { pid: 200, parentPid: 100, name: 'node.exe', path: '', commandLine: '', startedAt: 2_000 },
  { pid: 900, parentPid: 1, name: 'claude.exe', path: '', commandLine: '', startedAt: 1_000 },
];

function registryWith(entries: Record<string, unknown>[]): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'foster-live-')), 'sessions');
  mkdirSync(root, { recursive: true });
  entries.forEach((entry, index) =>
    writeFileSync(path.join(root, `${index}.json`), JSON.stringify(entry), 'utf8'),
  );
  return root;
}

describe('isSelfHostedBy', () => {
  it('recognises the session foster was started from', () => {
    // Ending it would kill the command reporting the result, which is the one
    // process a command must never end.
    expect(isSelfHostedBy(100, () => TREE, 200)).toBe(true);
  });

  it('does not claim an unrelated session', () => {
    expect(isSelfHostedBy(900, () => TREE, 200)).toBe(false);
  });

  it('refuses to walk into a parent younger than its child', () => {
    // A recycled pid can point at a process that started later; treating it as an
    // ancestor would mark an unrelated session as this one.
    const recycled: ProcessRow[] = [
      { pid: 100, parentPid: 1, name: 'claude.exe', path: '', commandLine: '', startedAt: 9_000 },
      { pid: 200, parentPid: 100, name: 'node.exe', path: '', commandLine: '', startedAt: 2_000 },
    ];
    expect(isSelfHostedBy(100, () => recycled, 200)).toBe(false);
  });

  it('concludes nothing when the process table is unavailable', () => {
    expect(isSelfHostedBy(100, () => [], 200)).toBe(false);
  });
});

describe('describeWriters', () => {
  it('names the process and where it is running', () => {
    const root = registryWith([{ pid: 900, sessionId: CONVERSATION, cwd: '/work/thing' }]);

    expect(
      describeWriters(
        [CONVERSATION],
        [root],
        () => TREE,
        () => true,
      ),
    ).toEqual([{ pid: 900, cwd: '/work/thing' }]);
  });

  it('ignores conversations that have no writer', () => {
    const root = registryWith([{ pid: 900, sessionId: 'something-else', cwd: '/elsewhere' }]);

    expect(
      describeWriters(
        [CONVERSATION],
        [root],
        () => TREE,
        () => true,
      ),
    ).toEqual([]);
  });

  it('matches the conversation whatever case it is written in', () => {
    const root = registryWith([
      { pid: 900, sessionId: CONVERSATION.toUpperCase(), cwd: '/work/thing' },
    ]);

    expect(
      describeWriters(
        [CONVERSATION],
        [root],
        () => TREE,
        () => true,
      ),
    ).toHaveLength(1);
  });
});

describe('liveBranchNote', () => {
  it('names each writer, because "finish there" needs a there', () => {
    const note = liveBranchNote([{ pid: 3848, cwd: 'C:/work/foster' }]);

    expect(note).toContain('1 of these is being written');
    expect(note).toContain('pid 3848');
    expect(note).toContain('C:/work/foster');
    expect(note).toContain('foster live --stop');
  });

  it('says which one is the session running foster', () => {
    const note = liveBranchNote([{ pid: 3848, cwd: 'C:/work/foster', isSelf: true }]);

    expect(note).toContain('this one, running foster');
  });

  it('reads as a plural when there are several, and admits an unknown directory', () => {
    const note = liveBranchNote([{ pid: 1 }, { pid: 2 }]);

    expect(note).toContain('2 of these are being written');
    expect(note).toContain('(unknown directory)');
  });
});
