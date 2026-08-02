import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountDir, candidateStoreRoots, pickActiveOrganization } from '../src/domain/paths.js';
import { makeStore, NEW_ACCOUNT } from './helpers/store.js';

/**
 * Which organization the sidebar reads is not recorded anywhere, so it is
 * inferred. Getting it wrong is quiet and confusing: copies land in a directory
 * the app never opens, and simply never appear.
 */
describe('pickActiveOrganization', () => {
  const second = {
    accountUuid: NEW_ACCOUNT.accountUuid,
    organizationUuid: '11111111-1111-4111-8111-1111111122ff',
  };

  it('returns the only organization when there is no choice to make', () => {
    expect(pickActiveOrganization([NEW_ACCOUNT], makeStore())).toEqual(NEW_ACCOUNT);
  });

  it('returns undefined when the account has no directory at all', () => {
    expect(pickActiveOrganization([], makeStore())).toBeUndefined();
  });

  it('prefers the organization the app touched most recently', () => {
    const store = makeStore();
    for (const ref of [NEW_ACCOUNT, second]) mkdirSync(accountDir(store, ref), { recursive: true });

    const later = new Date(Date.now() + 60_000);
    utimesSync(accountDir(store, second), later, later);

    expect(pickActiveOrganization([NEW_ACCOUNT, second], store)).toEqual(second);
  });
});

describe('candidateStoreRoots', () => {
  it('takes the profile override the app itself honours', () => {
    // CLAUDE_USER_DATA_DIR becomes userData at the app's entry point, so a store
    // reached that way is the one the app is actually using.
    const store = makeStore();
    const roots = candidateStoreRoots({ CLAUDE_USER_DATA_DIR: store.root });

    expect(roots[0]).toBe(store.root);
  });

  it('ignores an override pointing at something that is not a store', () => {
    // Only directories that actually hold sessions are offered, override or not.
    expect(
      candidateStoreRoots({ CLAUDE_USER_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'x-')) }),
    ).toHaveLength(0);
  });

  it('finds nothing when the environment names nowhere to look', () => {
    expect(candidateStoreRoots({})).toEqual([]);
  });
});
