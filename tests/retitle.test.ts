import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { retitleCards } from '../src/engine/retitle.js';
import { Ledger } from '../src/ledger/log.js';
import { listRetitled, project } from '../src/ledger/project.js';
import { makeStore, NEW_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * The second write foster makes to a file it did not create: a title and an
 * archived flag, and nothing else. These pin down that nothing else moves, that
 * nothing is written or recorded when nothing would change, and that the log
 * can say what the card wore before.
 */

const CARD = '00000000-0000-4000-8000-0000000000f1';

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-ret-')), 'l.jsonl'));
}

function fixture() {
  const store = makeStore();
  const file = writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: CARD, title: 'Work', isArchived: false, effort: 'xhigh' }),
  );
  return { store, file, ledger: ledgerIn() };
}

describe('retitleCards', () => {
  it('rewrites the title and the flag, and carries every other key through', () => {
    const { file, ledger } = fixture();

    const [outcome] = retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: '(stale) Work',
          archived: true,
          as: 'stale',
        },
      ],
      { ledger },
    );

    expect(outcome).toMatchObject({
      status: 'retitled',
      from: 'Work',
      to: '(stale) Work',
      archived: { from: false, to: true },
      as: 'stale',
    });
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(written.title).toBe('(stale) Work');
    expect(written.isArchived).toBe(true);
    // The rest of the card is the app's, and is carried through untouched.
    expect(written.effort).toBe('xhigh');
    expect(written.titleSource).toBe('auto');
    expect(written.sessionId).toBe(`local_${CARD}`);
  });

  it('records what the card wore before, so the log can put it back', () => {
    const { file, ledger } = fixture();

    retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: '(stale) Work',
          archived: true,
          as: 'stale',
        },
      ],
      { ledger },
    );

    const [event] = ledger.read();
    expect(event).toMatchObject({
      kind: 'card_retitled',
      sessionId: `local_${CARD}`,
      from: 'Work',
      to: '(stale) Work',
      fromArchived: false,
      toArchived: true,
      native: true,
      as: 'stale',
    });
    expect(listRetitled(project(ledger.read()))).toHaveLength(1);
  });

  it('leaves the flag alone when the request says nothing about it', () => {
    const { file, ledger } = fixture();

    retitleCards([{ path: file, target: NEW_ACCOUNT, native: true, title: 'Renamed', as: 'tip' }], {
      ledger,
    });

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(written.isArchived).toBe(false);
    expect(ledger.read()[0]).not.toHaveProperty('toArchived');
  });

  it('skips a card that already says so, and records nothing', () => {
    const { file, ledger } = fixture();
    const before = readFileSync(file, 'utf8');

    const [outcome] = retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: 'Work',
          archived: false,
          as: 'stale',
        },
      ],
      { ledger },
    );

    expect(outcome!.status).toBe('skipped');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(ledger.read()).toHaveLength(0);
  });

  it('writes nothing on a dry run, and still says what it would do', () => {
    const { file, ledger } = fixture();
    const before = readFileSync(file, 'utf8');

    const [outcome] = retitleCards(
      [
        {
          path: file,
          target: NEW_ACCOUNT,
          native: true,
          title: '(stale) Work',
          archived: true,
          as: 'stale',
        },
      ],
      { ledger, dryRun: true },
    );

    expect(outcome).toMatchObject({ status: 'retitled', archived: { from: false, to: true } });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(ledger.read()).toHaveLength(0);
  });

  it('fails a card it cannot read rather than inventing one', () => {
    const { store, ledger } = fixture();
    const missing = path.join(store.codeSessionsDir, 'local_missing.json');

    const [outcome] = retitleCards(
      [{ path: missing, target: NEW_ACCOUNT, native: true, title: 'x', as: 'stale' }],
      { ledger },
    );

    expect(outcome!.status).toBe('failed');
    expect(ledger.read()).toHaveLength(0);
  });
});
