import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('a conversation the destination already shows', () => {
  /**
   * A conversation belongs to no account: it is one transcript that any account
   * can hold a card for. So the destination can perfectly well have its own card
   * for the conversation being fostered, made when the same work was resumed
   * under this account — and the fostering key cannot see it, because the origin
   * is the *other* account's card and has never been fostered before. The result
   * was two live rows for one conversation, which is what the sidebar showed.
   */
  const SHARED = '00000000-0000-4000-8000-0000000000e9';

  function bothHaveIt(archived = false): { store: StoreLayout; ledger: Ledger } {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000e1', cliSessionId: SHARED }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000e2',
        cliSessionId: SHARED,
        isArchived: archived,
      }),
    );
    return { store, ledger: ledgerIn() };
  }

  it('is not fostered a second time', () => {
    const { store, ledger } = bothHaveIt();

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(outcome!.status).toBe('skipped');
    expect(outcome!.detail).toMatch(/already has that conversation/);
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });

  it('says so when the row it already has is archived', () => {
    // The answer to wanting it back is to unarchive, not to add a second row.
    const { store, ledger } = bothHaveIt(true);

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(outcome!.detail).toMatch(/archived/);
  });

  it('still does it when the session is named outright', () => {
    const { store, ledger } = bothHaveIt();

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      explicit: true,
    });

    expect(outcome!.status).toBe('fostered');
  });

  it('does not build the pair itself out of two source accounts in one run', () => {
    // Both source accounts hold a card for one conversation. Neither is in the
    // destination yet, so a disk check alone passes twice and foster produces
    // exactly the duplicate it is meant to prevent.
    const store = makeStore();
    const secondOrg = {
      accountUuid: OLD_ACCOUNT.accountUuid,
      organizationUuid: '00000000-0000-4000-8000-0000000000ef',
    };
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000e5', cliSessionId: SHARED }),
    );
    writeSession(
      store,
      secondOrg,
      session({ sessionId: '00000000-0000-4000-8000-0000000000e6', cliSessionId: SHARED }),
    );

    const outcomes = fosterSessions(
      [...scanAccount(store, OLD_ACCOUNT), ...scanAccount(store, secondOrg)],
      { store, ledger: ledgerIn(), target: NEW_ACCOUNT },
    );

    expect(outcomes.filter((o) => o.status === 'fostered')).toHaveLength(1);
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
  });
});

/**
 * A copy the app has repointed at a different conversation.
 *
 * Opening a copy of a conversation that a live process is writing makes the app
 * branch it: a new transcript, a new id, and the card moved onto the branch. The
 * file is still there and still works — for the branch. The conversation it was
 * fostered for now has no card in that account at all, and the ledger, which only
 * knows a file was written, kept answering "already fostered".
 */
describe('a copy the app repointed at another conversation', () => {
  const ORIGIN = '00000000-0000-4000-8000-0000000000c1';
  const TRUNK = '00000000-0000-4000-8000-0000000000c2';
  const BRANCH = '00000000-0000-4000-8000-0000000000c3';

  function fosterOnce(store: StoreLayout, ledger: Ledger) {
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORIGIN, cliSessionId: TRUNK }));
    return fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });
  }

  it('is seen as repurposed rather than present', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-r-')), 'l.jsonl'));
    fosterOnce(store, ledger);

    const [active] = listActive(project(ledger.read()));
    // The app rewrites the card onto the branch it just made.
    const copy = JSON.parse(readFileSync(active!.copyPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(active!.copyPath, JSON.stringify({ ...copy, cliSessionId: BRANCH }), 'utf8');

    expect(inspectCopy(active!)).toEqual({ kind: 'repurposed', nowHolds: BRANCH });
  });

  it('lets the conversation be fostered again, and leaves the branch card alone', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-r-')), 'l.jsonl'));
    fosterOnce(store, ledger);
    const [first] = listActive(project(ledger.read()));
    const copy = JSON.parse(readFileSync(first!.copyPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(first!.copyPath, JSON.stringify({ ...copy, cliSessionId: BRANCH }), 'utf8');

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(outcomes[0]!.status).toBe('fostered');
    // The branch card is a working row for the branch; removing it would delete
    // something the user can see.
    expect(existsSync(first!.copyPath)).toBe(true);
    // And the account now holds a card for the conversation that was asked for.
    const here = scanAccount(store, NEW_ACCOUNT).map((s) => s.data.cliSessionId);
    expect(here).toContain(TRUNK);
    expect(here).toContain(BRANCH);
  });

  it('still skips a copy that is present and unchanged', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-r-')), 'l.jsonl'));
    fosterOnce(store, ledger);

    const again = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
    });

    expect(again[0]!.status).toBe('skipped');
    expect(again[0]!.detail).toBe('already fostered');
  });
});

describe('fostering a conversation that is being written', () => {
  it('marks the outcome so the caller can warn, and copies it anyway', () => {
    // Never a refusal: copying the session you are working in is the ordinary
    // case. What a live writer changes is what the user should be told.
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-l-')), 'l.jsonl'));
    const cli = '00000000-0000-4000-8000-0000000000d4';
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d5', cliSessionId: cli }),
    );

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      live: new Set([cli]),
    });

    expect(outcome!.status).toBe('fostered');
    expect(outcome!.live).toBe(true);
  });

  it('leaves the flag off when nothing is writing it', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-l-')), 'l.jsonl'));
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d6' }),
    );

    const [outcome] = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      live: new Set(['00000000-0000-4000-8000-00000000ffff']),
    });

    expect(outcome!.live).toBeUndefined();
  });
});
