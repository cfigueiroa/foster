import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyUnclaim, planUnclaim, undoUnclaim } from '../src/engine/unclaim.js';
import type { WritableCard } from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import { project } from '../src/ledger/project.js';
import type { CodeSessionData, StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * Releasing the claim a copy already on disk inherited from its original —
 * issue #26's second half, alongside the fix `fostering.test.ts` covers for a
 * copy being minted fresh.
 */

// Everything writable: these tests drive a synthetic store, and whether a real
// app on this machine happens to be running must not decide whether they pass.
const noGuard = (_store: StoreLayout, cards: WritableCard[]) => ({ writable: cards, held: [] });

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-unclaim-')), 'l.jsonl'));
}

function read(file: string): CodeSessionData {
  return JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
}

/** Records a copy as an active fostering, the way `fosterSessions` would have. */
function foster(
  ledger: Ledger,
  copyPath: string,
  copySessionId: string,
  originSessionId: string,
): void {
  ledger.append({
    kind: 'fostered',
    originSessionId,
    origin: OLD_ACCOUNT,
    target: NEW_ACCOUNT,
    copySessionId,
    copyPath,
    prefix: '',
  });
}

const HELD = {
  cwd: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
  originCwd: 'C:\\home\\repo',
  worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
  worktreeName: 'wt-a',
};

describe('planUnclaim', () => {
  it('offers only copies in this store that still carry a claim', () => {
    const store = makeStore();
    const ledger = ledgerIn();

    // A copy naming the worktree in every field.
    const named = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c1', ...HELD }),
    );
    foster(ledger, named, 'local_00000000-0000-4000-8000-0000000000c1', 'local_origin-1');

    // A copy sitting in a worktree it never named — the claim is on the
    // directory alone.
    const unnamed = writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000c2',
        cwd: 'C:\\home\\repo\\.claude\\worktrees\\wt-b',
        originCwd: 'C:\\home\\repo',
      }),
    );
    foster(ledger, unnamed, 'local_00000000-0000-4000-8000-0000000000c2', 'local_origin-2');

    // A native card the app wrote, carrying the very same claim. Never
    // fostered, so the ledger never names it — it must not appear at all.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c3', ...HELD }),
    );

    // A copy that holds no claim at all.
    const clean = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c4' }),
    );
    foster(ledger, clean, 'local_00000000-0000-4000-8000-0000000000c4', 'local_origin-4');

    const plan = planUnclaim(store, project(ledger.read()));

    expect(plan.items.map((item) => item.sessionId).sort()).toEqual(
      [
        'local_00000000-0000-4000-8000-0000000000c1',
        'local_00000000-0000-4000-8000-0000000000c2',
      ].sort(),
    );
    expect(plan.skipped).toEqual({ gone: 0, unreadable: 0, noClaim: 1 });
  });

  it('counts a fostering whose copy is no longer on disk as gone', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    foster(
      ledger,
      path.join(
        store.codeSessionsDir,
        NEW_ACCOUNT.accountUuid,
        NEW_ACCOUNT.organizationUuid,
        'local_ghost.json',
      ),
      'local_ghost',
      'local_origin-ghost',
    );

    const plan = planUnclaim(store, project(ledger.read()));
    expect(plan.items).toEqual([]);
    expect(plan.skipped.gone).toBe(1);
  });

  it('reports an unreadable copy rather than throwing', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c5', ...HELD }),
    );
    foster(ledger, file, 'local_00000000-0000-4000-8000-0000000000c5', 'local_origin-5');
    writeFileSync(file, '{not json', 'utf8');

    expect(() => planUnclaim(store, project(ledger.read()))).not.toThrow();
    const plan = planUnclaim(store, project(ledger.read()));
    expect(plan.items).toEqual([]);
    expect(plan.skipped.unreadable).toBe(1);
  });

  it('is empty a second time, once a release has already run', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c6', ...HELD }),
    );
    foster(ledger, file, 'local_00000000-0000-4000-8000-0000000000c6', 'local_origin-6');

    const first = planUnclaim(store, project(ledger.read()));
    applyUnclaim(first.items, { store, ledger, guard: noGuard });

    const second = planUnclaim(store, project(ledger.read()));
    expect(second.items).toEqual([]);
  });
});

describe('applyUnclaim', () => {
  it('removes only the claim fields, moves cwd, and carries everything else through', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({
      sessionId: '00000000-0000-4000-8000-0000000000d1',
      ...HELD,
      title: 'Refactor parser',
      somethingTheAppAdded: { nested: true },
    });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-d1');

    const plan = planUnclaim(store, project(ledger.read()));
    const [outcome] = applyUnclaim(plan.items, { store, ledger, guard: noGuard });

    expect(outcome!.status).toBe('released');
    const after = read(file);
    expect(after.worktreePath).toBeUndefined();
    expect(after.worktreeName).toBeUndefined();
    expect(after.cwd).toBe('C:\\home\\repo');

    // Byte-identical to the source once the three fields and cwd are put back —
    // proof nothing else on the card moved, unknown key included.
    const restored = { ...after, ...HELD };
    expect(restored).toEqual(before);
  });

  it('drops a lazy worktree promise the same way', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({
      sessionId: '00000000-0000-4000-8000-0000000000d2',
      worktreeLazy: { path: 'C:\\home\\repo\\.claude\\worktrees\\wt-c' },
    });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-d2');

    const plan = planUnclaim(store, project(ledger.read()));
    applyUnclaim(plan.items, { store, ledger, guard: noGuard });

    expect(read(file).worktreeLazy).toBeUndefined();
  });

  it('records a worktree_released event carrying what an undo would need', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000d3', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-d3');

    const plan = planUnclaim(store, project(ledger.read()));
    applyUnclaim(plan.items, { store, ledger, guard: noGuard });

    const events = ledger.read().filter((event) => event.kind === 'worktree_released');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'worktree_released',
      path: file,
      sessionId: before.sessionId,
      worktreePath: HELD.worktreePath,
      worktreeName: HELD.worktreeName,
      cwdFrom: HELD.cwd,
      cwdTo: HELD.originCwd,
    });
  });

  it('reports a card that cannot be read as failed, not thrown', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000d4', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-d4');

    const plan = planUnclaim(store, project(ledger.read()));
    unlinkSync(file);

    const outcomes = applyUnclaim(plan.items, { store, ledger, guard: noGuard });
    expect(outcomes[0]!.status).toBe('failed');
  });
});

describe('undoUnclaim', () => {
  it('puts the claim and cwd back', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e1', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e1');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, {
      store,
      ledger,
      guard: noGuard,
    });

    const outcomes = undoUnclaim({ store, ledger, guard: noGuard });
    expect(outcomes[0]!.status).toBe('undone');
    expect(read(file)).toEqual(before);
  });

  it('refuses when the card has moved on since the release', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e2', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e2');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, {
      store,
      ledger,
      guard: noGuard,
    });

    // The app (or another command) has since sent this card somewhere else.
    const moved = read(file);
    moved.cwd = 'C:\\home\\elsewhere';
    writeFileSync(file, JSON.stringify(moved), 'utf8');

    const outcomes = undoUnclaim({ store, ledger, guard: noGuard });
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.detail).toMatch(/moved on/);
    // Left exactly as the caller found it.
    expect(read(file).cwd).toBe('C:\\home\\elsewhere');
  });

  it('refuses when the app has since given the card a worktree of its own', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e3', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e3');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, {
      store,
      ledger,
      guard: noGuard,
    });

    const rewritten = read(file);
    rewritten.worktreePath = 'C:\\home\\repo\\.claude\\worktrees\\wt-fresh';
    rewritten.worktreeName = 'wt-fresh';
    writeFileSync(file, JSON.stringify(rewritten), 'utf8');

    const outcomes = undoUnclaim({ store, ledger, guard: noGuard });
    expect(outcomes[0]!.status).toBe('skipped');
  });

  it('reports a card that cannot be read as failed, not thrown', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e4', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e4');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, {
      store,
      ledger,
      guard: noGuard,
    });

    unlinkSync(file);
    const outcomes = undoUnclaim({ store, ledger, guard: noGuard });
    expect(outcomes[0]!.status).toBe('failed');
  });

  it('is idempotent: nothing left once every release has been undone', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e5', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e5');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, {
      store,
      ledger,
      guard: noGuard,
    });

    undoUnclaim({ store, ledger, guard: noGuard });
    expect(undoUnclaim({ store, ledger, guard: noGuard })).toEqual([]);
  });
});
