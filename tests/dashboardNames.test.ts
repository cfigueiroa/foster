import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDashboard } from '../src/cli/dashboard.js';
import { Ledger } from '../src/ledger/log.js';
import type { AccountOverview } from '../src/store/accounts.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';

/**
 * The home screen names an account by its identity when no label was given, and
 * for a long time that meant the profile's display name. Two accounts on this
 * machine answer to "Caio" and one of them is called "23082026"; an address is
 * the part that cannot collide, and it is what every other screen prints.
 */

const HERS = '00000000-0000-4000-8000-00000000000a';
const store = { root: 'C:\\Store' } as StoreLayout;
const target = { accountUuid: HERS, organizationUuid: HERS } as AccountRef;

function ledger(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-dash-')), 'ledger.jsonl'));
}

function row(identity: AccountOverview['identity']): AccountOverview {
  return {
    accountUuid: HERS,
    organizationUuids: [HERS],
    isCurrent: true,
    sessions: 0,
    copies: 0,
    agentOnly: false,
    remembered: false,
    ...(identity ? { identity } : {}),
  };
}

describe('the name the home screen gives an account', () => {
  it('is the e-mail, even when the profile also carries a display name', () => {
    const dashboard = buildDashboard(store, ledger(), target, [
      row({ name: 'Her', email: 'her@x.test' }),
    ]);

    expect(dashboard.accounts[0]?.identityName).toBe('her@x.test');
  });

  it('falls back to the display name when the profile has no address', () => {
    const dashboard = buildDashboard(store, ledger(), target, [row({ name: 'Her' })]);

    expect(dashboard.accounts[0]?.identityName).toBe('Her');
  });

  it('leaves the name out entirely when nothing is known, so the uuid can stand in', () => {
    const dashboard = buildDashboard(store, ledger(), target, [row(undefined)]);

    expect(dashboard.accounts[0]?.identityName).toBeUndefined();
  });
});
