import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { overviewAccounts, freshIdentityOf } from '../src/store/accounts.js';
import { Ledger } from '../src/ledger/log.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';
import { renderAccount } from '../src/cli/render.js';

let store: StoreLayout;
let ledger: Ledger;

function makeLedger(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-ledger-')), 'ledger.jsonl'));
}

/** Creates the account/organization directories the app would create. */
function accountDir(accountUuid: string, organizationUuid: string) {
  mkdirSync(path.join(store.codeSessionsDir, accountUuid, organizationUuid), { recursive: true });
}

function signedInAs(accountUuid: string) {
  writeFileSync(store.configFile, JSON.stringify({ lastKnownAccountUuid: accountUuid }), 'utf8');
}

function cachedProfile(accountUuid: string, organization: Record<string, unknown> = {}) {
  const dir = path.join(store.root, 'Cache', 'Cache_Data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `f_${accountUuid.slice(0, 6)}`),
    gzipSync(
      JSON.stringify({
        account: { uuid: accountUuid, full_name: 'John', email: 'john@example.com' },
        organization: {
          rate_limit_tier: 'default_claude_max_20x',
          subscription_status: 'active',
          ...organization,
        },
      }),
    ),
  );
}

beforeEach(() => {
  store = makeStore();
  ledger = makeLedger();
});

describe('overviewAccounts', () => {
  it('reads the account in use fresh, from its own profile', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);
    cachedProfile(OLD_ACCOUNT.accountUuid);

    const [row] = overviewAccounts(store, ledger);
    expect(row).toMatchObject({ accountUuid: OLD_ACCOUNT.accountUuid, isCurrent: true });
    expect(row!.identity?.plan).toBe('Max 20x');
    expect(row!.identity?.profile?.subscriptionStatus).toBe('active');
    expect(row!.remembered).toBe(false);
  });

  it('does not answer for another account out of the current account’s profile', () => {
    // The response cache describes one session. Handing its answer to a second
    // account would be worse than saying nothing: every account would read as
    // the same person, and the screen exists precisely to tell them apart.
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    accountDir(NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);
    cachedProfile(OLD_ACCOUNT.accountUuid);

    const rows = overviewAccounts(store, ledger);
    const other = rows.find((row) => row.accountUuid === NEW_ACCOUNT.accountUuid);
    expect(other?.identity).toBeUndefined();
  });

  it('describes an account it is not signed into from what it recorded', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    accountDir(NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);
    ledger.append({
      kind: 'account_identity_seen',
      accountUuid: NEW_ACCOUNT.accountUuid,
      email: 'other@example.com',
      plan: 'Max 5x',
      profile: {
        accountUuid: NEW_ACCOUNT.accountUuid,
        subscriptionStatus: 'active',
        planEndingAt: '2026-09-08',
      },
      ts: 1_700_000_000_000,
    });

    const other = overviewAccounts(store, ledger).find(
      (row) => row.accountUuid === NEW_ACCOUNT.accountUuid,
    );
    expect(other?.identity?.plan).toBe('Max 5x');
    expect(other?.identity?.profile?.planEndingAt).toBe('2026-09-08');
    expect(other?.remembered).toBe(true);
    expect(other?.seenAt).toBe(1_700_000_000_000);
  });

  it('counts sessions and copies per account', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    const [row] = overviewAccounts(store, ledger);
    expect(row).toMatchObject({ sessions: 0, copies: 0, agentOnly: false });
    expect(row!.organizationUuids).toEqual([OLD_ACCOUNT.organizationUuid]);
  });

  it('includes an account that only has a Cowork tree', () => {
    // Cowork creates the tree before any Code session exists, so leaving these
    // out would hide the account someone is signed into right now.
    mkdirSync(
      path.join(store.agentSessionsDir, NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid),
      { recursive: true },
    );

    const rows = overviewAccounts(store, ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountUuid: NEW_ACCOUNT.accountUuid, agentOnly: true });
  });

  it('does not mistake a plugin directory for an account', () => {
    // `skills-plugin` sits beside the accounts in the Cowork tree with the same
    // shape. An account nobody can sign into is not an account.
    mkdirSync(path.join(store.agentSessionsDir, 'skills-plugin', 'anything'), { recursive: true });

    expect(overviewAccounts(store, ledger)).toHaveLength(0);
  });

  it('puts the account in use first', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    accountDir(NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid);
    signedInAs(NEW_ACCOUNT.accountUuid);

    expect(overviewAccounts(store, ledger)[0]?.accountUuid).toBe(NEW_ACCOUNT.accountUuid);
  });

  it('carries the label through', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    ledger.append({
      kind: 'account_labelled',
      accountUuid: OLD_ACCOUNT.accountUuid,
      label: 'work',
    });

    expect(overviewAccounts(store, ledger)[0]?.label).toBe('work');
  });
});

describe('freshIdentityOf', () => {
  it('finds the current account when its profile was read fresh', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);
    cachedProfile(OLD_ACCOUNT.accountUuid);

    expect(freshIdentityOf(overviewAccounts(store, ledger))?.accountUuid).toBe(
      OLD_ACCOUNT.accountUuid,
    );
  });

  it('finds nothing to record when the cache said nothing', () => {
    accountDir(OLD_ACCOUNT.accountUuid, OLD_ACCOUNT.organizationUuid);
    signedInAs(OLD_ACCOUNT.accountUuid);

    expect(freshIdentityOf(overviewAccounts(store, ledger))).toBeUndefined();
  });
});

describe('renderAccount', () => {
  it('dates the subscription on its own line when it was only remembered', () => {
    // The flaw this fixes: a plan cancelled after the last visit still reads
    // "active" here, and a footnote under the block did not stop that being
    // taken at face value. The claim carries its date now.
    const lines = renderAccount({
      accountUuid: OLD_ACCOUNT.accountUuid,
      organizationUuids: [OLD_ACCOUNT.organizationUuid],
      isCurrent: false,
      sessions: 0,
      copies: 0,
      agentOnly: false,
      identity: {
        plan: 'Pro',
        profile: {
          accountUuid: OLD_ACCOUNT.accountUuid,
          subscriptionStatus: 'active',
          nextChargeDate: '2027-01-26',
          cardLast4: '8684',
        },
        remembered: true,
      },
      remembered: true,
      seenAt: Date.parse('2026-06-12T00:00:00Z'),
    });

    const dated = lines.filter((line) => line.includes('as of 2026-06-12'));
    expect(dated).toHaveLength(4); // plan, subscription, next charge, card
    expect(lines.join('\n')).toContain('--forget');
  });

  it('leaves the fresh account undated', () => {
    const lines = renderAccount({
      accountUuid: OLD_ACCOUNT.accountUuid,
      organizationUuids: [OLD_ACCOUNT.organizationUuid],
      isCurrent: true,
      sessions: 1,
      copies: 0,
      agentOnly: false,
      identity: {
        plan: 'Max 20x',
        profile: { accountUuid: OLD_ACCOUNT.accountUuid, subscriptionStatus: 'active' },
      },
      remembered: false,
    });

    expect(lines.join('\n')).not.toContain('as of');
  });
});
