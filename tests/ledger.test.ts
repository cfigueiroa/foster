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

  it('skips a well-formed JSON line that is not an event, and keeps the neighbor', () => {
    const ledger = makeLedger();
    ledger.append(fostered);
    appendFileSync(ledger.path, `${JSON.stringify({ title: 'no kind' })}\n`, 'utf8');
    ledger.append({
      ...fostered,
      originSessionId: 'local_origin-2',
      copySessionId: 'local_copy-2',
    });

    const events = ledger.read();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(['fostered', 'fostered']);
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

  it('accumulates an identity across partial sightings', () => {
    const state = project([
      {
        kind: 'account_identity_seen',
        v: 1,
        ts: 1,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        email: 'john@example.com',
        plan: 'Max',
      },
      {
        kind: 'account_identity_seen',
        v: 1,
        ts: 2,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        name: 'John',
      },
    ]);

    expect(state.identities.get(OLD_ACCOUNT.accountUuid)).toEqual({
      email: 'john@example.com',
      name: 'John',
      plan: 'Max',
      seenAt: 2,
    });
  });

  it('drops the whole identity when a sighting is withdrawn', () => {
    // The case this exists for: an address misread out of compressed rubble was
    // recorded, and no later sighting could correct it — a correction has to
    // find something, and by then the profile had left the cache. Forgetting is
    // the only move the fold can offer, and it takes the name with it: a name
    // kept beside a discredited email is the same mistake, quieter.
    const state = project([
      {
        kind: 'account_identity_seen',
        v: 1,
        ts: 1,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        email: '6@ai.television.ses',
        name: 'John',
      },
      {
        kind: 'account_identity_forgotten',
        v: 1,
        ts: 2,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
      },
    ]);

    expect(state.identities.get(OLD_ACCOUNT.accountUuid)).toBeUndefined();
  });

  it('leaves the label alone when the identity is withdrawn', () => {
    // A name you chose is not the thing that was wrong.
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
        kind: 'account_identity_forgotten',
        v: 1,
        ts: 2,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
      },
    ]);

    expect(state.labels.get(OLD_ACCOUNT.accountUuid)).toBe('work');
  });

  it('records an identity again after one was forgotten', () => {
    const state = project([
      {
        kind: 'account_identity_seen',
        v: 1,
        ts: 1,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        email: 'wrong@example.com',
      },
      {
        kind: 'account_identity_forgotten',
        v: 1,
        ts: 2,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
      },
      {
        kind: 'account_identity_seen',
        v: 1,
        ts: 3,
        toolVersion: '0.1.0',
        accountUuid: OLD_ACCOUNT.accountUuid,
        email: 'john@example.com',
      },
    ]);

    expect(state.identities.get(OLD_ACCOUNT.accountUuid)).toEqual({
      email: 'john@example.com',
      seenAt: 3,
    });
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

/**
 * A title or flag foster rewrote on a card. The fold keeps what the app had,
 * however many sweeps have marked the card since, and forgets the card once it
 * is back to that.
 */
describe('card_retitled', () => {
  const marked = {
    kind: 'card_retitled' as const,
    sessionId: 'local_card-1',
    target: NEW_ACCOUNT,
    path: '/store/new/local_card-1.json',
    native: true,
    as: 'stale' as const,
  };
  const STALE = '(stale, stopped 01/09 18:10) Work';
  const LATER = '(stale, stopped 02/09 05:56) Work';

  it('is read back as an event', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });

    expect(ledger.read()[0]).toMatchObject({ kind: 'card_retitled', to: STALE });
  });

  it('folds to the card, carrying the original title and flag across repeated marks', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });
    ledger.append({ ...marked, from: STALE, to: LATER });

    expect(project(ledger.read()).retitled.get('local_card-1')).toMatchObject({
      from: 'Work',
      to: LATER,
      fromArchived: false,
      toArchived: true,
    });
  });

  it('drops the card once it is back to what the app had', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });
    ledger.append({
      ...marked,
      from: STALE,
      to: 'Work',
      fromArchived: true,
      toArchived: false,
      as: 'tip',
    });

    expect(project(ledger.read()).retitled.size).toBe(0);
  });

  it('keeps the card while the title is back but the flag is not', () => {
    const ledger = makeLedger();
    ledger.append({ ...marked, from: 'Work', to: STALE, fromArchived: false, toArchived: true });
    ledger.append({ ...marked, from: STALE, to: 'Work', as: 'tip' });

    expect(project(ledger.read()).retitled.get('local_card-1')).toMatchObject({
      to: 'Work',
      toArchived: true,
    });
  });
});

/**
 * A name given to a Desktop installation other than the default. The fold
 * keeps only the latest root for a name — re-registering is the rename — and
 * forgetting removes the name from state without touching the log line that
 * created it.
 */
describe('profile_registered / profile_forgotten', () => {
  it('is read back as an event', () => {
    const ledger = makeLedger();
    ledger.append({ kind: 'profile_registered', name: 'work', root: 'D:\\Claude-Work' });

    expect(ledger.read()[0]).toMatchObject({
      kind: 'profile_registered',
      name: 'work',
      root: 'D:\\Claude-Work',
    });
  });

  it('folds to a name naming a root', () => {
    const ledger = makeLedger();
    ledger.append({ kind: 'profile_registered', name: 'work', root: 'D:\\Claude-Work' });

    expect(project(ledger.read()).profiles.get('work')).toBe('D:\\Claude-Work');
  });

  it('treats re-registering a name with a new root as the rename', () => {
    const ledger = makeLedger();
    ledger.append({ kind: 'profile_registered', name: 'work', root: 'D:\\Claude-Work' });
    ledger.append({ kind: 'profile_registered', name: 'work', root: 'D:\\Claude-Work-2' });

    const profiles = project(ledger.read()).profiles;
    expect(profiles.get('work')).toBe('D:\\Claude-Work-2');
    expect(profiles.size).toBe(1);
  });

  it('forgets a name without erasing the registration from the log', () => {
    const ledger = makeLedger();
    ledger.append({ kind: 'profile_registered', name: 'work', root: 'D:\\Claude-Work' });
    ledger.append({ kind: 'profile_forgotten', name: 'work' });

    expect(project(ledger.read()).profiles.has('work')).toBe(false);
    expect(ledger.read().map((e) => e.kind)).toEqual(['profile_registered', 'profile_forgotten']);
  });
});

/**
 * A filesystem root registered as somewhere `foster` looks for CLI client
 * config directories — a single client, or a container of several.
 */
describe('client_root_registered / client_root_forgotten', () => {
  it('is read back as an event', () => {
    const ledger = makeLedger();
    ledger.append({
      kind: 'client_root_registered',
      root: 'C:\\home\\.claude-contas',
      as: 'container',
    });

    expect(ledger.read()[0]).toMatchObject({
      kind: 'client_root_registered',
      root: 'C:\\home\\.claude-contas',
      as: 'container',
    });
  });

  it('folds to a root naming what kind it is', () => {
    const ledger = makeLedger();
    ledger.append({
      kind: 'client_root_registered',
      root: 'C:\\home\\.claude-contas',
      as: 'container',
    });

    expect(project(ledger.read()).clientRoots.get('C:\\home\\.claude-contas')).toBe('container');
  });

  it('re-registering the same root with a different kind replaces it', () => {
    const ledger = makeLedger();
    ledger.append({ kind: 'client_root_registered', root: 'C:\\home\\work', as: 'container' });
    ledger.append({ kind: 'client_root_registered', root: 'C:\\home\\work', as: 'client' });

    expect(project(ledger.read()).clientRoots.get('C:\\home\\work')).toBe('client');
  });

  it('forgets a root without erasing the registration from the log', () => {
    const ledger = makeLedger();
    ledger.append({ kind: 'client_root_registered', root: 'C:\\home\\work', as: 'client' });
    ledger.append({ kind: 'client_root_forgotten', root: 'C:\\home\\work' });

    expect(project(ledger.read()).clientRoots.has('C:\\home\\work')).toBe(false);
    expect(ledger.read().map((e) => e.kind)).toEqual([
      'client_root_registered',
      'client_root_forgotten',
    ]);
  });
});
