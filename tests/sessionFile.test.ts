import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLedgerEvent } from '../src/ledger/log.js';
import {
  parseSessionData,
  readSessionCard,
  readSessionFile,
  withBulkyFields,
} from '../src/store/sessionFile.js';
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

describe('readSessionCard / withBulkyFields', () => {
  const bulky = { servers: { big: 'x'.repeat(1000) } };

  function cardOnDisk() {
    const store = makeStore();
    const file = path.join(store.root, 'local_card.json');
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: 'local_card',
        remoteMcpServersConfig: bulky,
        title: 'Work',
        enabledMcpTools: ['a'],
        cwd: '/w',
      }),
      'utf8',
    );
    return file;
  }

  it('leaves the bulky fields out of what a scan keeps, and says it did', () => {
    const card = readSessionCard(cardOnDisk());
    expect(card?.slim).toBe(true);
    expect(card?.data).toEqual({ sessionId: 'local_card', title: 'Work', cwd: '/w' });
  });

  it('puts them back from disk, in file order, keeping every change made in memory', () => {
    const file = cardOnDisk();
    const card = readSessionCard(file)!;
    const edited = { ...card.data, title: 'Renamed' } as Record<string, unknown>;
    delete edited.cwd;

    const whole = withBulkyFields({ path: file, data: edited as never, slim: true });
    expect(Object.keys(whole)).toEqual([
      'sessionId',
      'remoteMcpServersConfig',
      'title',
      'enabledMcpTools',
    ]);
    expect(whole).toMatchObject({ title: 'Renamed', remoteMcpServersConfig: bulky });
  });

  it('hands a card the scan did not slim back as it is', () => {
    const data = { sessionId: 'local_x', title: 'T' };
    expect(withBulkyFields({ path: '/nowhere', data: data as never })).toBe(data);
  });
});
