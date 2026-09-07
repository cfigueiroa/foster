import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codexHome,
  codexSessionsDir,
  findRollouts,
  readRolloutMeta,
  readRolloutRecords,
} from '../src/store/codex.js';

function tempSessionsDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-codex-'));
}

function writeRollout(dir: string, relPath: string, lines: unknown[]): string {
  const file = path.join(dir, relPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

describe('codexHome / codexSessionsDir', () => {
  it('defaults to ~/.codex under the given home', () => {
    expect(codexHome({}, '/home/caio')).toBe(path.join('/home/caio', '.codex'));
    expect(codexSessionsDir({}, '/home/caio')).toBe(path.join('/home/caio', '.codex', 'sessions'));
  });

  it('honours CODEX_HOME the way CLAUDE_CONFIG_DIR overrides ~/.claude', () => {
    expect(codexHome({ CODEX_HOME: '/elsewhere/.codex-alt' }, '/home/caio')).toBe(
      '/elsewhere/.codex-alt',
    );
  });
});

describe('findRollouts', () => {
  it('walks the date-sharded sessions directory and finds every .jsonl file', () => {
    const dir = tempSessionsDir();
    writeRollout(dir, '2026/08/25/rollout-a.jsonl', [{ type: 'session_meta' }]);
    writeRollout(dir, '2026/09/07/rollout-b.jsonl', [{ type: 'session_meta' }]);
    writeFileSync(path.join(dir, 'state_5.sqlite'), 'not a rollout');

    const found = findRollouts(dir)
      .map((file) => path.basename(file))
      .sort();
    expect(found).toEqual(['rollout-a.jsonl', 'rollout-b.jsonl']);
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(findRollouts(path.join(tempSessionsDir(), 'missing'))).toEqual([]);
  });
});

describe('readRolloutMeta', () => {
  it('reads id, cwd, originator, cli_version, source and git branch off session_meta', () => {
    const dir = tempSessionsDir();
    const file = writeRollout(dir, 'rollout.jsonl', [
      {
        type: 'session_meta',
        payload: {
          id: '00000000-0000-4000-8000-00000000000a',
          cwd: '/work/project',
          originator: 'codex_cli_rs',
          cli_version: '0.151.0',
          source: 'cli',
          git: { branch: 'main', commit_hash: 'deadbeef' },
          timestamp: '2026-09-07T10:00:00.000Z',
        },
      },
      { type: 'response_item', payload: { type: 'message', role: 'user' } },
    ]);

    const meta = readRolloutMeta(file);
    expect(meta).toMatchObject({
      id: '00000000-0000-4000-8000-00000000000a',
      cwd: '/work/project',
      originator: 'codex_cli_rs',
      cliVersion: '0.151.0',
      source: 'cli',
      gitBranch: 'main',
      startedAt: '2026-09-07T10:00:00.000Z',
    });
    expect(meta!.mtimeMs).toBeGreaterThan(0);
  });

  it('is undefined when the first line is not a session_meta record', () => {
    const dir = tempSessionsDir();
    const file = writeRollout(dir, 'rollout.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'user' } },
    ]);
    expect(readRolloutMeta(file)).toBeUndefined();
  });

  it('is undefined for a file that does not exist', () => {
    expect(readRolloutMeta('/nowhere/rollout.jsonl')).toBeUndefined();
  });

  it('is undefined when session_meta carries no id', () => {
    const dir = tempSessionsDir();
    const file = writeRollout(dir, 'rollout.jsonl', [
      { type: 'session_meta', payload: { cwd: '/work' } },
    ]);
    expect(readRolloutMeta(file)).toBeUndefined();
  });
});

describe('readRolloutRecords', () => {
  it('parses every line and skips malformed ones without failing the read', () => {
    const dir = tempSessionsDir();
    const file = path.join(dir, 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
        'not json at all',
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user' } }),
      ].join('\n'),
    );

    const records = readRolloutRecords(file);
    expect(records).toEqual([
      { type: 'session_meta', payload: { id: 'x' } },
      { type: 'response_item', payload: { type: 'message', role: 'user' } },
    ]);
  });

  it('returns nothing for a file that does not exist', () => {
    expect(readRolloutRecords('/nowhere/rollout.jsonl')).toEqual([]);
  });
});
