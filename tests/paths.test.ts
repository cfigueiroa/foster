import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountDir,
  candidateStoreRoots,
  layoutFor,
  pickActiveOrganization,
  samePath,
  storeIdentity,
  storeRootOfCopy,
} from '../src/domain/paths.js';
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

describe('comparing store paths', () => {
  /**
   * Two spellings of one directory must not look like two installations: that
   * would make a return run report nothing fostered rather than fail.
   */
  it('ignores a trailing separator and relative segments', () => {
    expect(samePath('C:/a/b', 'C:/a/b/')).toBe(true);
    expect(samePath('C:/a/b', 'C:/a/x/../b')).toBe(true);
  });

  it('ignores capitalisation on Windows, where the filesystem does', () => {
    const differs = samePath('D:/Profiles/Store', 'd:/profiles/store');
    expect(differs).toBe(process.platform === 'win32');
  });

  it('still tells genuinely different directories apart', () => {
    expect(samePath('C:/a/one', 'C:/a/two')).toBe(false);
  });
});

describe('storeRootOfCopy', () => {
  it('reads the store back out of a copy path', () => {
    const store = makeStore();
    const copy = path.join(
      accountDir(store, NEW_ACCOUNT),
      'local_00000000-0000-4000-8000-00000000abcd.json',
    );
    expect(samePath(storeRootOfCopy(copy), store.root)).toBe(true);
  });
});

describe('storeIdentity', () => {
  /**
   * This is what decides which app a status — or a close — reaches. The default
   * installation answers to more than one path and its main process carries no
   * --user-data-dir; a profile is the opposite on both counts.
   */
  it('gives the default store every name the environment knows it by', () => {
    const store = makeStore();
    const identity = storeIdentity(store.root, { CLAUDE_USER_DATA_DIR: store.root });

    expect(identity.isDefault).toBe(true);
    expect(identity.roots).toContain(store.root);
  });

  it('gives a profile only its own path, and no claim on switchless processes', () => {
    // Nothing in this environment resolves to the profile, which is exactly the
    // situation --store creates: a store foster was pointed at by hand.
    const identity = storeIdentity(makeStore().root, {});

    expect(identity.isDefault).toBe(false);
    expect(identity.roots).toHaveLength(1);
  });
});

describe('layoutFor', () => {
  it('normalises the root so one store has one spelling', () => {
    // A path typed with forward slashes on Windows otherwise reaches the screen
    // as a mixture, and compares unequal against the same directory.
    const mixed = layoutFor('C:/one/two/../two');
    expect(mixed.root).toBe(path.resolve('C:/one/two'));
    expect(mixed.codeSessionsDir.startsWith(mixed.root)).toBe(true);
  });
});
