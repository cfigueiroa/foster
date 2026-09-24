import { createCipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decryptOsCrypt, pickToken, redactOAuthToken } from '../src/store/credential.js';

/** Builds a Chromium `v10` blob the way the app stores one, for a round-trip. */
function sealV10(plaintext: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]);
}

describe('decryptOsCrypt', () => {
  const key = randomBytes(32);

  it('round-trips a v10 blob', () => {
    const blob = sealV10('{"hello":"world"}', key);
    expect(decryptOsCrypt(blob, key)).toBe('{"hello":"world"}');
  });

  it('rejects a blob that is not v10/v11', () => {
    expect(() => decryptOsCrypt(Buffer.from('nope-not-a-blob-at-all-really'), key)).toThrow();
  });

  it('fails loudly on the wrong key rather than returning rubbish', () => {
    // The whole reason to prefer decryption over the byte search: a wrong key is
    // an authentication-tag failure, never a plausible-looking wrong answer.
    const blob = sealV10('{"token":"secret"}', key);
    expect(() => decryptOsCrypt(blob, randomBytes(32))).toThrow();
  });
});

describe('pickToken', () => {
  // Synthetic client and org ids: the key layout is `clientId:orgUuid:audience:scopes`,
  // and the test only needs the scope substring and the org to be readable back.
  const CLIENT_INFERENCE = '00000000-0000-4000-8000-0000000000a1';
  const CLIENT_PROFILE = '00000000-0000-4000-8000-0000000000a2';
  const ORG = '00000000-0000-4000-8000-0000000000c1';
  const inference = `${CLIENT_INFERENCE}:${ORG}:https://api.anthropic.com:user:inference user:profile`;
  const profileOnly = `${CLIENT_PROFILE}:${ORG}:https://api.anthropic.com:user:profile`;

  it('prefers the inference-scoped entry, and reads the org from the key', () => {
    const chosen = pickToken({
      [profileOnly]: { token: 'narrow', subscriptionType: 'max' },
      [inference]: { token: 'broad', rateLimitTier: 'default_claude_max_20x', expiresAt: 123 },
    });

    expect(chosen).toEqual({
      token: 'broad',
      organizationUuid: ORG,
      rateLimitTier: 'default_claude_max_20x',
      expiresAt: 123,
    });
  });

  it('falls back to any entry that carries a token', () => {
    expect(pickToken({ [profileOnly]: { token: 'narrow' } })?.token).toBe('narrow');
  });

  it('is undefined when no entry has a token', () => {
    expect(pickToken({ [profileOnly]: { refreshToken: 'r' } })).toBeUndefined();
    expect(pickToken({})).toBeUndefined();
  });

  it('never prints the bearer token via JSON.stringify or console.log/util.inspect', () => {
    const token = pickToken({ [profileOnly]: { token: 'super-secret-bearer' } });
    expect(token).toBeDefined();

    expect(JSON.stringify(token)).toBe('"[credential]"');
    expect(JSON.stringify({ auth: token })).toBe('{"auth":"[credential]"}');
    expect(inspect(token)).toBe('[credential]');
    expect(inspect(token)).not.toContain('super-secret-bearer');
  });
});

describe('redactOAuthToken', () => {
  it('makes a bare token object refuse to serialise, without hiding its own fields', () => {
    const token = redactOAuthToken({ token: 'bearer-xyz', organizationUuid: 'org-1' });

    expect(token.token).toBe('bearer-xyz');
    expect(token.organizationUuid).toBe('org-1');
    expect(JSON.stringify(token)).toBe('"[credential]"');
    expect(inspect(token)).toBe('[credential]');
    expect(inspect(token)).not.toContain('bearer-xyz');
  });

  it('is defensive against a caller that never wires it up: a bare object stays a plain OAuthToken', () => {
    // The interface's toJSON/[inspect.custom] are optional precisely so this
    // compiles — a fixture like `usage.test.ts`'s AUTH constant is still a
    // valid OAuthToken without ever calling redactOAuthToken.
    const bare = { token: 'bearer-xyz' };
    expect(JSON.stringify(bare)).toBe('{"token":"bearer-xyz"}');
  });
});
