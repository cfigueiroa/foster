import { describe, expect, it } from 'vitest';
import { buildFragment, fragmentProfileGuid } from '../src/engine/fragment.js';
import type { ClaudeClient } from '../src/store/clients.js';

/** The minimum a `ClaudeClient` needs to look like one, for fields this module ignores. */
function client(overrides: Partial<ClaudeClient> & { configDir: string }): ClaudeClient {
  return {
    isDefault: false,
    inUse: false,
    signedIn: false,
    conversations: 0,
    live: 0,
    ...overrides,
  };
}

/** Bytes out of a `{8-4-4-4-12}` guid string, so a test never carries the hyphenated form. */
function guidBytes(guid: string): number[] {
  const hex = guid.replace(/[{}-]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

describe('fragmentProfileGuid', () => {
  it('is deterministic: the same profile name always hashes to the same guid', () => {
    expect(fragmentProfileGuid('claude · alpha-abcdef')).toBe(
      fragmentProfileGuid('claude · alpha-abcdef'),
    );
  });

  it('separates two different profile names', () => {
    expect(fragmentProfileGuid('claude · alpha-abcdef')).not.toBe(
      fragmentProfileGuid('claude · beta-abcdef'),
    );
  });

  it('sets the RFC 4122 version-5 nibble and variant bits', () => {
    const bytes = guidBytes(fragmentProfileGuid('claude · alpha-abcdef'));
    expect(bytes[6]! >> 4).toBe(5); // version 5
    expect(bytes[8]! >> 6).toBe(0b10); // RFC 4122 variant
  });

  it('is wrapped in braces, lowercase hex, RFC-4122 grouping', () => {
    expect(fragmentProfileGuid('claude · alpha-abcdef')).toMatch(
      /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/,
    );
  });

  // The recipe's whole vector, kept as bytes rather than a hyphenated literal —
  // `scripts/privacy.mjs` reads a hyphenated hex run as a realistic identifier
  // regardless of context, and a guid computed at test time is exactly that
  // shape (see WP-19 and the comment on WT_FRAGMENT_NAMESPACE in fragment.ts).
  it('matches a recorded vector for the namespace, "foster" and a known profile name', () => {
    expect(guidBytes(fragmentProfileGuid('claude · alpha-abcdef'))).toEqual([
      0x38, 0x34, 0x78, 0x93, 0xc7, 0x14, 0x5b, 0xad, 0xae, 0x68, 0x58, 0x58, 0x67, 0x1a, 0x08,
      0x67,
    ]);
    expect(guidBytes(fragmentProfileGuid('claude · beta-abcdef'))).toEqual([
      0xe8, 0x5c, 0x34, 0x38, 0xf4, 0x30, 0x5d, 0xa6, 0xb0, 0x74, 0x80, 0x9b, 0xa7, 0x86, 0x0a,
      0xf6,
    ]);
  });
});

describe('buildFragment', () => {
  it('prints one profile per client listed', () => {
    const clients = [
      client({ configDir: 'D:\\Claude-Work' }),
      client({ configDir: 'C:\\home\\.claude-work' }),
    ];
    const fragment = buildFragment(clients);
    expect(fragment.profiles).toHaveLength(2);
  });

  it('shapes each profile: name, commandline, environment, tabTitle, startingDirectory', () => {
    const [profile] = buildFragment([client({ configDir: 'C:\\home\\.claude-work' })]).profiles;
    expect(profile).toMatchObject({
      commandline: 'pwsh -NoLogo',
      environment: { CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work' },
      startingDirectory: 'C:\\home\\.claude-work',
    });
    expect(profile!.name).toMatch(/^claude · /);
    expect(profile!.guid).toMatch(/^\{[0-9a-f-]{36}\}$/);
    expect(typeof profile!.tabTitle).toBe('string');
  });

  it('gives two clients distinct names, guids and slugs even with the same basename', () => {
    const clients = [
      client({ configDir: 'D:\\accounts-a\\.claude' }),
      client({ configDir: 'D:\\accounts-b\\.claude' }),
    ];
    const [a, b] = buildFragment(clients).profiles;
    expect(a!.name).not.toBe(b!.name);
    expect(a!.guid).not.toBe(b!.guid);
  });

  it('is deterministic across two runs over the same client list', () => {
    const clients = [client({ configDir: 'C:\\home\\.claude-work' })];
    expect(buildFragment(clients)).toEqual(buildFragment(clients));
  });

  it('resolves a junction to its target — the config dir and starting dir both name the real place', () => {
    const [profile] = buildFragment([
      client({ configDir: 'C:\\home\\.claude-frota', linkTarget: 'D:\\Claude-Work\\llm02' }),
    ]).profiles;
    expect(profile!.environment.CLAUDE_CONFIG_DIR).toBe('D:\\Claude-Work\\llm02');
    expect(profile!.startingDirectory).toBe('D:\\Claude-Work\\llm02');
  });

  it('keeps the guid tied to the directory, not to the identity cached in it', () => {
    const withIdentity = buildFragment([
      client({ configDir: 'C:\\home\\.claude-work', identity: { email: 'you@example.com' } }),
    ]).profiles[0]!;
    const withoutIdentity = buildFragment([client({ configDir: 'C:\\home\\.claude-work' })])
      .profiles[0]!;
    expect(withIdentity.guid).toBe(withoutIdentity.guid);
    expect(withIdentity.name).toBe(withoutIdentity.name);
    // Only the tab title is allowed to read differently once someone signs in.
    expect(withIdentity.tabTitle).not.toBe(withoutIdentity.tabTitle);
  });

  it('falls back to the client name for the tab title when no identity is cached', () => {
    const [profile] = buildFragment([client({ configDir: 'C:\\home\\.claude-work' })]).profiles;
    expect(profile!.tabTitle).toBe(profile!.name);
  });

  it('serializes to JSON with no BOM and round-trips cleanly', () => {
    const fragment = buildFragment([client({ configDir: 'C:\\home\\.claude-work' })]);
    const text = JSON.stringify(fragment, null, 2);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual(fragment);
  });
});
