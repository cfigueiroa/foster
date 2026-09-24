import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { planPinMoves } from '../src/engine/pinMoves.js';
import type { PinState } from '../src/store/pinstate.js';
import { makeStore, NEW_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `planPinMoves` resolving a deferred move whose named row is no longer
 * visible.
 *
 * The row a deferral names can stop being visible between the sweep that
 * deferred it and the `foster layout` run that would finish it — a later pass
 * archives it, or (bug #4 this pins) `branchCards.ts` picked the wrong one of
 * a tip's two rows in the first place, naming the archived "(other file…)"
 * row instead of the clean one. Before this, `planPinMoves` only ever checked
 * whether the *named* row was still shown; when it was not, the move was
 * settled with nothing written and never offered again — the pin sat on the
 * stale row forever. `redirectToVisible` (`src/engine/pinMoves.ts`) looks
 * once for another row of the same conversation before giving up.
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000000f1';
const STALE_CARD = '00000000-0000-4000-8000-0000000000f2';
const ARCHIVED_TARGET = '00000000-0000-4000-8000-0000000000f3';
const VISIBLE_SIBLING = '00000000-0000-4000-8000-0000000000f4';
const OTHER_CONVERSATION_CARD = '00000000-0000-4000-8000-0000000000f5';

/** A `PinState` this test's `planPinMoves` calls never write, so only `ids` matters. */
function fakePinState(ids: string[]): PinState {
  return {
    ids,
    logPath: 'unused.log',
    databaseId: 1,
    version: 1,
    envelope: Buffer.alloc(0),
    document: {},
    highestSequence: 0n,
    notices: [],
  };
}

function newLedger(): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), 'foster-pinmoves-'));
  return new Ledger(path.join(dir, 'l.jsonl'));
}

function deferMove(ledger: Ledger, cleanSessionId: string): void {
  ledger.append({
    kind: 'pin_move_deferred',
    target: NEW_ACCOUNT,
    staleSessionId: `local_${STALE_CARD}`,
    cleanSessionId,
    staleTitle: '(stale, stopped 21/09 09:00) Macs',
    cleanTitle: 'Macs',
    as: 'stale',
  });
}

describe('resolving a deferred pin move whose target row is gone', () => {
  it('redirects to a visible sibling of the same conversation', () => {
    const store = makeStore();
    const ledger = newLedger();

    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: STALE_CARD,
        cliSessionId: CONVERSATION,
        title: '(stale, stopped 21/09 09:00) Macs',
        isArchived: true,
      }),
    );
    // The row the deferral named — archived since. Either a later sweep
    // archived it for its own reason, or (the bug this pins) it was never the
    // right row to begin with.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: ARCHIVED_TARGET,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: true,
        lastActivityAt: 1_700_000_050_000,
      }),
    );
    // The other row of the same conversation — still in the sidebar, and
    // where the pin belongs.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: VISIBLE_SIBLING,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: false,
        lastActivityAt: 1_700_000_100_000,
      }),
    );
    // A card of an unrelated conversation, so a redirect that ignored
    // `cliSessionId` and grabbed anything visible would be caught.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: OTHER_CONVERSATION_CARD, title: 'Unrelated', isArchived: false }),
    );

    deferMove(ledger, `local_${ARCHIVED_TARGET}`);

    const plan = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`]),
    );

    expect(plan.settled).toEqual([]);
    expect(plan.moves).toEqual([
      expect.objectContaining({
        staleSessionId: `local_${STALE_CARD}`,
        cleanSessionId: `local_${VISIBLE_SIBLING}`,
        cleanTitle: 'Macs',
      }),
    ]);
  });

  it('settles as before when no sibling of the conversation is visible either', () => {
    const store = makeStore();
    const ledger = newLedger();

    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: STALE_CARD,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: true,
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: ARCHIVED_TARGET,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: true,
      }),
    );

    deferMove(ledger, `local_${ARCHIVED_TARGET}`);

    const plan = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`]),
    );

    expect(plan.moves).toEqual([]);
    expect(plan.settled).toHaveLength(1);
    expect(plan.settled[0]!.cleanSessionId).toBe(`local_${ARCHIVED_TARGET}`);
  });

  it('does not redirect when the row the deferral named is already visible', () => {
    const store = makeStore();
    const ledger = newLedger();

    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: STALE_CARD,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: true,
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: VISIBLE_SIBLING,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: false,
      }),
    );

    deferMove(ledger, `local_${VISIBLE_SIBLING}`);

    const plan = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`]),
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({ cleanSessionId: `local_${VISIBLE_SIBLING}` }),
    ]);
    expect(plan.settled).toEqual([]);
  });

  it('is idempotent: settling the move leaves nothing pending for a second plan', () => {
    const store = makeStore();
    const ledger = newLedger();

    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: STALE_CARD,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: true,
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: ARCHIVED_TARGET,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: true,
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: VISIBLE_SIBLING,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: false,
      }),
    );

    deferMove(ledger, `local_${ARCHIVED_TARGET}`);

    const first = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`]),
    );
    expect(first.moves).toHaveLength(1);

    // The pin actually moves onto the redirected row — no write here, just the
    // ledger settling the deferral, as `applyPinMoves` would once the write lands.
    ledger.append({
      kind: 'pins_moved',
      moves: [
        {
          staleSessionId: `local_${STALE_CARD}`,
          cleanSessionId: `local_${VISIBLE_SIBLING}`,
          written: true,
        },
      ],
    });

    const second = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${VISIBLE_SIBLING}`]),
    );
    expect(second).toEqual({ moves: [], settled: [] });
  });
});
