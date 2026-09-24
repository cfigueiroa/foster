import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineageAt } from '../src/engine/lineage.js';
import { scanAccount, scanStore } from '../src/store/scanner.js';
import { provePlan } from '../src/ops/prove.js';
import { listAccountDirs } from '../src/domain/paths.js';
import type { AccountRef } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/** A third account, distinct from `NEW_ACCOUNT` (the target) and `OLD_ACCOUNT`. */
const COPY_ACCOUNT: AccountRef = {
  accountUuid: '22222222-2222-4222-8222-222222222222',
  organizationUuid: '22222222-2222-4222-8222-222222222223',
};

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

  it('reports a gap for a conversation whose cliSessionId is not already lowercase', () => {
    // Regression for the grouping key (`id.toLowerCase()`) being passed to
    // `kin.scanOf`/`reachOf` instead of an original-case id taken from a card
    // — see `provePlan`'s comment. `Lineage`'s transcript index is an
    // exact-match lookup keyed by the filename on disk, so a lowercased id
    // that isn't already all-lower fails to find the transcript, and the old
    // code's `scan === undefined` guard silently dropped the conversation
    // from the audit instead of counting it as a gap.
    const MIXED = CONVERSATION.toUpperCase();
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-mixedcase-'));

    transcript(configDir, 'C--work-project', MIXED, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ]);

    // Only another account holds a card for it; the target holds none at all
    // — an unambiguous, total gap.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d3',
        cliSessionId: MIXED,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = listAccountDirs(store).flatMap((account) => scanAccount(store, account));
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.complete).toBe(false);
    expect(report.gaps).toEqual([
      expect.objectContaining({
        cliSessionId: MIXED,
        totalRecords: 2,
        reachedByTarget: 0,
        missing: 2,
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

  it('is not fooled by an ordinary copy standing between the target and a blocked original (D2, class 19)', () => {
    // The exact false alarm measured on a real store: the conversation's
    // original card is a scheduled/background task (blocked, `NEVER_COMES`),
    // and every *other* card anywhere is a plain fostered copy — one
    // `applyFilter` already holds back as a source (`copyWithCard`,
    // `domain/filter.ts`) because it is a copy of that same blocked original,
    // not a second, independent way in. The sweep's own `countNeverComes`
    // classifies this as never-fosterable; `provePlan` must agree, not call
    // it a gap because the copy alone does not carry a `NEVER_COMES` reason.
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-heldback-'));

    transcript(configDir, 'C--work-project', CONVERSATION, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ]);

    // The original: a scheduled task, in one other account.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d3',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project',
        title: 'Work',
        scheduledTaskId: 'task-1',
      }),
    );
    // A third account already holds an ordinary fostered copy of it — reaching
    // nothing the original does not, just a ready-made copy sitting there.
    writeSession(
      store,
      COPY_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d4',
        cliSessionId: CONVERSATION,
        cwd: 'C:\\work\\project',
        title: 'Work',
        _foster: {
          originAccountUuid: OLD_ACCOUNT.accountUuid,
          originOrganizationUuid: OLD_ACCOUNT.organizationUuid,
          originSessionId: '00000000-0000-4000-8000-0000000000d3',
          fosteredAt: 1_700_000_000_000,
          toolVersion: '0.62.0',
        },
      }),
    );
    // The target has neither — that is the gap being asked about.

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = scanStore(store);
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.gaps).toEqual([]);
    expect(report.neverFosterable).toEqual([
      expect.objectContaining({ cliSessionId: CONVERSATION, reason: 'scheduled-task' }),
    ]);
    expect(report.complete).toBe(true);
  });

  it('credits reach through a fork sibling the target already holds, the same way the branch pass does (D2, class 2)', () => {
    // Two branches of one fork: `STALE` holds nothing the tip (`TIP`) does
    // not also hold — the same `branch.only === 0` shape `planBranchCards`
    // treats as "a row elsewhere in the family already opens this" and never
    // brings a card for. The target holds a row for the tip only. Measured
    // false alarm: `provePlan` used to score `STALE` against the target's
    // own (nonexistent) `STALE` cards alone and report it 0 of N reached.
    const STALE = '00000000-0000-4000-8000-0000000000f1';
    const TIP = '00000000-0000-4000-8000-0000000000f2';
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-fork-'));

    const shared = [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ];
    // Same project directory, same shared history — the shape a fork takes on
    // disk: two transcripts starting from the same first record.
    transcript(configDir, 'C--work-project', STALE, shared);
    transcript(configDir, 'C--work-project', TIP, [
      ...shared,
      rec('00000000-0000-4000-8000-0000000000e2', 'assistant', '2026-09-01T21:00:00.000Z'),
    ]);

    // A card for `STALE` somewhere, so it is a conversation `provePlan` even
    // looks at, and a genuine "why wasn't this brought" question.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d5',
        cliSessionId: STALE,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );
    // The target holds only the tip.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d6',
        cliSessionId: TIP,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = scanStore(store);
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.gaps).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('still reports a genuine gap when the held fork sibling does not reach the missing branch on its own', () => {
    // The guard against over-crediting: the target's sibling branch here is
    // the one that stopped early, and the missing branch is the one that
    // carried on — it holds records the target's own row cannot reach, and
    // crediting them anyway would hide a real gap.
    const TIP = '00000000-0000-4000-8000-0000000000f3';
    const STALE = '00000000-0000-4000-8000-0000000000f4';
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-prove-fork-gap-'));

    const shared = [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
    ];
    transcript(configDir, 'C--work-project', STALE, shared);
    transcript(configDir, 'C--work-project', TIP, [
      ...shared,
      rec('00000000-0000-4000-8000-0000000000e2', 'assistant', '2026-09-01T21:00:00.000Z'),
    ]);

    // The target holds only the branch that stopped early.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d7',
        cliSessionId: STALE,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );
    // The branch that carried on has a card only in another account.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d8',
        cliSessionId: TIP,
        cwd: 'C:\\work\\project',
        title: 'Work',
      }),
    );

    const kin = lineageAt([path.join(configDir, 'projects')]);
    const cards = scanStore(store);
    const report = provePlan(cards, NEW_ACCOUNT, kin);

    expect(report.gaps).toEqual([
      expect.objectContaining({
        cliSessionId: TIP,
        totalRecords: 3,
        reachedByTarget: 2,
        missing: 1,
      }),
    ]);
    expect(report.complete).toBe(false);
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
