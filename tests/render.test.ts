import { describe, expect, it } from 'vitest';
import { accountTree, groupByAccount } from '../src/cli/render.js';

const ACCOUNT_A = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_B = '11111111-1111-4111-8111-1111111111b1';
const ORG_1 = '00000000-0000-4000-8000-000000000001';
const ORG_2 = '00000000-0000-4000-8000-000000000002';
const ORG_3 = '11111111-1111-4111-8111-111111111113';

const row = (
  accountUuid: string,
  organizationUuid: string,
  nativeCount: number,
  isCurrent = false,
) => ({
  account: { accountUuid, organizationUuid },
  nativeCount,
  copyCount: 0,
  isCurrent,
});

/**
 * Colour codes sit in front of the indentation, so assertions about layout have
 * to look at the text the user actually sees.
 */
// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\[[0-9;]*m/g, '');

describe('groupByAccount', () => {
  it('collapses an account that owns several organizations into one entry', () => {
    const groups = groupByAccount([
      row(ACCOUNT_A, ORG_1, 185),
      row(ACCOUNT_A, ORG_2, 134),
      row(ACCOUNT_B, ORG_3, 13, true),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.organizations).toHaveLength(2);
    expect(groups[1]!.isCurrent).toBe(true);
  });
});

describe('accountTree', () => {
  /**
   * The flat rendering this replaced read as though the account identifier were
   * an organization, and as though one account with two organizations were two
   * accounts. These assertions pin the distinction.
   */
  it('states the account total and how many organizations it spans', () => {
    const output = accountTree(
      groupByAccount([row(ACCOUNT_A, ORG_1, 185), row(ACCOUNT_A, ORG_2, 134)]),
    );

    expect(output).toContain('319 session(s) in 2 organizations');
  });

  it('nests organizations under the account rather than beside it', () => {
    const output = accountTree(
      groupByAccount([row(ACCOUNT_A, ORG_1, 185), row(ACCOUNT_A, ORG_2, 134)]),
    );
    const lines = plain(output).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toMatch(/^\s/);
    expect(lines[1]).toMatch(/^\s+├ org /);
    expect(lines[2]).toMatch(/^\s+└ org /);
  });

  it('uses the singular for an account with one organization', () => {
    const output = accountTree(groupByAccount([row(ACCOUNT_B, ORG_3, 13)]));
    expect(output).toContain('13 session(s) in 1 organization');
    expect(output).not.toContain('organizations');
  });

  it('marks the signed-in account', () => {
    const output = accountTree(groupByAccount([row(ACCOUNT_B, ORG_3, 13, true)]));
    expect(output).toContain('this account');
  });

  it('prefers a human label over the identifier when one exists', () => {
    const output = accountTree(
      groupByAccount([row(ACCOUNT_A, ORG_1, 1)]),
      new Map([[ACCOUNT_A, 'old work account']]),
    );
    expect(output).toContain('old work account');
  });
});
