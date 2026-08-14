import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { uniquePrefix } from '../src/domain/prefix.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { applyLabel } from '../src/ops/label.js';
import { listFosterable } from '../src/ops/foster.js';
import { partitionByStore, selectReturnTargets } from '../src/ops/active.js';
import { fosterSessions } from '../src/engine/executor.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-ops-')), 'l.jsonl'));
}

describe('uniquePrefix', () => {
  const ids = ['aaaa1111-0000-4000-8000-000000000001', 'bbbb2222-0000-4000-8000-000000000002'];

  it('resolves a unique prefix, case-insensitively', () => {
    const result = uniquePrefix(ids, 'AAAA', (id) => id);
    expect(result).toEqual({ kind: 'one', id: ids[0], items: [ids[0]] });
  });

  it('refuses an ambiguous prefix rather than picking one', () => {
    const result = uniquePrefix(
      ['aaaa1111-0000-4000-8000-000000000001', 'aaaa2222-0000-4000-8000-000000000002'],
      'aaaa',
      (id) => id,
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('says none rather than guessing', () => {
    expect(uniquePrefix(ids, 'ffff', (id) => id)).toEqual({ kind: 'none' });
  });
});

describe('listFosterable', () => {
  it('does not offer a copy that has lost its on-disk marker', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c1' }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });

    const [copy] = listActive(project(ledger.read()));
    const stripped = JSON.parse(readFileSync(copy!.copyPath, 'utf8')) as Record<string, unknown>;
    delete stripped._foster;
    writeFileSync(copy!.copyPath, JSON.stringify(stripped), 'utf8');

    // The destination is the source: a later sweep from NEW would otherwise
    // treat the opened copy as a native session and offer it again.
    const offered = listFosterable(store, [NEW_ACCOUNT], ledger);
    expect(offered.map((s) => s.data.sessionId)).not.toContain(copy!.copySessionId);
  });
});

describe('applyLabel', () => {
  it('records the name against the account a prefix names', () => {
    const ledger = ledgerIn();
    const result = applyLabel(
      ledger,
      '11111111',
      'work',
      [NEW_ACCOUNT.accountUuid, OLD_ACCOUNT.accountUuid],
      OLD_ACCOUNT.accountUuid,
    );
    expect(result).toEqual({ accountUuid: NEW_ACCOUNT.accountUuid, label: 'work' });
    expect(project(ledger.read()).labels.get(NEW_ACCOUNT.accountUuid)).toBe('work');
  });

  it('refuses an empty name', () => {
    const ledger = ledgerIn();
    expect(() =>
      applyLabel(ledger, NEW_ACCOUNT.accountUuid, '   ', [NEW_ACCOUNT.accountUuid], undefined),
    ).toThrow(/must not be empty/);
  });
});

describe('selectReturnTargets', () => {
  it('refuses a session prefix that matches nothing', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    expect(() => selectReturnTargets(store, ledger, { sessionIds: ['ffffffff'] })).toThrow(
      /No fostered copy matches/,
    );
  });

  it('scopes to this store and counts the rest', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c2' }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });

    const otherRoot = mkdtempSync(path.join(tmpdir(), 'foster-ops-other-'));
    mkdirSync(path.join(otherRoot, 'claude-code-sessions'), { recursive: true });
    const [active] = listActive(project(ledger.read()));
    const elsewhere = {
      ...active!,
      copyPath: path.join(otherRoot, 'claude-code-sessions', 'gone.json'),
    };

    const { here, elsewhere: other } = partitionByStore([active!, elsewhere], store);
    expect(here).toHaveLength(1);
    expect(other).toHaveLength(1);
  });
});
