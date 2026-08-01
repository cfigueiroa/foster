import { describe, expect, it } from 'vitest';
import {
  applyPrefix,
  buildFosterCopy,
  DEFAULT_PREFIX,
  fosteringKey,
  mintSessionId,
  stripPrefix,
  unfosterableReasons,
} from '../src/domain/fostering.js';
import { NEW_ACCOUNT, OLD_ACCOUNT, session } from './helpers/store.js';

describe('title prefix', () => {
  it('adds the prefix', () => {
    expect(applyPrefix('Refactor parser', DEFAULT_PREFIX)).toBe('↪ Refactor parser');
  });

  it('is idempotent — re-applying never stacks prefixes', () => {
    const once = applyPrefix('Refactor parser', DEFAULT_PREFIX);
    const twice = applyPrefix(once, DEFAULT_PREFIX);
    expect(twice).toBe(once);
  });

  it('round-trips back to the original title', () => {
    const prefixed = applyPrefix('Refactor parser', DEFAULT_PREFIX);
    expect(stripPrefix(prefixed, DEFAULT_PREFIX)).toBe('Refactor parser');
  });

  it('tolerates a missing title', () => {
    expect(applyPrefix(undefined, DEFAULT_PREFIX)).toBe(DEFAULT_PREFIX);
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
