import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planConsolidation } from '../src/engine/consolidate.js';
import { fosterSessions } from '../src/engine/executor.js';
import { Ledger } from '../src/ledger/log.js';
import type { StoreLayout } from '../src/domain/types.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * One row per piece of work, on the half that carried on.
 *
 * The plan is the interesting half of this command: what it decides to move,
 * what it decides to drop, and — the part that keeps it honest — what it decides
 * to leave exactly as it is.
 */

const ROOT = '00000000-0000-4000-8000-0000000000c0';
const TRUNK = '00000000-0000-4000-8000-0000000000c1';
const TIP = '00000000-0000-4000-8000-0000000000c2';

let next = 0;
function uuid(): string {
  next += 1;
  return `00000000-0000-4000-8000-0000001${String(next).padStart(5, '0')}`;
}

function record(id: string): string {
  return JSON.stringify({ uuid: id, type: 'user', timestamp: '2026-08-06T05:12:01.370Z' });
}

const META = JSON.stringify({ type: 'custom-title', customTitle: 'Work' });

function transcripts(files: Record<string, string[]>): string[] {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-cs-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  for (const [id, lines] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }
  return [path.join(config, 'projects')];
}

/** A fork with a clear main half: the trunk stopped after one more record. */
function lopsided(): string[] {
  const shared = [record(ROOT), record(uuid())];
  return transcripts({
    [TRUNK]: [META, ...shared, record(uuid())],
    [TIP]: [META, ...shared, ...Array.from({ length: 5 }, () => record(uuid()))],
  });
}

/**
 * A fork that is two pieces of work: both halves ran on, and ran on a long way.
 *
 * Past the default threshold on purpose. The gap this has to land in is wide in
 * practice — measured across a real store, the forks worth collapsing left
 * between 3 and 158 records behind while the one genuine two-way fork left 2352.
 */
function evenlySplit(): string[] {
  const shared = [record(ROOT)];
  return transcripts({
    [TRUNK]: [META, ...shared, ...Array.from({ length: 250 }, () => record(uuid()))],
    [TIP]: [META, ...shared, ...Array.from({ length: 300 }, () => record(uuid()))],
  });
}

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-cs-l-')), 'l.jsonl'));
}

/** A copy of the old account's cards, in the new one, recorded in the ledger. */
function fosterAcross(store: StoreLayout, ledger: Ledger, projectsDirs: string[]): void {
  for (const card of scanAccount(store, OLD_ACCOUNT)) {
    fosterSessions([card], { store, ledger, target: NEW_ACCOUNT, projectsDirs, explicit: true });
  }
}

/**
 * The other half, carded in the account next door.
 *
 * A fork is only visible to this command while both halves have a card
 * somewhere: membership comes from the cards in the store, so a branch nothing
 * points at is not a row to keep or drop. There is a test for that below.
 */
function cardTheTip(store: StoreLayout, id = '00000000-0000-4000-8000-0000000000d0'): void {
  writeSession(store, OLD_ACCOUNT, session({ sessionId: id, cliSessionId: TIP }));
}

describe('planConsolidation', () => {
  it('moves the one card an account has onto the half that carried on', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c3', cliSessionId: TRUNK }),
    );
    cardTheTip(store);

    const [entry] = planConsolidation({
      store,
      ledger: ledgerIn(),
      projectsDirs: lopsided(),
      to: NEW_ACCOUNT.accountUuid,
    });

    expect(entry!.status).toBe('consolidate');
    expect(entry!.repoint).toMatchObject({ from: TRUNK, to: TIP, native: true });
    expect(entry!.remove).toHaveLength(0);
    // The trade, carried on the plan so the caller can print it rather than
    // discover it: five records kept, one stopped being shown.
    expect(entry!.fork.branches[0]!.total).toBe(7);
    expect(entry!.fork.lost).toBe(1);
  });

  it('keeps the card the app made and removes the copy foster wrote', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    const projectsDirs = lopsided();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c4', cliSessionId: TRUNK }),
    );
    fosterAcross(store, ledger, projectsDirs);
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c5', cliSessionId: TIP }),
    );

    const [entry] = planConsolidation({
      store,
      ledger,
      projectsDirs,
      to: NEW_ACCOUNT.accountUuid,
    });

    // Already on the tip, so nothing to move; the surplus row is the copy, and
    // removing what foster wrote is the one removal foster is entitled to.
    expect(entry!.repoint).toBeUndefined();
    expect(entry!.remove).toHaveLength(1);
    expect(entry!.keptApart).toHaveLength(0);
  });

  it('leaves a fork alone when both halves are substantial', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c6', cliSessionId: TRUNK }),
    );
    cardTheTip(store);

    const [entry] = planConsolidation({
      store,
      ledger: ledgerIn(),
      projectsDirs: evenlySplit(),
      to: NEW_ACCOUNT.accountUuid,
    });

    expect(entry!.status).toBe('diverged');
    expect(entry!.repoint).toBeUndefined();
    expect(entry!.fork.lost).toBe(250);
  });

  it('collapses the same fork once the threshold is raised past it', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c7', cliSessionId: TRUNK }),
    );
    cardTheTip(store);

    const [entry] = planConsolidation({
      store,
      ledger: ledgerIn(),
      projectsDirs: evenlySplit(),
      maxLost: 250,
      to: NEW_ACCOUNT.accountUuid,
    });

    expect(entry!.status).toBe('consolidate');
    expect(entry!.repoint).toMatchObject({ to: TIP });
  });

  it('reports a second card the app made instead of removing it', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c8', cliSessionId: TIP }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c9', cliSessionId: TRUNK }),
    );

    const [entry] = planConsolidation({
      store,
      ledger: ledgerIn(),
      projectsDirs: lopsided(),
    });

    // Its own status, not `consolidate`: there is nothing here foster may move or
    // remove, and counting it as work made the summary offer an action that did
    // not exist — "3 rows would be consolidated (0 moved, 0 removed)".
    expect(entry!.status).toBe('app-made');
    expect(entry!.repoint).toBeUndefined();
    expect(entry!.remove).toHaveLength(0);
    expect(entry!.keptApart).toEqual([
      expect.objectContaining({
        cliSessionId: TRUNK,
        sessionId: 'local_00000000-0000-4000-8000-0000000000c9',
      }),
    ]);
  });

  it('has nothing to say about a card already on the tip and alone', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ca', cliSessionId: TIP }),
    );
    // The other half, carded elsewhere, so the fork is visible at all — otherwise
    // this would pass by finding nothing rather than by finding nothing to do.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d7', cliSessionId: TRUNK }),
    );

    const [entry] = planConsolidation({
      store,
      ledger: ledgerIn(),
      projectsDirs: lopsided(),
      to: NEW_ACCOUNT.accountUuid,
    });

    expect(entry!.status).toBe('settled');
  });

  it('plans each account separately', () => {
    const store = makeStore();
    cardTheTip(store, '00000000-0000-4000-8000-0000000000cb');
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000cc', cliSessionId: TRUNK }),
    );

    const projectsDirs = lopsided();
    const ledger = ledgerIn();
    // One row per account, decided from that account's own cards: the old one is
    // already on the tip and has nothing to do, the new one has to move.
    const both = planConsolidation({ store, ledger, projectsDirs });
    expect(both).toHaveLength(2);
    expect(both.filter((entry) => entry.status === 'settled')).toHaveLength(1);
    expect(
      planConsolidation({ store, ledger, projectsDirs, to: NEW_ACCOUNT.accountUuid }),
    ).toHaveLength(1);
  });

  it('cannot see a fork whose other half has no card anywhere', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d8', cliSessionId: TRUNK }),
    );

    // The bound, stated rather than discovered: membership comes from the cards
    // in the store, and a branch nothing points at is a conversation with no row
    // — which is `foster restore`'s question, not this one's.
    expect(planConsolidation({ store, ledger: ledgerIn(), projectsDirs: lopsided() })).toHaveLength(
      0,
    );
  });

  it('narrows to the fork a conversation belongs to', () => {
    const store = makeStore();
    const other = '00000000-0000-4000-8000-0000000000cd';
    const projectsDirs = transcripts({
      [TRUNK]: [META, record(ROOT), record(uuid())],
      [TIP]: [META, record(ROOT), record(uuid()), record(uuid())],
      [other]: [META, record('00000000-0000-4000-8000-0000000000ce'), record(uuid())],
    });
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000cf', cliSessionId: TRUNK }),
    );

    cardTheTip(store, '00000000-0000-4000-8000-0000000000d9');
    const ledger = ledgerIn();
    const to = NEW_ACCOUNT.accountUuid;
    // Either half names the fork, because either half is the work. Named in full:
    // these fixtures deliberately share a long prefix, so a short one would match
    // everything and the test would pass without deciding anything.
    expect(planConsolidation({ store, ledger, projectsDirs, to, sessionIds: [TIP] })).toHaveLength(
      1,
    );
    expect(
      planConsolidation({ store, ledger, projectsDirs, to, sessionIds: [other] }),
    ).toHaveLength(0);
  });
});
