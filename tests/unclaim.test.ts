import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyUnclaim, planUnclaim, undoUnclaim } from '../src/engine/unclaim.js';
import { AppRunningError, assertCardsWritable, type WritableCard } from '../src/engine/safety.js';
import type * as Desktop from '../src/engine/desktop.js';
import { Ledger } from '../src/ledger/log.js';
import { project } from '../src/ledger/project.js';
import type { CodeSessionData } from '../src/domain/types.js';
import type { Lineage } from '../src/engine/lineage.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

// A running app, fixed for the whole suite. This is not something `applyUnclaim`
// or `undoUnclaim` ever read any more — the point of most of what follows is
// that they do not need to — but it is what the contrast tests below use to
// prove `assertCardsWritable` itself would have refused, had anything here
// still been calling it.
vi.mock('../src/engine/lockfile.js', () => ({ lockfileHeld: () => true }));
vi.mock('../src/engine/desktop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Desktop>();
  return {
    ...actual,
    inspectDesktopFor: () => ({ running: true, startedAt: 0, codeSessions: 0, selfHosted: false }),
  };
});

/**
 * Releasing the claim a copy already on disk inherited from its original —
 * issue #26's second half, alongside the fix `fostering.test.ts` covers for a
 * copy being minted fresh.
 *
 * Neither `applyUnclaim` nor `undoUnclaim` takes a process guard: releasing a
 * claim is an idempotent repair, like `retitle`, not a move like `repoint` — see
 * the doc comment on `src/engine/unclaim.ts`. Several tests below run with the
 * app mocked as running for exactly that reason: the release has to go through
 * regardless.
 */

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

/**
 * A `Lineage` that answers only the one question `worktreeReachOf` asks it: how
 * many records each of the card's two directories opens. Nothing here reads a
 * transcript, which is the point — the choice is made from those two counts.
 */
function reaching(atCwd: number, atOriginCwd: number): Lineage {
  const scan = (n: number) => ({
    uuids: new Set(Array.from({ length: n }, (_unused, i) => String(i))),
  });
  return {
    reachOf(_cliSessionId: string | undefined, cwd: string | undefined) {
      if (cwd === HELD.cwd) return scan(atCwd);
      if (cwd === HELD.originCwd) return scan(atOriginCwd);
      return undefined;
    },
  } as unknown as Lineage;
}

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
    applyUnclaim(first.items, { ledger });

    const second = planUnclaim(store, project(ledger.read()));
    expect(second.items).toEqual([]);
  });

  it('finds the claim again once the app hands it back, and releases it a second time', () => {
    // The whole reason neither write here takes a guard: a card the app is
    // holding may be rewritten from memory at any point, claim and all. This
    // simulates exactly that — the app saving the same card back with its
    // original worktree fields — and proves the repair is not a one-shot: the
    // next plan finds the claim again, and releasing it again is unremarkable,
    // not an error.
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000c7', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-c7');

    const first = planUnclaim(store, project(ledger.read()));
    const [firstOutcome] = applyUnclaim(first.items, { ledger });
    expect(firstOutcome!.status).toBe('released');
    expect(read(file).worktreePath).toBeUndefined();

    // The app rewrites the card from memory, claim and all — the hazard the
    // module doc comment names, made concrete.
    writeFileSync(file, JSON.stringify(before), 'utf8');

    const second = planUnclaim(store, project(ledger.read()));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.sessionId).toBe(before.sessionId);

    const [secondOutcome] = applyUnclaim(second.items, { ledger });
    expect(secondOutcome!.status).toBe('released');
    expect(read(file).worktreePath).toBeUndefined();

    const events = ledger.read().filter((event) => event.kind === 'worktree_released');
    expect(events).toHaveLength(2);
  });

  /**
   * #80. Since #41 a copy is minted in whichever of its two directories opens
   * more of the conversation, so a release that sends `cwd` to `originCwd`
   * regardless undoes that choice in the same sweep that made it — and the next
   * run, seeing a row that cannot reach what the source offers, copies the whole
   * conversation again. The claim fields still come off; only the move is
   * conditional.
   */
  it('leaves cwd where it is when the worktree opens more of the conversation', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({
      sessionId: '00000000-0000-4000-8000-0000000000e1',
      cliSessionId: '00000000-0000-4000-8000-0000000000f1',
      ...HELD,
    });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e1');

    const plan = planUnclaim(store, project(ledger.read()), { kin: reaching(1482, 1375) });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.cwdTo).toBeUndefined();
    expect(plan.items[0]!.worktreePath).toBe(HELD.worktreePath);

    applyUnclaim(plan.items, { ledger });
    expect(read(file).cwd).toBe(HELD.cwd);
    expect(read(file).worktreePath).toBeUndefined();
    expect(read(file).worktreeName).toBeUndefined();
  });

  it('still moves cwd to the repository when that is the fuller side', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({
      sessionId: '00000000-0000-4000-8000-0000000000e2',
      cliSessionId: '00000000-0000-4000-8000-0000000000f2',
      ...HELD,
    });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e2');

    const plan = planUnclaim(store, project(ledger.read()), { kin: reaching(12, 1375) });

    expect(plan.items[0]!.cwdTo).toBe(HELD.originCwd);
    applyUnclaim(plan.items, { ledger });
    expect(read(file).cwd).toBe(HELD.originCwd);
  });

  it('moves cwd to the repository when nothing measures the two, as it always did', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e3', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e3');

    const plan = planUnclaim(store, project(ledger.read()));

    expect(plan.items[0]!.cwdTo).toBe(HELD.originCwd);
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
    const [outcome] = applyUnclaim(plan.items, { ledger });

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
    applyUnclaim(plan.items, { ledger });

    expect(read(file).worktreeLazy).toBeUndefined();
  });

  it('records a worktree_released event carrying what an undo would need', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000d3', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-d3');

    const plan = planUnclaim(store, project(ledger.read()));
    applyUnclaim(plan.items, { ledger });

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

    const outcomes = applyUnclaim(plan.items, { ledger });
    expect(outcomes[0]!.status).toBe('failed');
  });

  it('releases even though the real guard would refuse this exact card', () => {
    // The design decision this pins: releasing a claim is an idempotent repair
    // like `retitle`, not a move like `repoint`, so it takes no write guard at
    // all — not even the app-open one `retitle` itself has none of either. A
    // native card is always "held" as far as `assertCardsWritable` is
    // concerned while the app is up, so proving that call throws for this
    // exact path is proof the release below could not have gone through it.
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000d5', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);

    const asNative: WritableCard[] = [{ path: file, native: true }];
    expect(() => assertCardsWritable(store, asNative)).toThrow(AppRunningError);

    foster(ledger, file, before.sessionId, 'local_origin-d5');
    const plan = planUnclaim(store, project(ledger.read()));
    const [outcome] = applyUnclaim(plan.items, { ledger });

    expect(outcome!.status).toBe('released');
    expect(read(file).worktreePath).toBeUndefined();
  });
});

describe('undoUnclaim', () => {
  it('puts the claim and cwd back', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e1', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e1');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, { ledger });

    const outcomes = undoUnclaim({ ledger });
    expect(outcomes[0]!.status).toBe('undone');
    expect(read(file)).toEqual(before);
  });

  it('refuses when the card has moved on since the release', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e2', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e2');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, { ledger });

    // The app (or another command) has since sent this card somewhere else.
    const moved = read(file);
    moved.cwd = 'C:\\home\\elsewhere';
    writeFileSync(file, JSON.stringify(moved), 'utf8');

    const outcomes = undoUnclaim({ ledger });
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
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, { ledger });

    const rewritten = read(file);
    rewritten.worktreePath = 'C:\\home\\repo\\.claude\\worktrees\\wt-fresh';
    rewritten.worktreeName = 'wt-fresh';
    writeFileSync(file, JSON.stringify(rewritten), 'utf8');

    const outcomes = undoUnclaim({ ledger });
    expect(outcomes[0]!.status).toBe('skipped');
  });

  it('reports a card that cannot be read as failed, not thrown', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e4', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e4');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, { ledger });

    unlinkSync(file);
    const outcomes = undoUnclaim({ ledger });
    expect(outcomes[0]!.status).toBe('failed');
  });

  it('is idempotent: nothing left once every release has been undone', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e5', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e5');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, { ledger });

    undoUnclaim({ ledger });
    expect(undoUnclaim({ ledger })).toEqual([]);
  });

  it('undoes even though the real guard would refuse this exact card', () => {
    // Same contrast as the `applyUnclaim` test above, in the other direction:
    // `undoUnclaim` takes no guard either, so the fact `assertCardsWritable`
    // would refuse this card while the app is "running" changes nothing about
    // whether the undo goes through.
    const store = makeStore();
    const ledger = ledgerIn();
    const before = session({ sessionId: '00000000-0000-4000-8000-0000000000e6', ...HELD });
    const file = writeSession(store, NEW_ACCOUNT, before);
    foster(ledger, file, before.sessionId, 'local_origin-e6');
    applyUnclaim(planUnclaim(store, project(ledger.read())).items, { ledger });

    const asNative: WritableCard[] = [{ path: file, native: true }];
    expect(() => assertCardsWritable(store, asNative)).toThrow(AppRunningError);

    const outcomes = undoUnclaim({ ledger });
    expect(outcomes[0]!.status).toBe('undone');
    expect(read(file)).toEqual(before);
  });
});
