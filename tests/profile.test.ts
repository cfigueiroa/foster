import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { readProfileFromResponseCache } from '../src/store/profile.js';
import { readIdentityFromCache } from '../src/store/identity.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore } from './helpers/store.js';

const ACCOUNT = '00000000-0000-4000-8000-0000000000ac';
const ORGANIZATION = '00000000-0000-4000-8000-00000000000f';

let store: StoreLayout;

/** Writes a file into the app's HTTP cache, the way a cached body lands there. */
function cached(name: string, contents: Buffer | string) {
  const dir = path.join(store.root, 'Cache', 'Cache_Data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), contents);
}

const bootstrap = {
  account: {
    uuid: ACCOUNT,
    full_name: 'John Doe',
    display_name: 'John',
    email: 'john@example.com',
    has_claude_max: true,
    created_at: '2026-01-02T03:04:05.000000Z',
  },
  organization: {
    uuid: ORGANIZATION,
    name: "john@example.com's Organization",
    organization_type: 'claude_max',
    billing_type: 'stripe_subscription',
    rate_limit_tier: 'default_claude_max_20x',
    subscription_status: 'active',
    subscription_created_at: '2026-01-02T03:04:15.000000Z',
    has_extra_usage_enabled: false,
  },
};

beforeEach(() => {
  store = makeStore();
});

describe('readProfileFromResponseCache', () => {
  it('reads the whole profile from a gzipped response body', () => {
    cached('f_000001', gzipSync(JSON.stringify(bootstrap)));

    expect(readProfileFromResponseCache(store, ACCOUNT)).toMatchObject({
      accountUuid: ACCOUNT,
      email: 'john@example.com',
      name: 'John Doe',
      displayName: 'John',
      organizationUuid: ORGANIZATION,
      organizationType: 'claude_max',
      rateLimitTier: 'default_claude_max_20x',
      subscriptionStatus: 'active',
      hasExtraUsage: false,
    });
  });

  it('finds a body stored partway into a block file', () => {
    // The case that matters on a real machine: the cache packs several entries
    // into one file, so the gzip member does not begin at byte zero and
    // decompressing from the start finds nothing at all.
    cached('data_1', Buffer.concat([Buffer.alloc(4096, 7), gzipSync(JSON.stringify(bootstrap))]));

    expect(readProfileFromResponseCache(store, ACCOUNT)?.email).toBe('john@example.com');
  });

  it('reads a brotli body', () => {
    cached('f_000002', brotliCompressSync(JSON.stringify(bootstrap)));

    expect(readProfileFromResponseCache(store, ACCOUNT)?.name).toBe('John Doe');
  });

  it('reads an uncompressed body', () => {
    cached('f_000003', JSON.stringify(bootstrap));

    expect(readProfileFromResponseCache(store, ACCOUNT)?.name).toBe('John Doe');
  });

  it('ignores a profile belonging to a different account', () => {
    // The account object names itself, so this is a comparison rather than a
    // guess — which is the whole reason this source is preferred.
    cached('f_000004', gzipSync(JSON.stringify(bootstrap)));

    expect(readProfileFromResponseCache(store, '11111111-1111-4111-8111-111111111111')).toBe(
      undefined,
    );
  });

  it('merges the billing answer when the cache kept one', () => {
    cached('f_000005', gzipSync(JSON.stringify(bootstrap)));
    cached(
      'f_000006',
      gzipSync(
        JSON.stringify({
          status: 'active',
          next_charge_date: '2026-09-08',
          plan_ending_at: null,
          billing_interval: 'monthly',
          currency: 'BRL',
          payment_method: { brand: 'mastercard', last4: '2009', type: 'card' },
        }),
      ),
    );

    expect(readProfileFromResponseCache(store, ACCOUNT)).toMatchObject({
      nextChargeDate: '2026-09-08',
      billingInterval: 'monthly',
      currency: 'BRL',
      cardBrand: 'mastercard',
      cardLast4: '2009',
    });
  });

  it('reports a plan that is set to end, which "active" alone would hide', () => {
    // A cancelled subscription stays "active" until the period closes. The end
    // date is the only thing that tells the two apart, and it is the answer
    // someone asking "is this still being paid for" actually wants.
    cached('f_000007', gzipSync(JSON.stringify(bootstrap)));
    cached(
      'f_000008',
      gzipSync(
        JSON.stringify({ status: 'active', next_charge_date: null, plan_ending_at: '2026-09-08' }),
      ),
    );

    expect(readProfileFromResponseCache(store, ACCOUNT)?.planEndingAt).toBe('2026-09-08');
  });

  it('is undefined when the cache holds nothing about this account', () => {
    cached('f_000009', gzipSync('<html>not a profile</html>'));

    expect(readProfileFromResponseCache(store, ACCOUNT)).toBeUndefined();
    expect(readProfileFromResponseCache(store, undefined)).toBeUndefined();
  });

  it('survives a file that is not compressed the way it looks', () => {
    // The gzip magic occurs in ordinary bytes; a wrong guess must be skipped
    // rather than thrown, because the search across the rest is what matters.
    cached('f_00000a', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x11, 0x22, 0x33]));
    cached('f_00000b', gzipSync(JSON.stringify(bootstrap)));

    expect(readProfileFromResponseCache(store, ACCOUNT)?.email).toBe('john@example.com');
  });
});

describe('readIdentityFromCache with a response cache', () => {
  it('prefers the profile, and names the size of the plan', () => {
    cached('f_00000c', gzipSync(JSON.stringify(bootstrap)));

    const identity = readIdentityFromCache(store, ACCOUNT);
    expect(identity?.email).toBe('john@example.com');
    expect(identity?.name).toBe('John Doe');
    expect(identity?.plan).toBe('Max 20x');
    expect(identity?.profile?.subscriptionStatus).toBe('active');
  });
});
