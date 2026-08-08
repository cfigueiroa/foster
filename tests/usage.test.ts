import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLiveProfile, fetchLiveUsage } from '../src/engine/anthropicApi.js';
import { renderRenewals, renderUsage } from '../src/cli/render.js';
import type { OAuthToken } from '../src/store/credential.js';
import type { AccountOverview } from '../src/store/accounts.js';

const AUTH: OAuthToken = { token: 'test-token' };

/** Stubs global fetch with one canned JSON response, and records the request. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchLiveUsage', () => {
  const usageBody = {
    five_hour: { utilization: 58, resets_at: '2026-08-08T21:50:00Z' },
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 58,
        severity: 'normal',
        resets_at: '2026-08-08T21:50:00Z',
        scope: null,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 10,
        severity: 'normal',
        resets_at: '2026-08-14T07:00:00Z',
        scope: null,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 7,
        severity: 'normal',
        resets_at: '2026-08-14T07:00:00Z',
        scope: { model: { id: null, display_name: 'Fable' } },
      },
    ],
    extra_usage: { is_enabled: false },
  };

  it('maps the limits array into labelled windows', async () => {
    stubFetch(200, usageBody);
    const report = await fetchLiveUsage(AUTH, 1000);

    expect(report?.windows).toEqual([
      {
        label: '5-hour session',
        percent: 58,
        severity: 'normal',
        resetsAt: '2026-08-08T21:50:00Z',
      },
      {
        label: 'Weekly · all models',
        percent: 10,
        severity: 'normal',
        resetsAt: '2026-08-14T07:00:00Z',
      },
      {
        label: 'Weekly · Fable',
        percent: 7,
        severity: 'normal',
        resetsAt: '2026-08-14T07:00:00Z',
        model: 'Fable',
      },
    ]);
    expect(report?.extraUsageEnabled).toBe(false);
    expect(report?.retrievedAt).toBe(1000);
  });

  it('sends the bearer token and the oauth beta header', async () => {
    const calls = stubFetch(200, usageBody);
    await fetchLiveUsage(AUTH, 1000);

    expect(calls[0]!.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(calls[0]!.headers.Authorization).toBe('Bearer test-token');
    expect(calls[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('returns undefined on a non-2xx answer', async () => {
    stubFetch(403, { error: 'challenge' });
    expect(await fetchLiveUsage(AUTH, 1000)).toBeUndefined();
  });

  it('does not call the network with an expired token', async () => {
    const calls = stubFetch(200, usageBody);
    const expired: OAuthToken = { token: 't', expiresAt: 1 }; // 1s epoch, long past
    expect(await fetchLiveUsage(expired, 2_000_000)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('fetchLiveProfile', () => {
  it('maps the account and organization', async () => {
    stubFetch(200, {
      account: { uuid: 'acc', full_name: 'Chefe', email: 'x@example.com' },
      organization: {
        uuid: 'org',
        organization_type: 'claude_max',
        rate_limit_tier: 'default_claude_max_20x',
        subscription_status: 'active',
        has_extra_usage_enabled: false,
      },
    });

    expect(await fetchLiveProfile(AUTH, 1000)).toEqual({
      accountUuid: 'acc',
      name: 'Chefe',
      email: 'x@example.com',
      organizationUuid: 'org',
      organizationType: 'claude_max',
      rateLimitTier: 'default_claude_max_20x',
      subscriptionStatus: 'active',
      hasExtraUsage: false,
    });
  });
});

describe('renderUsage', () => {
  it('draws a bar, the percent and a relative reset', () => {
    const now = Date.parse('2026-08-08T20:34:00Z');
    const lines = renderUsage(
      {
        windows: [
          {
            label: '5-hour session',
            percent: 58,
            severity: 'normal',
            resetsAt: '2026-08-08T21:50:00Z',
          },
        ],
        extraUsageEnabled: false,
        retrievedAt: now,
      },
      now,
    );

    const joined = lines.join('\n');
    expect(joined).toContain('5-hour session');
    expect(joined).toContain('58%');
    expect(joined).toContain('resets in');
    expect(joined).toContain('read live');
  });

  it('flags an exceeded window', () => {
    const now = Date.parse('2026-08-08T20:00:00Z');
    const lines = renderUsage(
      {
        windows: [{ label: 'Weekly · Fable', percent: 101, severity: 'exceeded_limit' }],
        extraUsageEnabled: false,
        retrievedAt: now,
      },
      now,
    );
    expect(lines.join('\n')).toContain('101%');
  });
});

describe('renderRenewals', () => {
  const now = Date.parse('2026-08-08T20:34:00Z');

  const current: AccountOverview = {
    accountUuid: '00000000-0000-4000-8000-0000000000ac',
    organizationUuids: ['org'],
    isCurrent: true,
    sessions: 1,
    copies: 0,
    agentOnly: false,
    identity: { profile: { accountUuid: 'x', subscriptionStatus: 'active' } },
    remembered: false,
  };

  const remembered: AccountOverview = {
    accountUuid: '00000000-0000-4000-8000-0000000000bd',
    organizationUuids: ['org2'],
    label: 'Caio',
    isCurrent: false,
    sessions: 0,
    copies: 0,
    agentOnly: false,
    identity: {
      profile: {
        accountUuid: 'y',
        subscriptionStatus: 'active',
        nextChargeDate: '2027-01-26',
        billingInterval: 'yearly',
      },
    },
    remembered: true,
    seenAt: Date.parse('2026-06-12T00:00:00Z'),
  };

  it('shows live resets for the current account and dated billing for the rest', () => {
    const usage = {
      windows: [
        { label: '5-hour session', percent: 58, resetsAt: '2026-08-08T21:50:00Z' },
        { label: 'Weekly · Fable', percent: 7, resetsAt: '2026-08-14T07:00:00Z' },
      ],
      extraUsageEnabled: false,
      retrievedAt: now,
    };
    const out = renderRenewals([current, remembered], usage, now).join('\n');

    expect(out).toContain('5-hour session');
    expect(out).toContain('[live]');
    expect(out).toContain('next charge');
    expect(out).toContain('2027-01-26');
    expect(out).toContain('as of 2026-06-12');
    // The current account's billing date is not reachable via the API.
    expect(out).toContain('not readable here');
  });

  it('marks a cancelling plan by its end date', () => {
    const ending: AccountOverview = {
      ...remembered,
      identity: {
        profile: { accountUuid: 'y', subscriptionStatus: 'active', planEndingAt: '2026-09-08' },
      },
    };
    expect(renderRenewals([ending], undefined, now).join('\n')).toContain('will not renew');
  });

  it('says so when nothing time-related is known', () => {
    const bare: AccountOverview = {
      accountUuid: '00000000-0000-4000-8000-0000000000ce',
      organizationUuids: ['o'],
      isCurrent: false,
      sessions: 3,
      copies: 0,
      agentOnly: false,
      remembered: false,
    };
    expect(renderRenewals([bare], undefined, now).join('\n')).toContain(
      'No renewal or reset dates',
    );
  });
});
