import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineageAt } from '../src/engine/lineage.js';
import { scanAccount } from '../src/store/scanner.js';
import { provePlan } from '../src/ops/prove.js';
import { listAccountDirs } from '../src/domain/paths.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster sweep --prove` is an independent audit of what a sweep actually
 * closed — deliberately built from `Lineage.scanOf`/`reachOf` fresh, rather
 * than from the sweep's own bookkeeping, so it can catch a bug in that
 * bookkeeping rather than agree with it. See `src/ops/prove.ts`.
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000000d1';
const ROOT = '00000000-0000-4000-8000-0000000000e0';

function rec(uuid: string, type: 'user' | 'assistant', timestamp: string) {
  return { uuid, type, timestamp };
}

function transcript(
  configDir: string,
  projectDir: string,
  cliSessionId: string,
  records: unknown[],
): void {
  const dir = path.join(configDir, 'projects', projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${cliSessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n'),
    'utf8',
  );
}

describe('provePlan', () => {
  it('is complete when the target holds both files of a two-file conversation', () => {
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-'));

    transcript(configDir, 'C--work-project', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ]);
    transcript(configDir, 'C--work-project--claude-worktrees-w', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e2', 'assistant', '2026-09-01T21:00:00.000Z'),
    ]);

    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d2',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project',
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d3',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project\\.claude\\worktrees\\w',
      }),
    );

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = listAccountDirs(store).flatMap((account) => scanAccount(store, account));
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.complete).toBe(true);
    expect(report.gaps).toEqual([]);
  });

  it('reports a gap when the target only holds the thinner file', () => {
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-gap-'));

    transcript(configDir, 'C--work-project', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ]);
    transcript(configDir, 'C--work-project--claude-worktrees-w', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e2', 'assistant', '2026-09-01T21:00:00.000Z'),
    ]);

    // Target only reaches the repository file...
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d2',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );
    // ...while another account holds the worktree file's own card, which
    // could have been brought and was not.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d3',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project\\.claude\\worktrees\\w',
        title: 'Work',
      }),
    );

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = listAccountDirs(store).flatMap((account) => scanAccount(store, account));
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.complete).toBe(false);
    expect(report.gaps).toEqual([
      expect.objectContaining({
        cliSessionId: CONVERSATION,
        totalRecords: 3,
        reachedByTarget: 2,
        missing: 1,
      }),
    ]);
  });

  it('counts a conversation whose only other card is a scheduled task as never-fosterable, not a gap', () => {
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-never-'));

    transcript(configDir, 'C--work-project', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ]);
    transcript(configDir, 'C--work-project--claude-worktrees-w', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e2', 'assistant', '2026-09-01T21:00:00.000Z'),
    ]);

    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d2',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d3',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project\\.claude\\worktrees\\w',
        title: 'Work',
        scheduledTaskId: 'task-1',
      }),
    );

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = listAccountDirs(store).flatMap((account) => scanAccount(store, account));
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.gaps).toEqual([]);
    expect(report.neverFosterable).toEqual([
      expect.objectContaining({ cliSessionId: CONVERSATION, reason: 'scheduled-task' }),
    ]);
    expect(report.complete).toBe(true);
  });

  it('is a no-op for a conversation with no transcript at all', () => {
    const store = makeStore();
    writeSession(store, NEW_ACCOUNT, session({ cliSessionId: 'no-such-id' }));
    const report = provePlan(
      listAccountDirs(store).flatMap((account) => scanAccount(store, account)),
      NEW_ACCOUNT,
      lineageAt([]),
    );
    expect(report.gaps).toEqual([]);
    expect(report.neverFosterable).toEqual([]);
  });
});
