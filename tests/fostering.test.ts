import { describe, expect, it } from 'vitest';
import {
  applyPrefix,
  buildFosterCopy,
  copyCwd,
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

/**
 * #41: `copyCwd` used to send every worktree card to `originCwd` regardless of
 * what either directory could actually reach. `reach` is the caller's own
 * measurement — plain numbers, never a `Lineage` — so these are pure, with no
 * transcript on disk; the multi-file version of this, through `fosterSessions`,
 * lives in `tests/executor.test.ts`.
 */
describe('copyCwd', () => {
  const held = () =>
    session({
      cwd: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      originCwd: 'C:\\home\\repo',
      worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
      worktreeName: 'wt-a',
    });

  it('keeps sending the copy to the repository with no reach to compare', () => {
    expect(copyCwd(held())).toBe('C:\\home\\repo');
  });

  it('keeps sending it there when the two are tied, or neither is measurable', () => {
    expect(copyCwd(held(), { atCwd: 3, atOriginCwd: 3 })).toBe('C:\\home\\repo');
    expect(copyCwd(held(), { atCwd: undefined, atOriginCwd: undefined })).toBe('C:\\home\\repo');
    // A directory nobody could measure never outranks the repository — an
    // unmeasurable `atCwd` is not treated as "reaches nothing", but it does not
    // win either.
    expect(copyCwd(held(), { atCwd: undefined, atOriginCwd: 1 })).toBe('C:\\home\\repo');
  });

  it('sends the copy to the worktree once it measurably reaches more', () => {
    expect(copyCwd(held(), { atCwd: 5, atOriginCwd: 2 })).toBe(
      'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    );
  });

  it('sends it to the worktree when the repository is not measurable at all', () => {
    // The "13 open nothing" case: nothing under the repository's project
    // directory matches this conversation, so `atOriginCwd` cannot be measured.
    expect(copyCwd(held(), { atCwd: 1, atOriginCwd: undefined })).toBe(
      'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    );
  });

  it('is unaffected by reach when the card is not in a worktree at all', () => {
    expect(copyCwd(session(), { atCwd: 1, atOriginCwd: 99 })).toBe('/workspace/project');
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
