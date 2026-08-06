import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { isFostered, listActive, project, selectByTarget } from '../src/ledger/project.js';
import type { ActiveFostering } from '../src/ledger/types.js';
import type { AccountRef } from '../src/domain/types.js';
import { NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

function makeLedger(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-ledger-')), 'ledger.jsonl'));
}

const fostered = {
  kind: 'fostered' as const,
  originSessionId: 'local_origin-1',
  origin: OLD_ACCOUNT,
  target: NEW_ACCOUNT,
  copySessionId: 'local_copy-1',
  copyPath: '/store/new/local_copy-1.json',
  originalTitle: 'Refactor parser',
  prefix: '↪ ',
};

describe('Ledger', () => {
  it('round-trips appended events', () => {
    const ledger = makeLedger();
    ledger.append(fostered);

    const events = ledger.read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'fostered', v: 1, originSessionId: 'local_origin-1' });
  });

  it('returns empty for a ledger that does not exist yet', () => {
    expect(makeLedger().read()).toEqual([]);
  });

  it('survives a torn final line instead of losing the whole log', () => {
    const ledger = makeLedger();
    ledger.append(fostered);
    appendFileSync(ledger.path, '{"kind":"fostered","v":1', 'utf8');

    expect(ledger.read()).toHaveLength(1);
  });
});

describe('projection', () => {
  it('folds a fostering into active state', () => {
    const state = project([{ ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' }]);

    expect(listActive(state)).toHaveLength(1);
    expect(isFostered(state, 'local_origin-1', NEW_ACCOUNT)).toBe(true);
  });

  it('removes it again on return', () => {
    const state = project([
      { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
      {
        kind: 'returned',
        v: 1,
        ts: 20,
        toolVersion: '0.1.0',
        originSessionId: 'local_origin-1',
        target: NEW_ACCOUNT,
        copySessionId: 'local_copy-1',
      },
    ]);

    expect(listActive(state)).toHaveLength(0);
    expect(isFostered(state, 'local_origin-1', NEW_ACCOUNT)).toBe(false);
  });

  it('keys idempotency on origin session and target account, not on the copy id', () => {
    // Re-fostering mints a different copy id, so the file itself can never be the key.
    const state = project([
      { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
      { ...fostered, v: 1, ts: 20, toolVersion: '0.1.0', copySessionId: 'local_copy-2' },
    ]);

    expect(listActive(state)).toHaveLength(1);
    expect(listActive(state)[0]!.copySessionId).toBe('local_copy-2');
  });

  it('treats the same session in a different target account as a separate fostering', () => {
    const other = { accountUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', organizationUuid: 'x' };
    const state = project([
      { ...fostered, v: 1, ts: 10, toolVersion: '0.1.0' },
      { ...fostered, v: 1, ts: 20, toolVersion: '0.1.0', target: other },
    ]);

    expect(listActive(state)).toHaveLength(2);
  });

  it('records labels and ignores failures for state purposes', () => {
    const state = project([
      {
        kind: 'account_labelled',
        v: 1,
        ts: 1,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        label: 'work',
      },
      {
        kind: 'failed',
        v: 1,
        ts: 2,
        toolVersion: '0.1.0',
        operation: 'foster',
        reason: 'app running',
      },
    ]);

    expect(state.labels.get(OLD_ACCOUNT.accountUuid)).toBe('work');
    expect(listActive(state)).toHaveLength(0);
  });
});

describe('selectByTarget', () => {
  const OTHER: AccountRef = {
    accountUuid: '22222222-2222-4222-8222-222222222222',
    organizationUuid: '22222222-2222-4222-8222-222222222223',
  };

  function copyInto(target: AccountRef, originSessionId: string): ActiveFostering {
    return {
      originSessionId,
      origin: OLD_ACCOUNT,
      target,
      copySessionId: `local_${originSessionId}`,
      copyPath: `/store/${target.accountUuid}/${originSessionId}.json`,
      fosteredAt: 1,
    };
  }

  const active = [copyInto(NEW_ACCOUNT, 'a1'), copyInto(NEW_ACCOUNT, 'a2'), copyInto(OTHER, 'b1')];

  it('keeps only the copies in the account named', () => {
    // The whole point: cleaning up an account you stopped using must not touch
    // the one you are in.
    const picked = selectByTarget(active, OTHER.accountUuid.slice(0, 8), undefined);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.originSessionId).toBe('b1');
  });

  it('says where the copies actually are when the prefix matches none', () => {
    expect(() => selectByTarget(active, 'deadbeef', undefined)).toThrow(/No fostered copies/);
    expect(() => selectByTarget(active, 'deadbeef', undefined)).toThrow(
      new RegExp(`${NEW_ACCOUNT.accountUuid}  2 copies`),
    );
  });

  it('refuses a prefix that spans two accounts rather than guessing wide', () => {
    // Guessing here removes copies from an account nobody named.
    expect(() => selectByTarget(active, '', undefined)).toThrow(/ambiguous: it matches 2 accounts/);
  });

  it('narrows by organization on its own', () => {
    const picked = selectByTarget(active, undefined, OTHER.organizationUuid.slice(0, 8));
    expect(picked.map((f) => f.originSessionId)).toEqual(['b1']);
  });
});
