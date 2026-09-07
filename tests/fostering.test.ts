import { describe, expect, it } from 'vitest';
import {
  applyPrefix,
  buildFosterCopy,
  DEFAULT_PREFIX,
  fosteringKey,
  mintSessionId,
  unfosterableReasons,
  worktreeClaim,
} from '../src/domain/fostering.js';
import { NEW_ACCOUNT, OLD_ACCOUNT, session } from './helpers/store.js';

/**
 * The prefix the tool shipped with, kept here as a test fixture. The default is
 * empty now, so a suite that reached for DEFAULT_PREFIX would be asserting that
 * nothing happens and would pass with applyPrefix gutted.
 */
const MARKER = '↪ ';

describe('title prefix', () => {
  it('adds the prefix', () => {
    expect(applyPrefix('Refactor parser', MARKER)).toBe('↪ Refactor parser');
  });

  it('is idempotent — re-applying never stacks prefixes', () => {
    const once = applyPrefix('Refactor parser', MARKER);
    const twice = applyPrefix(once, MARKER);
    expect(twice).toBe(once);
  });

  /**
   * The decision, not an incidental fact: a copy is not marked in the title.
   * Without this, restoring the old default would go unnoticed by every test,
   * since each one that cares now names its own prefix.
   */
  it('is empty by default, so a copy carries no marker', () => {
    expect(DEFAULT_PREFIX).toBe('');
    expect(applyPrefix('Refactor parser', DEFAULT_PREFIX)).toBe('Refactor parser');
  });

  it('leaves a title that genuinely begins with the prefix untouched', () => {
    // Stripping before re-adding used to rewrite real titles: with --prefix
    // "old-", the title "old-notes" came out as "old-notes" with no marker and
    // "notes" recorded as the original.
    expect(applyPrefix('old-notes', 'old-')).toBe('old-notes');
    expect(applyPrefix('↪ ↪ double', MARKER)).toBe('↪ ↪ double');
  });

  it('tolerates a missing title', () => {
    expect(applyPrefix(undefined, MARKER)).toBe(MARKER);
  });
});

describe('buildFosterCopy', () => {
  const source = session({ title: 'Refactor parser' });

  it('mints a fresh sessionId so deleting the copy cannot reach the original', () => {
    const copy = buildFosterCopy(source, { origin: OLD_ACCOUNT });
    expect(copy.sessionId).not.toBe(source.sessionId);
    expect(copy.sessionId).toMatch(/^local_/);
  });

  it('keeps the cliSessionId, which is what loads the transcript', () => {
    const copy = buildFosterCopy(source, { origin: OLD_ACCOUNT });
    expect(copy.cliSessionId).toBe(source.cliSessionId);
  });

  it('strips a stale error inherited from the origin account', () => {
    const failed = session({ error: 'You have hit your weekly limit', errorAt: 1_700_000_300_000 });
    const copy = buildFosterCopy(failed, { origin: OLD_ACCOUNT });
    expect(copy.error).toBeUndefined();
    expect(copy.errorAt).toBeUndefined();
  });

  it('records its own origin so the file is self-describing', () => {
    const copy = buildFosterCopy(source, { origin: OLD_ACCOUNT, now: 42 });
    expect(copy._foster).toMatchObject({
      originAccountUuid: OLD_ACCOUNT.accountUuid,
      originOrganizationUuid: OLD_ACCOUNT.organizationUuid,
      originSessionId: source.sessionId,
      fosteredAt: 42,
    });
  });

  it('preserves unknown keys untouched', () => {
    const withExtras = session({ someFutureField: { nested: true } });
    const copy = buildFosterCopy(withExtras, { origin: OLD_ACCOUNT });
    expect(copy.someFutureField).toEqual({ nested: true });
  });

  /**
   * The claim is on the card; the lease is in the app's store, under the session
   * id that took it out. A copy has a new id, so carrying the claim across is
   * how two cards come to name one directory — and a branch only checks out in
   * one worktree, so the app refuses whichever card it reaches second and drops
   * that session into the main repository.
   */
  it('drops the worktree the original holds, whose lease the copy cannot have', () => {
    const held = session({
      cwd: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      originCwd: '/workspace/project',
      worktreePath: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      worktreeName: 'topic-a1b2c3',
    });
    const copy = buildFosterCopy(held, { origin: OLD_ACCOUNT });
    expect(copy.worktreePath).toBeUndefined();
    expect(copy.worktreeName).toBeUndefined();
  });

  it('opens the copy in the repository the worktree was cut from', () => {
    const held = session({
      cwd: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      originCwd: '/workspace/project',
      worktreePath: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      worktreeName: 'topic-a1b2c3',
    });
    const copy = buildFosterCopy(held, { origin: OLD_ACCOUNT });
    expect(copy.cwd).toBe('/workspace/project');
  });

  /** Nothing to relocate to, so the directory is left as it was found. */
  it('leaves cwd alone when the source names a worktree but no repository', () => {
    const held = session({
      cwd: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      worktreePath: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      worktreeName: 'topic-a1b2c3',
    });
    delete held.originCwd;
    const copy = buildFosterCopy(held, { origin: OLD_ACCOUNT });
    expect(copy.cwd).toBe('/workspace/project/.claude/worktrees/topic-a1b2c3');
  });

  /**
   * Most cards sitting in a worktree never name one: on a real store, 2798 of
   * the 3898 with a `cwd` under `.claude/worktrees/` carried no `worktreePath`.
   * A copy of one used to open inside another card's directory, which is why
   * the directory itself has to be read and not just the fields.
   */
  it('relocates a copy sitting in a worktree the card never named', () => {
    const held = session({
      cwd: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      originCwd: '/workspace/project',
    });
    const copy = buildFosterCopy(held, { origin: OLD_ACCOUNT });
    expect(copy.cwd).toBe('/workspace/project');
  });

  /** A worktree promised but not yet cut is still a claim the copy cannot hold. */
  it('drops a lazy worktree the same way', () => {
    const promised = session({
      worktreeLazy: { path: '/workspace/project/.claude/worktrees/topic-a1b2c3' },
    });
    const copy = buildFosterCopy(promised, { origin: OLD_ACCOUNT });
    expect(copy.worktreeLazy).toBeUndefined();
  });

  it('leaves the working directory untouched when it is already the repository', () => {
    const copy = buildFosterCopy(
      session({ cwd: '/workspace/elsewhere', originCwd: '/workspace/elsewhere' }),
      { origin: OLD_ACCOUNT },
    );
    expect(copy.cwd).toBe('/workspace/elsewhere');
  });

  it('does not mutate the source', () => {
    // Carries a worktree, so the removal and the relocation are both exercised
    // against the original rather than skipped over.
    const original = session({
      title: 'Refactor parser',
      cwd: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      originCwd: '/workspace/project',
      worktreePath: '/workspace/project/.claude/worktrees/topic-a1b2c3',
      worktreeName: 'topic-a1b2c3',
    });
    const snapshot = structuredClone(original);
    buildFosterCopy(original, { origin: OLD_ACCOUNT });
    expect(original).toEqual(snapshot);
  });
});

describe('worktreeClaim', () => {
  it('is undefined for a card sitting in no worktree at all', () => {
    expect(worktreeClaim(session())).toBeUndefined();
  });

  it('names what a release would remove, and where cwd would move to', () => {
    const held = session({
      cwd: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      originCwd: 'C:\\home\\repo',
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
    });
    expect(worktreeClaim(held)).toEqual({
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
      cwdTo: 'C:\\home\\repo',
    });
  });

  it('leaves cwd out when it already reads as the repository', () => {
    // The claim fields alone are enough to call this a claim, even though the
    // directory itself is already the repository — nothing left to relocate.
    const held = session({
      cwd: 'C:\\home\\repo',
      originCwd: 'C:\\home\\repo',
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
    });
    expect(worktreeClaim(held)).toEqual({
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
    });
  });

  it('recognises a worktree the card never named, by the directory alone', () => {
    const held = session({
      cwd: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      originCwd: 'C:\\home\\repo',
    });
    expect(worktreeClaim(held)).toEqual({ cwdTo: 'C:\\home\\repo' });
  });

  it('treats a lazy worktree promise as a claim too', () => {
    const promised = session({
      worktreeLazy: { path: 'C:\\home\\repo\\.claude\\worktrees\\wt-a' },
    });
    expect(worktreeClaim(promised)).toEqual({
      worktreeLazy: { path: 'C:\\home\\repo\\.claude\\worktrees\\wt-a' },
    });
  });

  it('has nowhere to send cwd when the card names no repository', () => {
    const held = session({
      cwd: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
    });
    delete held.originCwd;
    expect(worktreeClaim(held)).toEqual({
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
    });
  });
});

describe('unfosterableReasons', () => {
  it('accepts an ordinary session', () => {
    expect(unfosterableReasons(session())).toEqual([]);
  });

  it('rejects scheduled-task sessions, which the sidebar lists elsewhere', () => {
    expect(unfosterableReasons(session({ scheduledTaskId: 'nightly-job' }))).toContain(
      'scheduled-task',
    );
  });

  it('rejects sessions that were never opened, which never reach Recents', () => {
    const never = session();
    delete never.lastFocusedAt;
    expect(unfosterableReasons(never)).toContain('never-opened');
  });

  it('rejects a file that is already a foster copy', () => {
    const copy = buildFosterCopy(session(), { origin: OLD_ACCOUNT });
    expect(unfosterableReasons(copy)).toContain('already-a-copy');
  });
});

describe('identity', () => {
  it('mints unique ids', () => {
    expect(mintSessionId()).not.toBe(mintSessionId());
  });

  it('keys a fostering by origin session and target account', () => {
    const key = fosteringKey('local_abc', NEW_ACCOUNT);
    expect(key).toContain('local_abc');
    expect(key).toContain(NEW_ACCOUNT.accountUuid);
  });
});

describe('a copy of a session that never got a title', () => {
  /**
   * Applying the prefix to nothing produced a copy called "↪ " — a marker and no
   * information. Observed on a real session while fostering across profiles.
   */
  it('says it had no title rather than showing a bare marker', () => {
    const untitled = session();
    delete untitled.title;

    const copy = buildFosterCopy(untitled, { origin: OLD_ACCOUNT, prefix: MARKER });
    expect(copy.title).toBe('↪ (untitled)');
  });

  it('treats a blank title the same as none', () => {
    const copy = buildFosterCopy(session({ title: '   ' }), {
      origin: OLD_ACCOUNT,
      prefix: MARKER,
    });
    expect(copy.title).toBe('↪ (untitled)');
  });

  /**
   * With no marker the fallback is the whole of what the row says, so it has to
   * survive on its own: a copy titled '' would be labelled "General coding
   * session" by the app, which is every other untitled row too.
   */
  it('still says (untitled) when there is no prefix to carry it', () => {
    const untitled = session();
    delete untitled.title;

    const copy = buildFosterCopy(untitled, { origin: OLD_ACCOUNT });
    expect(copy.title).toBe('(untitled)');
  });

  it('leaves a real title alone', () => {
    const copy = buildFosterCopy(session({ title: 'Refactor parser' }), { origin: OLD_ACCOUNT });
    expect(copy.title).toBe('Refactor parser');
  });
});

/**
 * A session the app spawned from a background-task chip.
 *
 * Measured on a real store before this existed: one such session carried a whole
 * piece of work — the transcript ran to 562 turns and the change it produced was
 * merged — and had no card in any account. It was classified `never-opened`,
 * counted under "can never come", and came within one question of being deleted
 * as an empty record.
 */
describe('sessions the app spawned', () => {
  const spawned = (overrides = {}) => {
    const data = session({
      spawnedFrom: { sessionId: 'local_parent', taskId: 'task_1', title: 'Sample session' },
      ...overrides,
    });
    delete data.lastFocusedAt;
    return data;
  };

  it('is held back on its own reason, not lumped in with schedules', () => {
    const reasons = unfosterableReasons(spawned());
    expect(reasons).toContain('spawned-task');
    expect(reasons).not.toContain('scheduled-task');
  });

  it('is still never-opened, because nobody was there to open it', () => {
    expect(unfosterableReasons(spawned())).toContain('never-opened');
  });

  /**
   * The guard that keeps this from being a sweeping regression. `spawnedFrom`
   * records who started the work, not where the card is filed: a spawned session
   * the user opened is an ordinary visible row. On the store this was written
   * against, 994 of 995 sessions carrying the field had been opened — treating
   * the field alone as a reason would have held back all of them, and a sweep
   * would have quietly left them behind.
   */
  it('does not hold back a spawned session that was opened', () => {
    const opened = session({
      spawnedFrom: { sessionId: 'local_parent', taskId: 'task_1' },
      lastFocusedAt: 1_700_000_200_000,
    });
    expect(unfosterableReasons(opened)).toEqual([]);
  });

  it('an ordinary session is untouched by any of this', () => {
    expect(unfosterableReasons(session())).toEqual([]);
  });

  /**
   * The link names a session in the origin account and a chip this account does
   * not have. Carried across it would describe a parent that cannot be opened;
   * dropped, what is left is an ordinary conversation.
   */
  it('the copy drops the link back to the chip', () => {
    const copy = buildFosterCopy(spawned(), { origin: OLD_ACCOUNT });
    expect(copy.spawnedFrom).toBeUndefined();
  });

  it('the copy gets a focus time, or it would be correct and invisible', () => {
    const copy = buildFosterCopy(spawned(), { origin: OLD_ACCOUNT, now: 1_700_000_500_000 });
    expect(copy.lastFocusedAt).toBe(1_700_000_500_000);
    expect(unfosterableReasons(copy)).not.toContain('never-opened');
  });

  it('keeps a focus time it already had rather than inventing a newer one', () => {
    const focused = session({
      spawnedFrom: { taskId: 'task_1' },
      lastFocusedAt: 1_700_000_200_000,
    });
    const copy = buildFosterCopy(focused, { origin: OLD_ACCOUNT, now: 1_700_000_500_000 });
    expect(copy.lastFocusedAt).toBe(1_700_000_200_000);
  });
});
