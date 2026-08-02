import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDuplicates } from '../src/engine/duplicates.js';
import { fosterSessions } from '../src/engine/executor.js';
import { accountDir } from '../src/domain/paths.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * Two rows in one sidebar for one conversation. Fostering refuses to add the
 * second now; this is about the ones already there, and about who may remove
 * them — foster removes what foster wrote, and nothing else.
 */

const SHARED = '00000000-0000-4000-8000-0000000000f1';

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-dup-')), 'l.jsonl'));
}

/** A copy of a conversation the destination also has its own card for. */
function pairOnDisk(): { store: StoreLayout; ledger: Ledger } {
  const store = makeStore();
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000f2', cliSessionId: SHARED }),
  );
  const ledger = ledgerIn();
  // Fostered while the destination had nothing, which is how the pairs already
  // on disk were made: the account's own card arrived afterwards.
  fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });
  writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000f3', cliSessionId: SHARED }),
  );
  return { store, ledger };
}

describe('findDuplicates', () => {
  it('finds a copy of a conversation the account also has its own card for', () => {
    const { store, ledger } = pairOnDisk();

    const report = findDuplicates(store, listActive(project(ledger.read())));
    expect(report.copies).toHaveLength(1);
    expect(report.appMade).toBe(0);
  });

  it('does not call a copy a duplicate of itself', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f4' }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });

    expect(findDuplicates(store, listActive(project(ledger.read()))).copies).toEqual([]);
  });

  it('counts the pairs the app made without offering to remove them', () => {
    // Deleting a file foster did not write, on the strength of a heuristic, is
    // the kind of help nobody asked for. It is reported and left alone.
    const { store, ledger } = pairOnDisk();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000f5',
        cliSessionId: '00000000-0000-4000-8000-0000000000f6',
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000f7',
        cliSessionId: '00000000-0000-4000-8000-0000000000f6',
      }),
    );

    const report = findDuplicates(store, listActive(project(ledger.read())));
    expect(report.appMade).toBe(1);
    expect(report.copies).toHaveLength(1);
  });

  it('works for a ledger entry written before the conversation id was recorded', () => {
    const { store, ledger } = pairOnDisk();
    const [active] = listActive(project(ledger.read()));
    const older = { ...active! };
    delete older.cliSessionId;

    expect(findDuplicates(store, [older]).copies).toHaveLength(1);
  });

  it('says nothing about a copy whose file has gone', () => {
    const { store, ledger } = pairOnDisk();
    const [active] = listActive(project(ledger.read()));
    const missing = {
      ...active!,
      copyPath: path.join(accountDir(store, NEW_ACCOUNT), 'nope.json'),
    };
    delete missing.cliSessionId;

    expect(findDuplicates(store, [missing]).copies).toEqual([]);
  });
});

describe('a store whose sessions carry no conversation id', () => {
  it('is not reported as duplicated', () => {
    // Nothing to compare: without a conversation id two cards are simply two
    // sessions, and guessing from titles would be inventing a fact.
    const store = makeStore();
    const bare = { ...session({ sessionId: '00000000-0000-4000-8000-0000000000f8' }) };
    delete (bare as { cliSessionId?: string }).cliSessionId;
    mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
    writeFileSync(
      path.join(accountDir(store, NEW_ACCOUNT), `${bare.sessionId}.json`),
      JSON.stringify(bare),
      'utf8',
    );

    expect(findDuplicates(store, []).copies).toEqual([]);
  });
});
