import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFosterCopy } from '../src/domain/fostering.js';
import { accountDir } from '../src/domain/paths.js';
import { scanAccount, scanStore, summarise } from '../src/store/scanner.js';
import { readConfig } from '../src/store/config.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

describe('scanAccount', () => {
  it('finds sessions and binds them to the directory they live in', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-00000000001a' }),
    );

    const found = scanAccount(store, OLD_ACCOUNT);

    expect(found).toHaveLength(1);
    expect(found[0]!.account).toEqual(OLD_ACCOUNT);
  });

  it('skips malformed files instead of failing the whole scan', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session());
    const dir = accountDir(store, OLD_ACCOUNT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'local_broken.json'), '{ not json', 'utf8');

    expect(scanAccount(store, OLD_ACCOUNT)).toHaveLength(1);
  });

  it('ignores tombstones and unrelated files', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session());
    const dir = accountDir(store, OLD_ACCOUNT);
    writeFileSync(path.join(dir, 'deleted_00000000-0000-4000-8000-00000000001b'), '123', 'utf8');
    writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf8');

    expect(scanAccount(store, OLD_ACCOUNT)).toHaveLength(1);
  });
});

describe('copy classification', () => {
  it('recognises a foster copy so a rescan does not treat it as a new discovery', () => {
    const store = makeStore();
    const origin = session({ sessionId: '00000000-0000-4000-8000-00000000002a' });
    writeSession(store, OLD_ACCOUNT, origin);
    writeSession(store, NEW_ACCOUNT, buildFosterCopy(origin, { origin: OLD_ACCOUNT }));

    const all = scanStore(store);
    const copies = all.filter((s) => s.isCopy);
    const natives = all.filter((s) => !s.isCopy);

    expect(natives).toHaveLength(1);
    expect(copies).toHaveLength(1);
    // The copy still points back at its true origin, not at the folder it sits in.
    expect(copies[0]!.data._foster?.originAccountUuid).toBe(OLD_ACCOUNT.accountUuid);
    expect(copies[0]!.account).toEqual(NEW_ACCOUNT);
  });

  it('never offers a copy for fostering again', () => {
    const store = makeStore();
    const origin = session();
    writeSession(store, NEW_ACCOUNT, buildFosterCopy(origin, { origin: OLD_ACCOUNT }));

    const [copy] = scanAccount(store, NEW_ACCOUNT);
    expect(copy!.reasons).toContain('already-a-copy');
  });
});

describe('summarise', () => {
  it('counts natives and copies per account and flags the current one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-00000000003a' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-00000000003b' }),
    );
    writeSession(store, NEW_ACCOUNT, buildFosterCopy(session(), { origin: OLD_ACCOUNT }));

    const summary = summarise(store, NEW_ACCOUNT.accountUuid);
    const oldSummary = summary.find((s) => s.account.accountUuid === OLD_ACCOUNT.accountUuid);
    const newSummary = summary.find((s) => s.account.accountUuid === NEW_ACCOUNT.accountUuid);

    expect(oldSummary).toMatchObject({ nativeCount: 2, copyCount: 0, isCurrent: false });
    expect(newSummary).toMatchObject({ nativeCount: 0, copyCount: 1, isCurrent: true });
  });
});

describe('readConfig', () => {
  it('reads the current account pointer and ignores everything sensitive', () => {
    const store = makeStore();
    writeFileSync(
      store.configFile,
      JSON.stringify({
        lastKnownAccountUuid: NEW_ACCOUNT.accountUuid,
        locale: 'pt-BR',
        'oauth:tokenCache': 'SHOULD-NEVER-BE-READ',
        'oauth:tokenCacheV2': 'SHOULD-NEVER-BE-READ',
      }),
      'utf8',
    );

    const config = readConfig(store);

    expect(config.lastKnownAccountUuid).toBe(NEW_ACCOUNT.accountUuid);
    expect(config.locale).toBe('pt-BR');
    expect(JSON.stringify(config)).not.toContain('SHOULD-NEVER-BE-READ');
  });

  it('returns empty rather than throwing when there is no config', () => {
    expect(readConfig(makeStore())).toEqual({});
  });
});
