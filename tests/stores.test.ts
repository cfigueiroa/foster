import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownStores, resolveStoreArg } from '../src/engine/stores.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import type { LedgerEvent } from '../src/ledger/types.js';
import type { StoreLayout } from '../src/domain/types.js';
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

function registered(name: string, root: string): LedgerEvent {
  return {
    v: 1,
    ts: 1_700_000_000_000,
    toolVersion: '0.0.0-test',
    kind: 'profile_registered',
    name,
    root,
  };
}

function labelled(accountUuid: string, label: string): LedgerEvent {
  return {
    v: 1,
    ts: 1_700_000_000_000,
    toolVersion: '0.0.0-test',
    kind: 'account_labelled',
    accountUuid,
    label,
  };
}

function identitySeen(accountUuid: string, email: string): LedgerEvent {
  return {
    v: 1,
    ts: 1_700_000_000_000,
    toolVersion: '0.0.0-test',
    kind: 'account_identity_seen',
    accountUuid,
    email,
  };
}

/** A store signed into the given account, findable by `knownStores`. */
function signedInto(accountUuid: string): StoreLayout {
  const store = makeStore();
  writeFileSync(store.configFile, JSON.stringify({ lastKnownAccountUuid: accountUuid }), 'utf8');
  return store;
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
    expect(found).toEqual([
      { root: path.resolve(profile), hint: 'profile', running: false, exists: true },
    ]);
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
    // The env-var profile, reached again through the ledger. Listing it twice
    // would read as a second installation.
    const store = makeStore();

    const found = knownStores(
      [fostered(copyIn(store.root))],
      { CLAUDE_USER_DATA_DIR: store.root },
      () => running(store.root),
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.hint).toBe('profile');
  });

  it('offers a registered profile that has neither run nor been fostered into', () => {
    // The whole reason to register one: a profile that has not started yet, and
    // has no fostered copy in it, is otherwise invisible to `knownStores`.
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-registered-'));

    const found = knownStores([registered('work', profile)], {}, () => []);
    expect(found).toEqual([
      {
        root: path.resolve(profile),
        name: 'work',
        hint: 'registered',
        running: false,
        exists: true,
      },
    ]);
  });

  it('keeps a registered profile that has since gone, marked exists: false', () => {
    // Every other hint drops a directory that is no longer there. A registered
    // name is the one exception, because `foster profile forget` needs
    // something to name when it tells the user their profile has vanished.
    const gone = path.join(tmpdir(), 'foster-registered-gone-that-does-not-exist');

    const found = knownStores([registered('work', gone)], {}, () => []);
    expect(found).toEqual([
      { root: path.resolve(gone), name: 'work', hint: 'registered', running: false, exists: false },
    ]);
  });

  it('attaches a registered name to an env-var profile instead of duplicating it', () => {
    const store = makeStore();

    const found = knownStores(
      [registered('main', store.root)],
      { CLAUDE_USER_DATA_DIR: store.root },
      () => [],
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ hint: 'profile', name: 'main', exists: true });
  });

  it('attaches a registered name to a running profile instead of duplicating it', () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-registered-running-'));

    const found = knownStores([registered('work', profile)], {}, () => running(profile));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ hint: 'profile', name: 'work', exists: true });
  });

  it('reports presence of a cached login without reading the blob', () => {
    // Presence only, from either the current key or the one it replaced — never
    // the value, which is why the fixture below is a string that must never
    // reach the result, in any form.
    const store = makeStore();
    const opaque = 'SHOULD-NEVER-BE-READ-fdd93c2b8a1e';
    writeFileSync(store.configFile, JSON.stringify({ 'oauth:tokenCacheV2': opaque }), 'utf8');

    const found = knownStores([], { CLAUDE_USER_DATA_DIR: store.root }, () => []);

    expect(found.find((known) => known.root === store.root)?.hasTokenCache).toBe(true);
    expect(JSON.stringify(found)).not.toContain(opaque);
  });

  it('says nothing about presence when neither cache key is there', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);

    const found = knownStores([], { CLAUDE_USER_DATA_DIR: store.root }, () => []);

    expect(found.find((known) => known.root === store.root)?.hasTokenCache).toBeUndefined();
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

describe('what --store names, by registered name and by account', () => {
  it('resolves by registered name before falling back to a path piece', () => {
    // "work" is both a registered name and, coincidentally, a piece of the decoy
    // profile's own path. The deliberate match wins.
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-named-'));
    const decoy = mkdtempSync(path.join(tmpdir(), 'work-decoy-'));

    const found = resolveStoreArg(
      'work',
      () => [registered('work', profile)],
      {},
      () => running(decoy),
    );

    expect(found.root).toBe(path.resolve(profile));
  });

  it('resolves a registered name case-insensitively', () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-named-case-'));

    const found = resolveStoreArg(
      'WORK',
      () => [registered('work', profile)],
      {},
      () => [],
    );

    expect(found.root).toBe(path.resolve(profile));
  });

  it('names which profile is missing when a registered name points at a gone directory', () => {
    const gone = path.join(tmpdir(), 'foster-named-gone-that-does-not-exist');

    expect(() =>
      resolveStoreArg(
        'work',
        () => [registered('work', gone)],
        {},
        () => [],
      ),
    ).toThrow(/profile "work" is registered at .*, which is gone/);
  });

  it('resolves an account label to the only store last seen with it', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);

    const found = resolveStoreArg(
      'work',
      () => [labelled(NEW_ACCOUNT.accountUuid, 'work')],
      { CLAUDE_USER_DATA_DIR: store.root },
      () => [],
    );

    expect(found.root).toBe(store.root);
  });

  it('resolves an e-mail to the only store last seen with that account', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);

    const found = resolveStoreArg(
      'you@example.com',
      () => [identitySeen(NEW_ACCOUNT.accountUuid, 'you@example.com')],
      { CLAUDE_USER_DATA_DIR: store.root },
      () => [],
    );

    expect(found.root).toBe(store.root);
  });

  it('resolves a unique uuid prefix to the store last seen with that account', () => {
    const store = signedInto(NEW_ACCOUNT.accountUuid);
    const prefix = NEW_ACCOUNT.accountUuid.slice(0, 8);

    const found = resolveStoreArg(
      prefix,
      () => [],
      { CLAUDE_USER_DATA_DIR: store.root },
      () => [],
    );

    expect(found.root).toBe(store.root);
  });

  it('refuses a label two stores were last seen with', () => {
    // The installed app and a separate running profile happen to share the same
    // account — a real state, since a profile can be pointed at any account. The
    // label cannot say which of the two the user means.
    const installed = signedInto(NEW_ACCOUNT.accountUuid);
    const profile = signedInto(NEW_ACCOUNT.accountUuid);

    expect(() =>
      resolveStoreArg(
        'work',
        () => [labelled(NEW_ACCOUNT.accountUuid, 'work')],
        { CLAUDE_USER_DATA_DIR: installed.root },
        () => running(profile.root),
      ),
    ).toThrow(/names an account last seen by 2 installations/);
  });

  it('falls through to the path-piece pass when no rule names an account', () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'foster-fallback-'));
    const piece = path.basename(profile).slice(-8);

    const found = resolveStoreArg(
      piece,
      () => [],
      {},
      () => running(profile),
    );

    expect(found.root).toBe(path.resolve(profile));
  });

  it('excludes a gone registered profile from the path-piece pass', () => {
    // The name is the sanctioned way to reach a gone profile, with a refusal
    // that says so — matching it again by path piece here would silently
    // resolve to a directory that is not there.
    const gone = path.join(tmpdir(), 'foster-gone-piece-that-does-not-exist');

    expect(() =>
      resolveStoreArg(
        'gone-piece',
        () => [registered('elsewhere', gone)],
        {},
        () => [],
      ),
    ).toThrow(/not a directory/);
  });
});
