import { describe, expect, it } from 'vitest';
import { forLedger, type AccountProfile } from '../src/domain/profile.js';

const ACCOUNT = '00000000-0000-4000-8000-0000000000ac';

describe('forLedger', () => {
  it('drops the card, keeping every other field the identity screens use', () => {
    const profile: AccountProfile = {
      accountUuid: ACCOUNT,
      email: 'john@example.com',
      subscriptionStatus: 'active',
      rateLimitTier: 'default_claude_max_20x',
      nextChargeDate: '2027-01-26',
      cardBrand: 'visa',
      cardLast4: '4242',
    };

    expect(forLedger(profile)).toEqual({
      accountUuid: ACCOUNT,
      email: 'john@example.com',
      subscriptionStatus: 'active',
      rateLimitTier: 'default_claude_max_20x',
      nextChargeDate: '2027-01-26',
    });
  });

  it('is a no-op when there was no card to begin with', () => {
    const profile: AccountProfile = { accountUuid: ACCOUNT, subscriptionStatus: 'active' };
    expect(forLedger(profile)).toEqual(profile);
  });

  it('does not mutate the profile it was handed', () => {
    const profile: AccountProfile = { accountUuid: ACCOUNT, cardBrand: 'visa', cardLast4: '4242' };
    forLedger(profile);
    expect(profile.cardBrand).toBe('visa');
    expect(profile.cardLast4).toBe('4242');
  });
});
