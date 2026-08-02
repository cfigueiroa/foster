import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fosterSessions } from '../src/engine/executor.js';
import { writeFileAtomic } from '../src/engine/fsatomic.js';
import { Ledger } from '../src/ledger/log.js';
import { activityOf, applyFilter } from '../src/cli/filters.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-reg-'));
}

describe('the same origin session appearing twice in one batch', () => {
  it('is fostered once, so no copy is orphaned', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(scratch(), 'ledger.jsonl'));
    const secondOrg = {
      accountUuid: OLD_ACCOUNT.accountUuid,
      organizationUuid: '00000000-0000-4000-8000-0000000000ee',
    };

    // The same session file present under two organizations of the old account.
    const duplicated = session({ sessionId: '00000000-0000-4000-8000-0000000000dd' });
    writeSession(store, OLD_ACCOUNT, duplicated);
    writeSession(store, secondOrg, duplicated);

    const both = [...scanAccount(store, OLD_ACCOUNT), ...scanAccount(store, secondOrg)];
    expect(both).toHaveLength(2);

    const outcomes = fosterSessions(both, {
      store,
      ledger,
      target: NEW_ACCOUNT,
      guard: () => {},
    });

    // Without in-batch tracking both would be written, and the ledger fold would
    // keep only the last one — orphaning the first copy on disk.
    expect(outcomes.filter((o) => o.status === 'fostered')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1);
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(1);
  });
});

describe('writeFileAtomic', () => {
  it('writes contents larger than a single write buffer intact', () => {
    const dir = scratch();
    const target = path.join(dir, 'session.json');
    const payload = JSON.stringify({ big: 'x'.repeat(500_000) });

    writeFileAtomic(target, payload);

    expect(readFileSync(target, 'utf8')).toBe(payload);
    expect(readdirSync(dir)).toEqual(['session.json']);
  });

  it('cleans up its temporary file when the rename fails', () => {
    const dir = scratch();
    // Renaming a file onto a populated directory fails on every platform.
    const target = path.join(dir, 'occupied');
    mkdirSync(target);
    writeFileSync(path.join(target, 'child'), 'x', 'utf8');

    expect(() => writeFileAtomic(target, '{}')).toThrow();
    expect(readdirSync(dir).some((name) => name.startsWith('.foster-tmp-'))).toBe(false);
  });
});

describe('--since and the ordering agree on what "recent" means', () => {
  it('keeps a session whose only timestamp is lastFocusedAt', () => {
    // The filter used to ignore lastFocusedAt while the sort considered it, so a
    // session opened recently sorted to the top and was then filtered out.
    const opened = session({ sessionId: '00000000-0000-4000-8000-0000000000c1' });
    delete opened.lastActivityAt;
    delete opened.createdAt;

    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, opened);
    const discovered = scanAccount(store, OLD_ACCOUNT);

    expect(activityOf(discovered[0]!)).toBe(opened.lastFocusedAt);
    expect(applyFilter(discovered, { since: opened.lastFocusedAt! - 1 })).toHaveLength(1);
  });
});

describe('the recorded original title', () => {
  it('is the source title, verbatim', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(scratch(), 'ledger.jsonl'));
    writeSession(store, OLD_ACCOUNT, session({ title: 'Refactor parser' }));

    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      guard: () => {},
    });

    const fostered = ledger.read().find((event) => event.kind === 'fostered');
    expect(fostered).toMatchObject({ originalTitle: 'Refactor parser' });
  });

  it('is absent rather than empty when the session has no title', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(scratch(), 'ledger.jsonl'));
    const untitled = session();
    delete untitled.title;
    writeSession(store, OLD_ACCOUNT, untitled);

    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      guard: () => {},
    });

    // '' is not nullish, so recording it defeated every `?? fallback` downstream.
    const fostered = ledger.read().find((event) => event.kind === 'fostered');
    expect(
      fostered && 'originalTitle' in fostered ? fostered.originalTitle : undefined,
    ).toBeUndefined();
  });
});
