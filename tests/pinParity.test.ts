import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { fosterOwnedPins, planPinParity } from '../src/engine/pinParity.js';
import type { PinState } from '../src/store/pinstate.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `planPinParity` — cross-account pin parity for `foster layout`.
 *
 * The pin list is one list per installation (`store/pinstate.ts`), so a card
 * minted for a copy always arrives unpinned. `planPinParity` decides, per
 * conversation, whether the target's row to continue in should be pinned to
 * match the most recently active *other* account's own card — and, the other
 * way, whether an unwanted pin foster itself put there should come off.
 */

const CONVERSATION_A = '00000000-0000-4000-8000-0000000000a1';
const CONVERSATION_B = '00000000-0000-4000-8000-0000000000b1';

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
    tablesUnreadable: [],
  };
}

function newLedger(): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), 'foster-pinparity-'));
  return new Ledger(path.join(dir, 'l.jsonl'));
}

describe('planPinParity', () => {
  it('pins the target row when the most recently active other account has it pinned', () => {
    const store = makeStore();

    // The source card, in the other account, pinned and more recently active.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: 'a1',
        cliSessionId: CONVERSATION_A,
        title: 'Macs',
        lastActivityAt: 2_000,
      }),
    );
    // The target's own row for the same conversation — not pinned yet.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: 'a2',
        cliSessionId: CONVERSATION_A,
        title: 'Macs',
        lastActivityAt: 1_000,
      }),
    );

    const plan = planPinParity(store, NEW_ACCOUNT, [], () => fakePinState(['local_a1']));
    expect(plan.toPin.map((item) => item.cardId)).toEqual(['local_a2']);
    expect(plan.toUnpin).toEqual([]);
  });

  it('does nothing when the source is not pinned', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'a1', cliSessionId: CONVERSATION_A, lastActivityAt: 2_000 }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'a2', cliSessionId: CONVERSATION_A, lastActivityAt: 1_000 }),
    );

    const plan = planPinParity(store, NEW_ACCOUNT, [], () => fakePinState([]));
    expect(plan.toPin).toEqual([]);
    expect(plan.toUnpin).toEqual([]);
  });

  it('never pins an archived row', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'a1', cliSessionId: CONVERSATION_A, lastActivityAt: 2_000 }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: 'a2',
        cliSessionId: CONVERSATION_A,
        lastActivityAt: 1_000,
        isArchived: true,
      }),
    );

    const plan = planPinParity(store, NEW_ACCOUNT, [], () => fakePinState(['local_a1']));
    expect(plan.toPin).toEqual([]);
  });

  it('unpins a target row only when foster itself pinned it before (local change wins)', () => {
    const store = makeStore();
    // Source no longer pins this conversation.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'b1', cliSessionId: CONVERSATION_B, lastActivityAt: 2_000 }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'b2', cliSessionId: CONVERSATION_B, lastActivityAt: 1_000 }),
    );

    const ledger = newLedger();
    ledger.append({
      kind: 'pins_synced',
      account: NEW_ACCOUNT,
      pinned: ['local_b2'],
      unpinned: [],
    });

    const plan = planPinParity(store, NEW_ACCOUNT, ledger.read(), () => fakePinState(['local_b2']));
    expect(plan.toUnpin.map((item) => item.cardId)).toEqual(['local_b2']);
  });

  it('never unpins a target row the user pinned by hand', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'b1', cliSessionId: CONVERSATION_B, lastActivityAt: 2_000 }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'b2', cliSessionId: CONVERSATION_B, lastActivityAt: 1_000 }),
    );

    // No `pins_synced` event at all — this pin was never foster's doing.
    const plan = planPinParity(store, NEW_ACCOUNT, [], () => fakePinState(['local_b2']));
    expect(plan.toUnpin).toEqual([]);
  });

  it('reports an unreadable pin list rather than throwing', () => {
    const store = makeStore();
    const plan = planPinParity(store, NEW_ACCOUNT, [], () => {
      throw new Error('boom\nmore detail');
    });
    expect(plan.unreadable).toBe('boom');
    expect(plan.toPin).toEqual([]);
    expect(plan.toUnpin).toEqual([]);
  });
});

describe('fosterOwnedPins', () => {
  it('folds pinned ids forward and unpinned ids back out', () => {
    const ledger = newLedger();
    ledger.append({ kind: 'pins_synced', account: NEW_ACCOUNT, pinned: ['x', 'y'], unpinned: [] });
    ledger.append({ kind: 'pins_synced', account: NEW_ACCOUNT, pinned: [], unpinned: ['x'] });
    const owned = fosterOwnedPins(ledger.read(), NEW_ACCOUNT);
    expect(owned).toEqual(new Set(['y']));
  });

  it('never mixes events from a different account', () => {
    const ledger = newLedger();
    ledger.append({ kind: 'pins_synced', account: OLD_ACCOUNT, pinned: ['x'], unpinned: [] });
    const owned = fosterOwnedPins(ledger.read(), NEW_ACCOUNT);
    expect(owned.size).toBe(0);
  });
});
