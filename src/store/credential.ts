import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';

/**
 * Reading the OAuth token — the one thing foster used to refuse outright.
 *
 * For its whole life foster would not touch the credential, and every "we cannot
 * know this locally" in the rest of the tool traces back to that one rule. The
 * rule is lifted here, deliberately and narrowly: the token is read, decrypted,
 * held in memory long enough to ask the API a read-only question, and never
 * written down, logged, or sent anywhere but `api.anthropic.com`. What that buys
 * is the data no cached copy contains — the account's live usage, and a profile
 * that is current rather than whatever the app last happened to persist.
 *
 * It is still the most dangerous file foster opens, so the reading is kept to one
 * place, with the sharp edges named:
 *
 *  - The token is not in plaintext. Claude Desktop stores it the way Chromium
 *    stores a cookie: a `v10`-tagged AES-256-GCM blob, encrypted under a key that
 *    is itself sealed with Windows DPAPI and kept in `Local State`. So two
 *    unwrappings stand between the file and a usable token, and the outer one can
 *    only be done by the Windows user who sealed it — which is the point of
 *    DPAPI, and the reason this cannot lift a token off a copied profile.
 *
 *  - DPAPI has no Node binding, so the one step that must call Windows is handed
 *    to PowerShell, and *only* that step: it unwraps the key and returns nothing
 *    else. The AES-GCM decryption is done here, in Node, where it can be tested.
 *
 *  - It is Windows-only, like the rest of foster, and returns undefined rather
 *    than throwing when anything is missing — an older app that has not written
 *    the V2 cache, a profile that was copied from another machine and cannot be
 *    unsealed here, a token that has expired. A feature built on this must treat
 *    "no token" as ordinary.
 */
export interface OAuthToken {
  /** The bearer token itself. Never logged; never leaves the Authorization header. */
  token: string;
  /** The organization the token is scoped to, from its own cache key. */
  organizationUuid?: string;
  /** Seconds since the epoch when the token stops working, when the cache says. */
  expiresAt?: number;
  /** The plan as the cache names it beside the token — "max", "pro". */
  subscriptionType?: string;
  /** The raw tier beside the token — "default_claude_max_20x". */
  rateLimitTier?: string;
}

/** A single entry in the token cache, keyed by client, org, audience and scopes. */
interface TokenCacheEntry {
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * The access token for the current session, or undefined when there is none to
 * be had. Prefers the entry whose scopes include inference — the Claude Code
 * client — because that is the one with the reach to answer for the account,
 * and falls back to any entry that carries a token.
 */
export function readAccessToken(store: StoreLayout): OAuthToken | undefined {
  if (process.platform !== 'win32') return undefined;

  const config = readRawConfig(store);
  const blob = config['oauth:tokenCacheV2'] ?? config['oauth:tokenCache'];
  if (typeof blob !== 'string') return undefined;

  const aesKey = osCryptKey(store);
  if (!aesKey) return undefined;

  let plaintext: string;
  try {
    plaintext = decryptOsCrypt(Buffer.from(blob, 'base64'), aesKey);
  } catch {
    return undefined;
  }

  let cache: Record<string, TokenCacheEntry>;
  try {
    cache = JSON.parse(plaintext) as Record<string, TokenCacheEntry>;
  } catch {
    return undefined;
  }

  return pickToken(cache);
}

/**
 * The best token out of a decrypted cache.
 *
 * The cache key is `clientId:orgUuid:audience:space separated scopes`, so the
 * scopes and the organization are read from the key rather than guessed. An
 * inference scope marks the Claude Code client, whose token reaches the profile
 * and usage endpoints; anything else is a fallback so the feature still says
 * something when only a narrower client is signed in.
 */
export function pickToken(cache: Record<string, TokenCacheEntry>): OAuthToken | undefined {
  const entries = Object.entries(cache).filter(([, value]) => typeof value?.token === 'string');
  if (entries.length === 0) return undefined;

  const scored = entries
    .map(([key, value]) => ({ key, value, inference: key.includes('user:inference') }))
    .sort((a, b) => Number(b.inference) - Number(a.inference));

  const chosen = scored[0]!;
  const organizationUuid = chosen.key.split(':')[1];
  return {
    token: chosen.value.token!,
    ...(organizationUuid ? { organizationUuid } : {}),
    ...(typeof chosen.value.expiresAt === 'number' ? { expiresAt: chosen.value.expiresAt } : {}),
    ...(chosen.value.subscriptionType ? { subscriptionType: chosen.value.subscriptionType } : {}),
    ...(chosen.value.rateLimitTier ? { rateLimitTier: chosen.value.rateLimitTier } : {}),
  };
}

/**
 * Decrypt a Chromium/Electron `v10` blob with the OS-crypt AES key.
 *
 * The layout is fixed: a three-byte `v10` tag, a twelve-byte GCM nonce, the
 * ciphertext, and a sixteen-byte authentication tag at the end. The tag is what
 * makes a wrong key or a corrupted blob fail loudly here rather than return
 * plausible rubbish, which is the whole reason to prefer this over the byte
 * search — a decrypted profile is either right or an exception, never a guess.
 */
export function decryptOsCrypt(blob: Buffer, aesKey: Buffer): string {
  const tag = blob.subarray(0, 3).toString('latin1');
  if (tag !== 'v10' && tag !== 'v11') {
    throw new Error(`not an OS-crypt blob: unexpected tag ${JSON.stringify(tag)}`);
  }
  const nonce = blob.subarray(3, 15);
  const ciphertext = blob.subarray(15, blob.length - 16);
  const authTag = blob.subarray(blob.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * The AES key that OS-crypt used, unsealed from `Local State` via DPAPI.
 *
 * The key sits in `Local State` under `os_crypt.encrypted_key`, base64, behind a
 * five-byte `DPAPI` marker and then a blob only Windows can open — and only for
 * the user who sealed it. That last part is the safeguard that survives a copied
 * profile: the files can be carried to another machine, but the key cannot be
 * unsealed there, so the token cannot be read there either.
 */
function osCryptKey(store: StoreLayout): Buffer | undefined {
  let localState: { os_crypt?: { encrypted_key?: string } };
  try {
    localState = JSON.parse(readFileSync(path.join(store.root, 'Local State'), 'utf8')) as {
      os_crypt?: { encrypted_key?: string };
    };
  } catch {
    return undefined;
  }

  const encoded = localState.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string') return undefined;

  const sealed = Buffer.from(encoded, 'base64');
  if (sealed.subarray(0, 5).toString('latin1') !== 'DPAPI') return undefined;

  return dpapiUnprotect(sealed.subarray(5));
}

/**
 * Unwrap a DPAPI blob for the current user, the one step that must be Windows.
 *
 * PowerShell is spawned for exactly this and told nothing else. The blob goes in
 * through the environment rather than the command line — a command line is
 * visible to any other process listing the machine's processes, and a sealed key
 * is still worth not leaking — and the base64 of the unwrapped key comes back on
 * stdout. `powershell.exe` (the 5.1 that ships with Windows) is used rather than
 * `pwsh`, because it is always present and carries the `System.Security`
 * assembly this needs.
 */
function dpapiUnprotect(sealed: Buffer): Buffer | undefined {
  const script =
    '$b=[Convert]::FromBase64String($env:FOSTER_SEALED_KEY);' +
    'Add-Type -AssemblyName System.Security;' +
    '[Convert]::ToBase64String(' +
    "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, FOSTER_SEALED_KEY: sealed.toString('base64') },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    },
  );

  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const key = Buffer.from(result.stdout.trim(), 'base64');
  return key.length === 32 ? key : undefined;
}

/** The whole config, read raw — the one caller allowed past the whitelist in config.ts. */
function readRawConfig(store: StoreLayout): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(store.configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
