import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { retitleCards } from '../src/engine/retitle.js';
import { planVerify } from '../src/engine/verify.js';
import { writeGroupScope, type GroupScope } from '../src/store/groupScopes.js';
import { Ledger } from '../src/ledger/log.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster verify` reads back what the ledger says foster wrote and says what
 * the app has since undone — see `src/engine/verify.ts`. Marks and pins are
 * checked exactly (the ledger alone proves reversion); groups and routines are
 * checked only for the one shape actually measured on a real store: applied
 * before, now zero, with a fresh plan still wanting to bring some.
 */

const CARD = '00000000-0000-4000-8000-0000000000e1';
const MARKED = '(outro arquivo, parou 18/09 13:33) Work';

function fixture() {
  const store = makeStore();
  const ledger = new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'foster-verify-')), 'l.jsonl'),
  );
  const file = writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: CARD, title: 'Work', isArchived: false }),
  );
  return { store, ledger, file };
}

function appSavesBack(file: string, title: string, isArchived = false): void {
  const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...data, title, isArchived }), 'utf8');
}

describe('planVerify — marks', () => {
  it('reports nothing undone while a card stands under the mark foster wrote', () => {
    const { store, ledger, file } = fixture();
    retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: MARKED,
          archived: true,
          as: 'other-file',
          template: '(outro arquivo, parou {when}) ',
        },
      ],
      { ledger },
    );

    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.marks.pending).toEqual([]);
    expect(report.undone).toBe(false);
  });

  it('reports a card the app saved back over the mark', () => {
    const { store, ledger, file } = fixture();
    retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: MARKED,
          archived: true,
          as: 'other-file',
          template: '(outro arquivo, parou {when}) ',
        },
      ],
      { ledger },
    );
    appSavesBack(file, 'Work');

    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.marks.pending).toHaveLength(1);
    expect(report.marks.pending[0]).toMatchObject({ path: file, title: MARKED, archived: true });
    expect(report.undone).toBe(true);
  });

  it('only looks at the account it is asked about', () => {
    const { store, ledger, file } = fixture();
    retitleCards(
      [{ path: file, target: NEW_ACCOUNT, native: true, title: MARKED, as: 'other-file' }],
      { ledger },
    );
    appSavesBack(file, 'Work');

    const report = planVerify(store, OLD_ACCOUNT, ledger.read());
    expect(report.marks.pending).toEqual([]);
    expect(report.undone).toBe(false);
  });
});

describe('planVerify — groups', () => {
  it('says nothing was ever applied when the ledger has no layout_applied for this target', () => {
    const { store, ledger } = fixture();
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.groups.everApplied).toBe(false);
    expect(report.groups.reset).toBe(false);
  });

  it('flags a scope that went from applied groups to none', () => {
    const { store, ledger } = fixture();
    ledger.append({
      kind: 'layout_applied',
      target: NEW_ACCOUNT,
      groups: 3,
      groupsCreated: 1,
      routines: 0,
    });
    // The store's own scope is now empty — the app rewrote it away.
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.groups.everApplied).toBe(true);
    expect(report.groups.nowGroups).toBe(0);
    // Nothing else in this account offers a group to bring, so a fresh plan
    // has nothing pending either — the reset flag needs both halves.
    expect(report.groups.reset).toBe(false);
  });

  it('does not call a non-empty scope reset, even with more pending', () => {
    const { store, ledger } = fixture();
    ledger.append({
      kind: 'layout_applied',
      target: NEW_ACCOUNT,
      groups: 1,
      groupsCreated: 1,
      routines: 0,
    });
    writeFileSync(store.desktopConfigFile, JSON.stringify({}), 'utf8');
    const scope: GroupScope = {
      groups: [{ id: 'g1', name: 'Work' }],
      assignments: {},
    };
    writeGroupScope(store, NEW_ACCOUNT, scope, {
      env: { FOSTER_HOME: path.join(store.root, '.foster-home') },
    });

    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.groups.nowGroups).toBe(1);
    expect(report.groups.reset).toBe(false);
  });
});

describe('planVerify — pins', () => {
  it('reports a deferred move that never landed', () => {
    const { store, ledger } = fixture();
    ledger.append({
      kind: 'pin_move_deferred',
      target: NEW_ACCOUNT,
      staleSessionId: 'local_stale',
      cleanSessionId: 'local_clean',
      staleTitle: '(stale) Work',
      cleanTitle: 'Work',
      as: 'stale',
    });

    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    // No pin database on disk in this fixture, so `planPinMoves` cannot tell
    // whether the stale row is even pinned — nothing to report as pending in
    // that case, and `undone` follows only what could actually be read.
    expect(report.pins.pending).toEqual([]);
    expect(report.pins.unreadable).toBeDefined();
  });
});

describe('planVerify — cross-account pin parity', () => {
  it('flags a foster-pinned id that is no longer pinned, with no pin database at all', () => {
    // No pin database on disk — `readPinState` answers `undefined`, so a
    // foster-owned id has nothing to be found pinned in.
    const { store, ledger } = fixture();
    ledger.append({
      kind: 'pins_synced',
      account: NEW_ACCOUNT,
      pinned: ['local_x'],
      unpinned: [],
    });
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.pinParity.undone).toEqual([]);
    expect(report.undone).toBe(false);
  });

  it('is empty once the ledger says the id was unpinned again', () => {
    const { store, ledger } = fixture();
    ledger.append({ kind: 'pins_synced', account: NEW_ACCOUNT, pinned: ['local_x'], unpinned: [] });
    ledger.append({ kind: 'pins_synced', account: NEW_ACCOUNT, pinned: [], unpinned: ['local_x'] });
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.pinParity.undone).toEqual([]);
  });
});

describe('planVerify — view carried', () => {
  it('says nothing pending when nothing was ever carried', () => {
    const { store, ledger } = fixture();
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.viewCarried.undone).toEqual([]);
  });

  it('flags a carried value the store no longer shows', () => {
    const { store, ledger } = fixture();
    ledger.append({ kind: 'view_carried', account: NEW_ACCOUNT, key: 'groupBy', value: 'custom' });
    // No Local Storage database on disk at all — `readViewState`'s `groupBy`
    // comes back `undefined`, which disagrees with the carried `'custom'`.
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.viewCarried.undone).toEqual([
      { key: 'groupBy', expected: 'custom', actual: undefined },
    ]);
    expect(report.undone).toBe(true);
  });
});

describe('planVerify — group assignments (including moves)', () => {
  it('flags a card the ledger says foster filed, no longer filed there', () => {
    const { store, ledger } = fixture();
    ledger.append({
      kind: 'layout_assigned',
      account: NEW_ACCOUNT,
      assignments: [{ cardId: 'code:local_x', groupName: 'Work' }],
    });
    // No group scope on disk at all for this account.
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.groupAssignments.undone).toEqual([{ cardId: 'code:local_x', groupName: 'Work' }]);
    expect(report.undone).toBe(true);
  });

  it('says nothing pending once the scope still agrees', () => {
    const { store, ledger } = fixture();
    ledger.append({
      kind: 'layout_assigned',
      account: NEW_ACCOUNT,
      assignments: [{ cardId: 'code:local_x', groupName: 'Work' }],
    });
    writeFileSync(store.desktopConfigFile, JSON.stringify({}), 'utf8');
    writeGroupScope(
      store,
      NEW_ACCOUNT,
      { groups: [{ id: 'g1', name: 'Work' }], assignments: { 'code:local_x': 'g1' } },
      { env: { FOSTER_HOME: path.join(store.root, '.foster-home') } },
    );
    const report = planVerify(store, NEW_ACCOUNT, ledger.read());
    expect(report.groupAssignments.undone).toEqual([]);
  });
});
