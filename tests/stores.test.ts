import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownStores } from '../src/engine/stores.js';
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
