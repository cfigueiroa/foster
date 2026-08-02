import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fosterSessions } from '../src/engine/executor.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * Two profiles are two whole stores. Copying between them is the same operation
 * the engine already performs — only the scan moves — and the copy has to say
 * where it came from, because two installations can hold the same account id.
 */
let source: StoreLayout;
let target: StoreLayout;
let ledger: Ledger;

beforeEach(() => {
  source = makeStore();
  target = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-xs-')), 'l.jsonl'));
});

describe('fostering from one store into another', () => {
  it('writes into the target store and leaves the source untouched', () => {
    writeSession(source, OLD_ACCOUNT, session({ title: 'Work in the other profile' }));
    const found = scanAccount(source, OLD_ACCOUNT);

    const [outcome] = fosterSessions(found, {
      store: target,
      ledger,
      target: NEW_ACCOUNT,
      sourceStore: source.root,
    });

    expect(outcome!.status).toBe('fostered');
    expect(outcome!.copyPath!.startsWith(target.root)).toBe(true);
    expect(scanAccount(source, OLD_ACCOUNT)).toHaveLength(1);
    expect(scanAccount(source, OLD_ACCOUNT)[0]!.isCopy).toBe(false);
  });

  it('records the store it came from, so the origin stays locatable', () => {
    // The two stores can legitimately hold the same account uuid, which would
    // make the account alone an ambiguous origin.
    writeSession(source, OLD_ACCOUNT, session());
    fosterSessions(scanAccount(source, OLD_ACCOUNT), {
      store: target,
      ledger,
      target: NEW_ACCOUNT,
      sourceStore: source.root,
    });

    const [copy] = scanAccount(target, NEW_ACCOUNT);
    expect(copy!.data._foster!.originStore).toBe(source.root);
    expect(copy!.data._foster!.originAccountUuid).toBe(OLD_ACCOUNT.accountUuid);
  });

  it('leaves the marker out when both sides are the same store', () => {
    // Noise otherwise: within one store the account already names the origin.
    writeSession(source, OLD_ACCOUNT, session());
    fosterSessions(scanAccount(source, OLD_ACCOUNT), {
      store: source,
      ledger,
      target: NEW_ACCOUNT,
      sourceStore: source.root,
    });

    const [copy] = scanAccount(source, NEW_ACCOUNT);
    expect(copy!.data._foster!.originStore).toBeUndefined();
  });

  it('is undoable, and the undo reaches across stores', () => {
    writeSession(source, OLD_ACCOUNT, session());
    fosterSessions(scanAccount(source, OLD_ACCOUNT), {
      store: target,
      ledger,
      target: NEW_ACCOUNT,
      sourceStore: source.root,
    });

    const [active] = listActive(project(ledger.read()));
    // The ledger keeps an absolute path, so returning does not need to be told
    // which store the copy landed in.
    expect(active!.copyPath.startsWith(target.root)).toBe(true);
  });

  it('can carry the same account across, without confusing it for a copy', () => {
    // The same account signed in on two profiles: same uuid, different store.
    writeSession(source, NEW_ACCOUNT, session({ title: 'Same account, other profile' }));

    const [outcome] = fosterSessions(scanAccount(source, NEW_ACCOUNT), {
      store: target,
      ledger,
      target: NEW_ACCOUNT,
      sourceStore: source.root,
    });

    expect(outcome!.status).toBe('fostered');
    expect(scanAccount(target, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
  });
});
