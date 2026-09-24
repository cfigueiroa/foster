import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCloudAuth } from '../src/store/cloudAuth.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const ACCOUNT = '00000000-0000-4000-8000-00000000000b';

function writeCredential(dir: string, oauth: Record<string, unknown> | undefined): void {
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify(oauth === undefined ? {} : { claudeAiOauth: oauth }),
    'utf8',
  );
}

function writeConfig(file: string, oauthAccount: Record<string, unknown> | undefined): void {
  writeFileSync(file, JSON.stringify(oauthAccount === undefined ? {} : { oauthAccount }), 'utf8');
}

describe('readCloudAuth', () => {
  it('reads the access token and the cached organization for a non-default client', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-cloudauth-'));
    writeCredential(configDir, { accessToken: 'tok', expiresAt: Date.now() + 60_000 });
    writeConfig(path.join(configDir, '.claude.json'), {
      organizationUuid: ORG,
      accountUuid: ACCOUNT,
    });

    const result = readCloudAuth(configDir, false, tmpdir());
    expect(result).toEqual({
      ok: true,
      auth: { accessToken: 'tok', organizationUuid: ORG, accountUuid: ACCOUNT },
    });
  });

  it('reads the default client from ~/.claude.json rather than the config dir copy', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'foster-cloudauth-home-'));
    const configDir = path.join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeConfig(path.join(home, '.claude.json'), { organizationUuid: ORG });
    writeCredential(configDir, { accessToken: 'tok', expiresAt: Date.now() + 60_000 });

    const result = readCloudAuth(configDir, true, home);
    expect(result).toEqual({ ok: true, auth: { accessToken: 'tok', organizationUuid: ORG } });
  });

  it('refuses a directory with no credential at all', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-cloudauth-'));
    expect(readCloudAuth(configDir, false, tmpdir())).toEqual({ ok: false, reason: 'signed-out' });
  });

  it('refuses an expired access token without trying to renew it', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-cloudauth-'));
    writeCredential(configDir, { accessToken: 'tok', expiresAt: Date.now() - 1000 });
    writeConfig(path.join(configDir, '.claude.json'), { organizationUuid: ORG });

    expect(readCloudAuth(configDir, false, tmpdir())).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a signed-in client with no cached organization', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-cloudauth-'));
    writeCredential(configDir, { accessToken: 'tok', expiresAt: Date.now() + 60_000 });
    // No .claude.json at all — never asked the API who it is yet.
    expect(readCloudAuth(configDir, false, tmpdir())).toEqual({
      ok: false,
      reason: 'no-organization',
    });
  });
});
