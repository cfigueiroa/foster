import { describe, expect, it } from 'vitest';
import { abbreviate, accountTree, formatAge, groupByAccount } from '../src/cli/render.js';

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

describe('abbreviate', () => {
  it('keeps eight characters when that is already unambiguous', () => {
    const names = abbreviate([ACCOUNT_A, ACCOUNT_B]);
    expect(names.get(ACCOUNT_A)).toBe('00000000');
    expect(names.get(ACCOUNT_B)).toBe('11111111');
  });

  it('lengthens only as far as it must to stay distinct', () => {
    // These differ at the very last character.
    const names = abbreviate([ORG_1, ORG_2]);
    expect(names.get(ORG_1)).not.toBe(names.get(ORG_2));
    expect(names.get(ORG_1)).toBe(ORG_1);
  });

  it('does not choke on a single identifier', () => {
    expect(abbreviate([ORG_1]).get(ORG_1)).toBe('00000000');
  });
});

describe('the tree with colliding identifiers', () => {
  it('never prints the same name for two different organizations', () => {
    const tree = plain(
      accountTree(groupByAccount([row(ACCOUNT_A, ORG_1, 1), row(ACCOUNT_A, ORG_2, 1)])),
    );
    const shown = [...tree.matchAll(/org (\S+)/g)].map((match) => match[1]);

    expect(shown).toHaveLength(2);
    expect(new Set(shown).size).toBe(2);
  });

  it('leaves the account short when only the organizations collide', () => {
    const tree = plain(
      accountTree(groupByAccount([row(ACCOUNT_A, ORG_1, 1), row(ACCOUNT_A, ORG_2, 1)])),
    );
    expect(tree.split('\n')[0]).toContain('00000000  ');
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');

  it('says when there is nothing to go on', () => {
    expect(formatAge(undefined, now)).toBe('never used');
  });

  it('reads in the units a person would use', () => {
    expect(formatAge(now, now)).toBe('today');
    expect(formatAge(now - 86_400_000, now)).toBe('yesterday');
    expect(formatAge(now - 5 * 86_400_000, now)).toBe('5 days ago');
    expect(formatAge(now - 90 * 86_400_000, now)).toBe('3 months ago');
    expect(formatAge(now - 800 * 86_400_000, now)).toBe('2 years ago');
  });

  it('does not report the future as a very long time ago', () => {
    expect(formatAge(now + 86_400_000, now)).toBe('just now');
  });
});
