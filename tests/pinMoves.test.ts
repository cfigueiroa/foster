import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { applyPinMoves, pinClearPending, planPinMoves } from '../src/engine/pinMoves.js';
import { planPinParity } from '../src/engine/pinParity.js';
import {
  PIN_STATE_KEY,
  indexedDbDir,
  readPinState,
  recordKey,
  type PinState,
} from '../src/store/pinstate.js';
import { encodeBatch, encodeVarint32, frameRecords } from '../src/store/format/leveldb.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

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
const OLDER_VISIBLE_SIBLING = '00000000-0000-4000-8000-0000000000f6';
// Lexicographic order matters for the tie-break below: f7 sorts before f8.
const TIED_SIBLING_LOWER_ID = '00000000-0000-4000-8000-0000000000f7';
const TIED_SIBLING_HIGHER_ID = '00000000-0000-4000-8000-0000000000f8';

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
    tablesUnreadable: [],
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

  it('picks the most recently active sibling when more than one is visible', () => {
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
    // Two visible siblings of the same conversation — the loop inside
    // `redirectToVisible` has to keep comparing rather than stopping at the
    // first one it sees.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: OLDER_VISIBLE_SIBLING,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: false,
        lastActivityAt: 1_700_000_050_000,
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
        lastActivityAt: 1_700_000_100_000,
      }),
    );

    deferMove(ledger, `local_${ARCHIVED_TARGET}`);

    const plan = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`]),
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({ cleanSessionId: `local_${VISIBLE_SIBLING}` }),
    ]);
  });

  it('breaks an exact activity tie between visible siblings by session id', () => {
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
    // Written in an order that would make the higher-id row win if the loop
    // just kept the last one it saw rather than actually comparing ids.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: TIED_SIBLING_HIGHER_ID,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: false,
        lastActivityAt: 1_700_000_100_000,
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: TIED_SIBLING_LOWER_ID,
        cliSessionId: CONVERSATION,
        title: 'Macs',
        isArchived: false,
        lastActivityAt: 1_700_000_100_000,
      }),
    );

    deferMove(ledger, `local_${ARCHIVED_TARGET}`);

    const plan = planPinMoves(store, ledger.read(), NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`]),
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({ cleanSessionId: `local_${TIED_SIBLING_LOWER_ID}` }),
    ]);
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

/**
 * Blink's envelope, byte for byte as the installed app writes it — copied from
 * `tests/pinstate.test.ts`, which explains why: foster never constructs this
 * in production, so a fixture has to start from the app's own real bytes.
 */
const ENVELOPE = Buffer.from([
  0xff, 0x15, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x0f, 0x22,
]);
const LOG_NUMBER = 4;

function pinValue(version: number, ids: string[]): Buffer {
  const payload = Buffer.from(
    JSON.stringify({ state: { starredIds: ids }, version: 0, updatedAt: 1 }),
    'latin1',
  );
  return Buffer.concat([
    encodeVarint32(version),
    ENVELOPE,
    encodeVarint32(payload.length),
    payload,
  ]);
}

function encodeExistsVersion(version: number): Buffer {
  const bytes: number[] = [];
  let rest = version;
  do {
    bytes.push(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** A minimal, writable synthetic IndexedDB pin database, holding `ids`. */
function makePinDatabase(store: StoreLayout, ids: string[]): void {
  const dir = indexedDbDir(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');

  const edit = Buffer.concat([
    encodeVarint32(1),
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2),
    encodeVarint32(LOG_NUMBER),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));

  const logPath = path.join(dir, `${String(LOG_NUMBER).padStart(6, '0')}.log`);
  writeFileSync(
    logPath,
    frameRecords(
      encodeBatch(1n, [
        { key: recordKey(1, PIN_STATE_KEY, 1), value: pinValue(1, ids) },
        { key: recordKey(2, PIN_STATE_KEY, 1), value: encodeExistsVersion(1) },
      ]),
      0,
    ),
  );
}

describe('emptying the whole pin list (foster pin --clear-all)', () => {
  it('is pending from a deferral until a clear settles it', () => {
    const ledger = new Ledger(
      path.join(mkdtempSync(path.join(tmpdir(), 'foster-pinclear-')), 'l.jsonl'),
    );
    expect(pinClearPending(ledger.read())).toBe(false);
    ledger.append({ kind: 'pins_clear_deferred' });
    expect(pinClearPending(ledger.read())).toBe(true);
    ledger.append({ kind: 'pins_cleared', removed: 3 });
    expect(pinClearPending(ledger.read())).toBe(false);
  });

  it('empties every id in the gap, parity included, and settles the deferral', () => {
    const store = makeStore();
    const ledger = new Ledger(
      path.join(mkdtempSync(path.join(tmpdir(), 'foster-pinclear-')), 'l.jsonl'),
    );
    makePinDatabase(store, ['local_a', 'local_b', 'local_c']);
    ledger.append({ kind: 'pins_clear_deferred' });

    const parity = { target: NEW_ACCOUNT, toPin: [{ cardId: 'local_d', title: 'd' }], toUnpin: [] };
    const result = applyPinMoves(
      store,
      ledger,
      { moves: [], settled: [] },
      { clear: true },
      parity,
    );

    expect(result.cleared).toBe(3);
    expect(readPinState(store)!.ids).toEqual([]);
    expect(pinClearPending(ledger.read())).toBe(false);
  });
});

describe('applyPinMoves — combined with cross-account pin parity in one batch', () => {
  it('writes a pin-move and a parity pin/unpin together, in one append, with both ledger events', () => {
    const store = makeStore();
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-pinmoves-apply-'));
    const ledger = new Ledger(path.join(dir, 'l.jsonl'));

    // A deferred move (stale -> clean), plus a parity source card that is
    // pinned in the other account and a target row foster had pinned before
    // that is no longer wanted.
    makePinDatabase(store, [`local_${STALE_CARD}`, 'local_src1', 'local_old_pin']);

    ledger.append({
      kind: 'pins_synced',
      account: NEW_ACCOUNT,
      pinned: ['local_old_pin'],
      unpinned: [],
    });

    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'src1', cliSessionId: 'conv-parity', lastActivityAt: 2_000 }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'tgt1', cliSessionId: 'conv-parity', lastActivityAt: 1_000 }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'old_pin', cliSessionId: 'conv-no-longer-wanted' }),
    );

    const movePlan = planPinMoves(store, [], NEW_ACCOUNT, () =>
      fakePinState([`local_${STALE_CARD}`, 'local_src1', 'local_old_pin']),
    );
    // No target row for STALE_CARD's conversation exists, so the move settles
    // rather than writes — the point of this test is the parity half.
    void movePlan;

    const parityPlan = planPinParity(store, NEW_ACCOUNT, ledger.read(), readPinState);
    expect(parityPlan.toPin.map((i) => i.cardId)).toEqual(['local_tgt1']);
    expect(parityPlan.toUnpin.map((i) => i.cardId)).toEqual(['local_old_pin']);

    const result = applyPinMoves(store, ledger, { moves: [], settled: [] }, {}, parityPlan);
    expect(result.pinned).toBe(1);
    expect(result.unpinned).toBe(1);

    const after = readPinState(store)!;
    expect(after.ids).toContain('local_tgt1');
    expect(after.ids).not.toContain('local_old_pin');

    const events = ledger.read();
    const synced = events.filter((e) => e.kind === 'pins_synced');
    expect(synced).toHaveLength(2);
    expect(synced[1]).toMatchObject({ pinned: ['local_tgt1'], unpinned: ['local_old_pin'] });
  });
});
