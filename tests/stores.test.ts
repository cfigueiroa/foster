import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownStores, resolveStoreArg } from '../src/engine/stores.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import type { LedgerEvent } from '../src/ledger/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

/**
 * Which installations foster can name without being told. Getting this wrong is
 * quiet: a profile that is missing from the list is one the user has to type the
 * path of, every time, and a directory listed twice reads as a second
 * installation that does not exist.
 */

function running(root: string): ProcessRow[] {
  return [
    {
      pid: 500,
      parentPid: 9,
      name: 'claude.exe',
      path: 'C:\\Apps\\Claude.exe',
      commandLine: `"Claude.exe" --user-data-dir="${root}"`,
    },
  ];
}

function fostered(copyPath: string): LedgerEvent {
  return {
    v: 1,
    ts: 1_700_000_000_000,
    toolVersion: '0.0.0-test',
    kind: 'fostered',
    originSessionId: 'local_00000000-0000-4000-8000-0000000000d1',
    origin: OLD_ACCOUNT,
    target: NEW_ACCOUNT,
    copySessionId: 'local_00000000-0000-4000-8000-0000000000d2',
    copyPath,
    prefix: '',
  };
}

/** Where a copy fostered into that store would sit. */
function copyIn(root: string): string {
  return path.join(
    root,
    'claude-code-sessions',
    NEW_ACCOUNT.accountUuid,
    NEW_ACCOUNT.organizationUuid,
    'local_00000000-0000-4000-8000-0000000000d2.json',
  );
}

describe('knownStores', () => {
  it('keeps a running profile that has no sessions directory yet', () => {
    // Exactly the store you would be sending sessions *to*: it exists, it is up,
    // and nobody has started a Code session in it. An earlier version required a
    // sessions directory and hid it.
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-fresh-'));

    const found = knownStores([], {}, () => running(profile));
    expect(found).toEqual([{ root: path.resolve(profile), hint: 'profile', running: false }]);
  });

  it('drops a store the ledger remembers but that has since gone', () => {
    const gone = path.join(tmpdir(), 'foster-removed-profile-that-does-not-exist');

    expect(knownStores([fostered(copyIn(gone))], {}, () => [])).toEqual([]);
  });

  it('offers a store it has fostered into before', () => {
    const other = makeStore();

    const found = knownStores([fostered(copyIn(other.root))], {}, () => []);
    expect(found.map((store) => store.root)).toEqual([other.root]);
    expect(found[0]!.hint).toBe('used before');
  });

  it('reports the account each installation holds, and when it has none', () => {
    // The question a second profile exists to answer. A store with no account
    // has not been signed into, which is why fostering into it refuses.
    const signedIn = makeStore();
    writeFileSync(
      signedIn.configFile,
      JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
      'utf8',
    );
    const fresh = mkdtempSync(path.join(tmpdir(), 'foster-signed-out-'));

    const found = knownStores([], { CLAUDE_USER_DATA_DIR: signedIn.root }, () => running(fresh));

    expect(found.find((store) => store.root === signedIn.root)?.accountUuid).toBe(
      NEW_ACCOUNT.accountUuid,
    );
    expect(found.find((store) => store.root === path.resolve(fresh))?.accountUuid).toBeUndefined();
  });

  it('names one directory once, however many ways lead to it', () => {
    // The installed store, reached again through the ledger. Listing it twice
    // would read as a second installation.
    const store = makeStore();

    const found = knownStores(
      [fostered(copyIn(store.root))],
      { CLAUDE_USER_DATA_DIR: store.root },
      () => running(store.root),
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.hint).toBe('installed app');
  });
});

describe('what --store names', () => {
  /**
   * The paths are long and a profile's is nobody's idea of memorable, so a
   * distinctive piece of one is accepted — the same abbreviation the identifier
   * flags already allow. The guess decides which installation gets written to,
   * so an ambiguous one is refused rather than resolved.
   */
  it('takes a directory that exists as a directory', () => {
    const store = makeStore();
    expect(
      resolveStoreArg(
        store.root,
        () => [],
        {},
        () => [],
      ).root,
    ).toBe(store.root);
  });

  it('accepts a distinctive piece of a known path', () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-distinctive-'));
    const piece = path.basename(profile).slice(-8);

    expect(
      resolveStoreArg(
        piece,
        () => [],
        {},
        () => running(profile),
      ).root,
    ).toBe(path.resolve(profile));
  });

  it('refuses a piece that matches two installations', () => {
    const one = mkdtempSync(path.join(tmpdir(), 'foster-twin-'));
    const two = mkdtempSync(path.join(tmpdir(), 'foster-twin-'));
    const list = () => [...running(one), ...running(two).map((row) => ({ ...row, pid: 501 }))];

    expect(() => resolveStoreArg('foster-twin-', () => [], {}, list)).toThrow(
      /matches 2 installations/,
    );
  });

  it('says so rather than resolving a typo to an empty store', () => {
    // Silently returning a layout for a path that is not there would report no
    // sessions, which reads exactly like a store that has none.
    expect(() =>
      resolveStoreArg(
        'nowhere-at-all',
        () => [],
        {},
        () => [],
      ),
    ).toThrow(/not a directory/);
  });
});
