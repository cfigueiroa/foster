import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLabelArgs } from '../src/engine/account.js';
import {
  accountDir,
  candidateStoreRoots,
  comparableUserDataDir,
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

describe('comparing userData directories', () => {
  /**
   * These come off a command line, not the filesystem, so the comparison has to
   * mean the same thing on every platform: CI runs these tests on Linux, where
   * `path.resolve` would treat a Windows path as one long relative name.
   */
  it('folds separators, case and a trailing separator', () => {
    expect(comparableUserDataDir('D:\\Store\\')).toBe(comparableUserDataDir('d:/store'));
  });

  it('still tells two directories apart', () => {
    expect(comparableUserDataDir('D:\\one')).not.toBe(comparableUserDataDir('D:\\two'));
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

  it('does not treat another candidate store as the same installation', () => {
    const one = makeStore();
    const two = makeStore();
    const identity = storeIdentity(one.root, { CLAUDE_USER_DATA_DIR: one.root });
    expect(identity.roots.every((root) => !samePath(root, two.root))).toBe(true);
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

describe('resolveLabelArgs', () => {
  const ACCOUNTS = ['00000000-0000-4000-8000-0000000000a7', '11111111-1111-4111-8111-111111111111'];
  const CURRENT = ACCOUNTS[0]!;

  it('takes one argument as the name of the account in use', () => {
    // The case that comes up most: you are looking at the app, which shows the
    // email, and foster already knows which directory the sidebar reads.
    expect(resolveLabelArgs('John', undefined, ACCOUNTS, CURRENT)).toEqual({
      accountUuid: CURRENT,
      label: 'John',
    });
  });

  it('resolves an abbreviated prefix to the account it names', () => {
    // The two-argument form takes a prefix like every other identifier does, so
    // the name is recorded against the account's full UUID — not against the
    // prefix, which would leave a label no lookup by account ever finds.
    expect(resolveLabelArgs('11111111', 'work', ACCOUNTS, CURRENT)).toEqual({
      accountUuid: '11111111-1111-4111-8111-111111111111',
      label: 'work',
    });
  });

  it('names an account that is not present here verbatim', () => {
    // `label` can name an account foster cannot see on this machine; a prefix
    // that matches nothing is that intent, not a typo to resolve away.
    expect(resolveLabelArgs('99999999', 'old personal', ACCOUNTS, CURRENT)).toEqual({
      accountUuid: '99999999',
      label: 'old personal',
    });
  });

  it('refuses an ambiguous prefix rather than guessing', () => {
    const ambiguous = [
      'aaaa1111-0000-4000-8000-000000000001',
      'aaaa2222-0000-4000-8000-000000000002',
    ];
    expect(() => resolveLabelArgs('aaaa', 'work', ambiguous, ambiguous[0])).toThrow(/ambiguous/);
  });

  it('refuses an identifier given on its own', () => {
    // Recording "00000000" as the *name* of a different account is the wrong
    // way to be wrong.
    expect(() => resolveLabelArgs('00000000', undefined, ACCOUNTS, CURRENT)).toThrow(
      /is an account id, not a name/,
    );
  });

  it('does not mistake a short name for an identifier', () => {
    expect(resolveLabelArgs('work', undefined, ACCOUNTS, CURRENT).label).toBe('work');
    expect(resolveLabelArgs('11', undefined, ACCOUNTS, CURRENT).label).toBe('11');
  });

  it('says what to type when given nothing', () => {
    expect(() => resolveLabelArgs(undefined, undefined, ACCOUNTS, CURRENT)).toThrow(
      /foster label <accountUuid>/,
    );
  });

  it('refuses the shorthand when no account is signed in', () => {
    expect(() => resolveLabelArgs('John', undefined, ACCOUNTS, undefined)).toThrow(
      /No account is recorded as signed in/,
    );
  });
});
