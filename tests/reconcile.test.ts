import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fosterSessions } from '../src/engine/executor.js';
import { assertRemovable } from '../src/engine/safety.js';
import { inspectCopy } from '../src/engine/reconcile.js';
import { accountDir, tombstonePath } from '../src/domain/paths.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * A copy the ledger counts as active but that is not on disk. Left unexamined it
 * was a dead end: fostering the same session again was skipped as "already
 * fostered" while nothing was there.
 */

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-rec-')), 'l.jsonl'));
}

/** Fosters one session and returns the copy that landed. */
function fosterOne(store: StoreLayout, ledger: Ledger): { copyPath: string; originId: string } {
  const [session] = scanAccount(store, OLD_ACCOUNT);
  const [outcome] = fosterSessions([session!], { store, ledger, target: NEW_ACCOUNT });
  return { copyPath: outcome!.copyPath!, originId: outcome!.originSessionId };
}

function seed(): { store: StoreLayout; ledger: Ledger } {
  const store = makeStore();
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000c1', title: 'Work' }),
  );
  return { store, ledger: ledgerIn() };
}

describe('inspectCopy', () => {
  it('sees a copy that is there', () => {
    const { store, ledger } = seed();
    fosterOne(store, ledger);

    expect(inspectCopy(listActive(project(ledger.read()))[0]!)).toEqual({ kind: 'present' });
  });

  it('calls a copy gone when its directory lists without it', () => {
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    rmSync(copyPath);

    expect(inspectCopy(listActive(project(ledger.read()))[0]!)).toEqual({ kind: 'gone' });
  });

  it('recognises the marker the app leaves when the user deletes it', () => {
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    const fostering = listActive(project(ledger.read()))[0]!;
    rmSync(copyPath);
    writeFileSync(tombstonePath(store, NEW_ACCOUNT, fostering.copySessionId), '1700000000000');

    expect(inspectCopy(fostering)).toEqual({
      kind: 'deleted-in-app',
      deletedAt: 1_700_000_000_000,
    });
  });

  it('refuses to conclude anything when the installation is not there', () => {
    // A profile on a drive that is not mounted. "The file is missing" then means
    // "not right now", and deciding otherwise would put a second copy there when
    // the drive came back.
    const { store, ledger } = seed();
    fosterOne(store, ledger);
    const fostering = listActive(project(ledger.read()))[0]!;
    rmSync(store.root, { recursive: true, force: true });

    expect(inspectCopy(fostering)).toEqual({ kind: 'unreachable' });
  });

  it('still calls it gone when only the account directory was removed', () => {
    // Signing out of an account takes its whole tree with it, and that is not the
    // same as an installation that is not mounted.
    const { store, ledger } = seed();
    fosterOne(store, ledger);
    const fostering = listActive(project(ledger.read()))[0]!;
    rmSync(accountDir(store, NEW_ACCOUNT), { recursive: true, force: true });

    expect(inspectCopy(fostering)).toEqual({ kind: 'gone' });
  });
});

describe('fostering a session whose copy is no longer there', () => {
  it('makes it again, and records that the ledger was reconciled', () => {
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    rmSync(copyPath);

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(outcome!.status).toBe('fostered');
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
    // One active fostering, not two: the stale one was closed rather than left.
    expect(listActive(project(ledger.read()))).toHaveLength(1);
    const returned = ledger.read().filter((e) => e.kind === 'returned');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ reconciled: true });
  });

  it('does not bring back one the user deleted in the app', () => {
    // The marker says they threw it away on purpose. A sweep that recreated it
    // would undo that decision, quietly, for every copy at once.
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    const fostering = listActive(project(ledger.read()))[0]!;
    rmSync(copyPath);
    writeFileSync(tombstonePath(store, NEW_ACCOUNT, fostering.copySessionId), '1700000000000');

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(outcome!.status).toBe('skipped');
    expect(outcome!.detail).toMatch(/deleted in the app/);
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });

  it('brings it back when that session is named outright', () => {
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    const fostering = listActive(project(ledger.read()))[0]!;
    rmSync(copyPath);
    writeFileSync(tombstonePath(store, NEW_ACCOUNT, fostering.copySessionId), '1700000000000');

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      explicit: true,
    });

    expect(outcome!.status).toBe('fostered');
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
  });

  it('says where the copy is when it is still there', () => {
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(outcome!.status).toBe('skipped');
    expect(outcome!.copyPath).toBe(copyPath);
  });

  it('writes nothing to the ledger on a dry run', () => {
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    rmSync(copyPath);
    const before = ledger.read().length;

    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      dryRun: true,
    });

    expect(ledger.read()).toHaveLength(before);
  });
});

describe('returning a copy that is already gone', () => {
  it('is not blocked by the app that cannot be holding it', () => {
    // The gate asks whether a running app may hold the copy in memory. A file
    // that is not on disk cannot be held, and refusing here left the user with no
    // way out: closing the app changes nothing when there was never a file.
    const { store, ledger } = seed();
    const { copyPath } = fosterOne(store, ledger);
    rmSync(copyPath);

    // The real gate, not a stub: an app that started after the fostering would
    // otherwise be asked about, and answer, about a file that is not there.
    const active = listActive(project(ledger.read()));
    expect(() =>
      assertRemovable(store, active, () => [
        {
          pid: 500,
          parentPid: 9,
          name: 'claude.exe',
          path: 'C:\\Apps\\Claude.exe',
          commandLine: `"Claude.exe" --user-data-dir="${store.root}"`,
        },
      ]),
    ).not.toThrow();
  });
});
