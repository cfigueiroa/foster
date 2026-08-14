import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fosterSessions } from '../src/engine/executor.js';
import { inspectCopy } from '../src/engine/reconcile.js';
import { repointCards, undoRequests } from '../src/engine/repoint.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, listRepointed, project } from '../src/ledger/project.js';
import type { CodeSessionData } from '../src/domain/types.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * The one write foster makes to a file it did not create.
 *
 * What it does not touch is as much the point as what it does, so most of this
 * is about everything staying where it was.
 */

const TRUNK = '00000000-0000-4000-8000-0000000000b1';
const TIP = '00000000-0000-4000-8000-0000000000b2';

const noGuard = (): void => {};
const refuse = (): never => {
  throw new Error('Claude Desktop is running');
};

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-rp-')), 'l.jsonl'));
}

function read(file: string): CodeSessionData {
  return JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
}

describe('repointCards', () => {
  it('changes the pointer and the date, and nothing else', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({
      sessionId: '00000000-0000-4000-8000-0000000000b3',
      cliSessionId: TRUNK,
      title: 'Solar plan',
      lastActivityAt: 1_700_000_100_000,
      // A key foster has no opinion about, which the app may well have added.
      somethingTheAppAdded: { nested: true },
    });
    const file = writeSession(store, NEW_ACCOUNT, before);

    const [outcome] = repointCards(
      [{ path: file, target: NEW_ACCOUNT, to: TIP, native: true, activityAt: 1_800_000_000_000 }],
      { store, ledger, guard: noGuard },
    );

    expect(outcome!.status).toBe('repointed');
    const after = read(file);
    expect(after.cliSessionId).toBe(TIP);
    expect(after.lastActivityAt).toBe(1_800_000_000_000);
    expect({ ...after, cliSessionId: TRUNK, lastActivityAt: before.lastActivityAt }).toEqual(
      before,
    );
  });

  it('refuses the whole batch while an app holds the cards', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b4', cliSessionId: TRUNK }),
    );

    expect(() =>
      repointCards([{ path: file, target: NEW_ACCOUNT, to: TIP, native: true }], {
        store,
        ledger,
        guard: refuse,
      }),
    ).toThrow(/running/);

    // Nothing written, and nothing claimed: a card the app holds is one it writes
    // back from memory, so a recorded move that did not survive would be worse
    // than no move at all.
    expect(read(file).cliSessionId).toBe(TRUNK);
    expect(ledger.read()).toHaveLength(0);
  });

  it('writes nothing on a dry run', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b5', cliSessionId: TRUNK }),
    );

    const [outcome] = repointCards([{ path: file, target: NEW_ACCOUNT, to: TIP, native: true }], {
      store,
      ledger,
      dryRun: true,
    });

    expect(outcome!.status).toBe('repointed');
    expect(read(file).cliSessionId).toBe(TRUNK);
    expect(ledger.read()).toHaveLength(0);
  });

  it('skips a card that is already there rather than recording a move', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b6', cliSessionId: TIP }),
    );

    const [outcome] = repointCards([{ path: file, target: NEW_ACCOUNT, to: TIP, native: true }], {
      store,
      ledger,
      guard: noGuard,
    });

    expect(outcome!.status).toBe('skipped');
    // An event here would give --undo a move to reverse that never happened.
    expect(listRepointed(project(ledger.read()))).toHaveLength(0);
  });
});

describe('putting cards back', () => {
  it('restores the pointer and the date it wore', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000b7',
        cliSessionId: TRUNK,
        lastActivityAt: 1_700_000_100_000,
      }),
    );

    repointCards(
      [{ path: file, target: NEW_ACCOUNT, to: TIP, native: true, activityAt: 1_800_000_000_000 }],
      { store, ledger, guard: noGuard },
    );

    const moved = listRepointed(project(ledger.read()));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ from: TRUNK, to: TIP, native: true, path: file });

    repointCards(undoRequests(moved), { store, ledger, guard: noGuard });

    expect(read(file).cliSessionId).toBe(TRUNK);
    expect(read(file).lastActivityAt).toBe(1_700_000_100_000);
    // Back where it started is not a card that has been moved: the fold drops it
    // rather than keeping an entry that says nothing changed.
    expect(listRepointed(project(ledger.read()))).toHaveLength(0);
  });

  it('goes back to where the app had it, not to the last stop', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const third = '00000000-0000-4000-8000-0000000000b9';
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b8', cliSessionId: TRUNK }),
    );

    for (const to of [TIP, third]) {
      repointCards([{ path: file, target: NEW_ACCOUNT, to, native: true }], {
        store,
        ledger,
        guard: noGuard,
      });
    }

    const moved = listRepointed(project(ledger.read()));
    expect(moved[0]).toMatchObject({ from: TRUNK, to: third });

    repointCards(undoRequests(moved), { store, ledger, guard: noGuard });
    expect(read(file).cliSessionId).toBe(TRUNK);
  });
});

describe('a copy that has been repointed', () => {
  it('is still the copy foster is tracking', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ba', cliSessionId: TRUNK }),
    );

    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });
    const [copy] = listActive(project(ledger.read()));

    repointCards([{ path: copy!.copyPath, target: NEW_ACCOUNT, to: TIP, native: false }], {
      store,
      ledger,
      guard: noGuard,
    });

    const [after] = listActive(project(ledger.read()));
    // Without the fold applying the move, the next command reads the file, finds
    // a pointer that disagrees with the ledger, and calls the copy repurposed —
    // dropping the tracking of the card foster had just put right.
    expect(after!.cliSessionId).toBe(TIP);
    expect(inspectCopy(after!).kind).toBe('present');
  });
});
