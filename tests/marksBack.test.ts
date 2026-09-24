import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyLayout, planLayout } from '../src/engine/layout.js';
import { planMarksBack } from '../src/engine/marksBack.js';
import { retitleCards } from '../src/engine/retitle.js';
import { Ledger } from '../src/ledger/log.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * A mark written while the app runs can be saved over by the app from memory —
 * measured on a real store, 10 of 49 in three minutes. These pin down that the
 * closed-app gap writes exactly those back, and nothing somebody renamed.
 */

const CARD = '00000000-0000-4000-8000-0000000000e1';
const MARKED = '(outro arquivo, parou 18/09 13:33) Work';

function fixture() {
  const store = makeStore();
  const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-mb-')), 'l.jsonl'));
  const file = writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: CARD, title: 'Work', isArchived: false }),
  );
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
  return { store, ledger, file };
}

/** What the running app does: the card it held in memory, written back over ours. */
function appSavesBack(file: string, title: string, isArchived = false): void {
  const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...data, title, isArchived }), 'utf8');
}

describe('planMarksBack', () => {
  it('has nothing to do while the mark still stands', () => {
    const { ledger } = fixture();
    expect(planMarksBack(ledger.read(), NEW_ACCOUNT)).toEqual([]);
  });

  it('writes a mark again when the card is back under a title it wore before', () => {
    const { ledger, file } = fixture();
    appSavesBack(file, 'Work');

    expect(planMarksBack(ledger.read(), NEW_ACCOUNT)).toEqual([
      expect.objectContaining({
        path: file,
        title: MARKED,
        archived: true,
        as: 'other-file',
        template: '(outro arquivo, parou {when}) ',
      }),
    ]);
  });

  it('leaves a card somebody renamed alone', () => {
    const { ledger, file } = fixture();
    appSavesBack(file, 'A name somebody chose');
    expect(planMarksBack(ledger.read(), NEW_ACCOUNT)).toEqual([]);
  });

  it('leaves a card that only came back out of the archived view alone', () => {
    const { ledger, file } = fixture();
    // Title still the mark, flag lifted by hand: somebody opened the row.
    appSavesBack(file, MARKED, false);
    expect(planMarksBack(ledger.read(), NEW_ACCOUNT)).toEqual([]);
  });

  it('only looks at the account it is asked about', () => {
    const { ledger, file } = fixture();
    appSavesBack(file, 'Work');
    expect(planMarksBack(ledger.read(), OLD_ACCOUNT)).toEqual([]);
  });

  it('follows the last write, not the first: a mark taken off stays off', () => {
    const { ledger, file } = fixture();
    retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: 'Work',
          archived: false,
          as: 'tip',
        },
      ],
      { ledger },
    );
    // The app saves the marked title back over the write that took it off.
    appSavesBack(file, MARKED, true);

    expect(planMarksBack(ledger.read(), NEW_ACCOUNT)).toEqual([
      expect.objectContaining({ title: 'Work', archived: false, as: 'tip' }),
    ]);
  });
});

describe('applyLayout — marks the app saved over', () => {
  it('writes them again in the closed-app gap, and records the write', () => {
    const { store, ledger, file } = fixture();
    appSavesBack(file, 'Work');

    const plan = planLayout({ store, target: NEW_ACCOUNT, ledgerEvents: ledger.read() });
    expect(plan.marks).toHaveLength(1);
    const result = applyLayout(plan, { store, ledger, list: () => [] });

    expect(result.marksBack).toBe(1);
    expect(result.written).toContain('marks');
    const card = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(card.title).toBe(MARKED);
    expect(card.isArchived).toBe(true);
    // Settled: the next plan finds the mark standing and has nothing to do.
    expect(planMarksBack(ledger.read(), NEW_ACCOUNT)).toEqual([]);
  });
});
