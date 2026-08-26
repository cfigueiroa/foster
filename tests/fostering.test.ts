import { describe, expect, it } from 'vitest';
import {
  applyPrefix,
  buildFosterCopy,
  DEFAULT_PREFIX,
  fosteringKey,
  mintSessionId,
  unfosterableReasons,
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

  it('does not mutate the source', () => {
    const original = session({ title: 'Refactor parser' });
    const snapshot = structuredClone(original);
    buildFosterCopy(original, { origin: OLD_ACCOUNT });
    expect(original).toEqual(snapshot);
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
