import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLedgerEvent } from '../src/ledger/log.js';
import { parseSessionData, readSessionFile } from '../src/store/sessionFile.js';
import { makeStore } from './helpers/store.js';

describe('parseSessionData', () => {
  it('accepts a record that names itself', () => {
    const data = parseSessionData(JSON.stringify({ sessionId: 'local_abc', title: 'Work' }));
    expect(data?.sessionId).toBe('local_abc');
    expect(data?.title).toBe('Work');
  });

  it('refuses valid JSON that has no sessionId', () => {
    expect(parseSessionData(JSON.stringify({ title: 'orphan notes' }))).toBeUndefined();
  });
});

describe('readSessionFile', () => {
  it('skips a neighbor that is JSON but not a session, and still reads the real card', () => {
    const store = makeStore();
    const good = path.join(store.root, 'good.json');
    const junk = path.join(store.root, 'junk.json');
    writeFileSync(good, JSON.stringify({ sessionId: 'local_good', title: 'Real' }), 'utf8');
    writeFileSync(junk, JSON.stringify({ title: 'no discriminant' }), 'utf8');

    expect(readSessionFile(junk)).toBeUndefined();
    expect(readSessionFile(good)?.sessionId).toBe('local_good');
  });
});

describe('parseLedgerEvent', () => {
  it('accepts a line that names a kind we fold', () => {
    const event = parseLedgerEvent(
      JSON.stringify({ kind: 'failed', operation: 'foster', reason: 'disk' }),
    );
    expect(event?.kind).toBe('failed');
  });

  it('refuses valid JSON that has no kind', () => {
    expect(parseLedgerEvent(JSON.stringify({ originSessionId: 'local_x' }))).toBeUndefined();
  });
});
