import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptOsCrypt, pickToken } from '../src/store/credential.js';

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
  const inference =
    '9d1c250a:c1efc3c9-0067-4056-94e5-77ad1aa20ab2:https://api.anthropic.com:user:inference user:profile';
  const profileOnly =
    'a473d7bb:c1efc3c9-0067-4056-94e5-77ad1aa20ab2:https://api.anthropic.com:user:profile';

  it('prefers the inference-scoped entry, and reads the org from the key', () => {
    const chosen = pickToken({
      [profileOnly]: { token: 'narrow', subscriptionType: 'max' },
      [inference]: { token: 'broad', rateLimitTier: 'default_claude_max_20x', expiresAt: 123 },
    });

    expect(chosen).toEqual({
      token: 'broad',
      organizationUuid: 'c1efc3c9-0067-4056-94e5-77ad1aa20ab2',
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
});
