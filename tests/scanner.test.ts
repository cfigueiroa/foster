import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFosterCopy } from '../src/domain/fostering.js';
import { accountDir } from '../src/domain/paths.js';
import {
  scanAccount,
  scanSources,
  scanStore,
  SESSION_FILE_MAX_BYTES,
  summarise,
} from '../src/store/scanner.js';
import { applyFilter } from '../src/domain/filter.js';
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

describe('the app’s own size limit', () => {
  it('excludes a session too big for the app to load', () => {
    const store = makeStore();
    const big = session({ sessionId: '00000000-0000-4000-8000-0000000000f1' });
    // Padded past the 10 MB the app refuses to read. Copying it would write a
    // file the app skips in silence.
    big.padding = 'x'.repeat(SESSION_FILE_MAX_BYTES);
    writeSession(store, OLD_ACCOUNT, big);

    const [found] = scanAccount(store, OLD_ACCOUNT);
    expect(found!.reasons).toContain('too-large');
  });

  it('leaves an ordinary session alone', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session());

    const [found] = scanAccount(store, OLD_ACCOUNT);
    expect(found!.reasons).not.toContain('too-large');
  });
});

describe('a copy that is the last card its conversation has', () => {
  const CONVERSATION = '00000000-0000-4000-8000-0000000000e1';

  /** A copy in NEW_ACCOUNT of a session belonging to OLD_ACCOUNT. */
  function copyOf(store: ReturnType<typeof makeStore>, origin: ReturnType<typeof session>) {
    return writeSession(store, NEW_ACCOUNT, buildFosterCopy(origin, { origin: OLD_ACCOUNT }));
  }

  it('stays out of the running while the original is still there', () => {
    const store = makeStore();
    const origin = session({ sessionId: CONVERSATION });
    writeSession(store, OLD_ACCOUNT, origin);
    copyOf(store, origin);

    const copy = scanStore(store).find((found) => found.isCopy)!;
    expect(copy.isStranded).toBe(false);
    expect(copy.reasons).toContain('already-a-copy');
    // Fostering it would put a second copy of a conversation that is reachable
    // the ordinary way.
    expect(applyFilter(scanStore(store), {})).toHaveLength(1);
  });

  it('becomes a source once the original is gone', () => {
    // What restore leaves behind, and what deleting an origin card produces: a
    // conversation whose only card anywhere is foster's own copy. Refusing it
    // does not keep anything tidy — it strands the conversation for good.
    const store = makeStore();
    copyOf(store, session({ sessionId: CONVERSATION }));

    const [copy] = scanStore(store);

    expect(copy!.isCopy).toBe(true);
    expect(copy!.isStranded).toBe(true);
    expect(copy!.reasons).toEqual([]);
    expect(applyFilter(scanStore(store), {})).toHaveLength(1);
  });

  it('keeps every reason that is about the file rather than the copying', () => {
    const store = makeStore();
    copyOf(store, session({ sessionId: CONVERSATION, isArchived: true }));

    const [copy] = scanStore(store);

    expect(copy!.isStranded).toBe(true);
    expect(copy!.reasons).toEqual(['archived']);
  });

  it('is judged across accounts, not within one', () => {
    // The original sits in an account the sweep is not reading. Deciding from
    // the source account alone would call the copy stranded and duplicate it.
    const store = makeStore();
    const origin = session({ sessionId: CONVERSATION });
    writeSession(store, OLD_ACCOUNT, origin);
    copyOf(store, origin);

    expect(scanAccount(store, NEW_ACCOUNT)[0]!.isStranded).toBe(false);
    expect(scanSources(store, [NEW_ACCOUNT])[0]!.isStranded).toBe(false);
  });

  it('does not strand a copy just because another copy shares the conversation', () => {
    const store = makeStore();
    const origin = session({ sessionId: CONVERSATION });
    copyOf(store, origin);
    copyOf(store, origin);

    // Both are copies and neither conversation has an own card: both are the
    // last card, and the destination check is what stops the pair.
    expect(scanStore(store).every((found) => found.isStranded)).toBe(true);
  });
});
