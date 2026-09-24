import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readCliCredential } from './cliCredential.js';

/**
 * The credential `foster cloud` calls the API with — read from a CLI config
 * directory exactly the way `foster clients` reads an identity, never fetched
 * or refreshed.
 *
 * Two files, both already read elsewhere in foster for other purposes:
 *
 *  - `.credentials.json` (`cliCredential.ts`) carries the bearer token.
 *  - `.claude.json` carries `oauthAccount`, the profile the CLI cached the last
 *    time it asked the API who it was signed in as — `organizationUuid` and
 *    `accountUuid` among the fields `clients.ts` already reads out of it for
 *    display. The default client keeps this file beside its directory, at
 *    `~/.claude.json`, rather than inside it (see `readClientIdentity`).
 *
 * `organizationUuid` is what `x-organization-uuid` on the teleport-events call
 * needs, measured by reading the installed CLI's own bundle: the session-list
 * and single-session calls do not send that header at all, but teleport-events
 * and its session_ingress fallback both do (`bot`/`Sot` in the 2.1.278 bundle).
 * Nothing here calls the API to learn it — the cached copy is enough, and
 * asking would be one more network round trip this module has no business
 * making on its own.
 */

/** Never printed, never logged — same discipline as `CliCredential`. */
export interface CloudAuth {
  accessToken: string;
  organizationUuid: string;
  accountUuid?: string;
}

export type CloudAuthRefusal = 'signed-out' | 'expired' | 'no-organization';

export type CloudAuthResult =
  { ok: true; auth: CloudAuth } | { ok: false; reason: CloudAuthRefusal };

/** The `oauthAccount` fields this needs, read the same candidate-file way `readClientIdentity` does. */
function readCachedOrgAccount(
  configDir: string,
  isDefault: boolean,
  home: string,
): { organizationUuid?: string; accountUuid?: string } | undefined {
  const candidates = isDefault
    ? [path.join(home, '.claude.json'), path.join(configDir, '.claude.json')]
    : [path.join(configDir, '.claude.json')];

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: unknown };
      const account = parsed.oauthAccount;
      if (typeof account !== 'object' || account === null) continue;
      const fields = account as Record<string, unknown>;
      const organizationUuid = fields.organizationUuid;
      const accountUuid = fields.accountUuid;
      if (typeof organizationUuid === 'string' && organizationUuid !== '') {
        return {
          organizationUuid,
          ...(typeof accountUuid === 'string' && accountUuid !== '' ? { accountUuid } : {}),
        };
      }
    } catch {
      // Missing, torn, or foreign — try the next candidate.
    }
  }
  return undefined;
}

/**
 * Read what a config directory can authenticate a cloud API call with.
 *
 * Never refreshes: an expired access token is refused, not renewed. Renewing
 * rotates the refresh token in `.credentials.json`, and a fleet of clients
 * sharing that renewal window is exactly the credential foster's other write
 * paths go out of their way not to disturb (see `cliCredential.ts`'s own
 * warning about a live file). The refusal names the directory so the caller
 * can print "run claude in <dir> to refresh" rather than a bare failure.
 */
export function readCloudAuth(
  configDir: string,
  isDefault: boolean,
  home: string,
): CloudAuthResult {
  const credential = readCliCredential(configDir);
  if (!credential?.accessToken) return { ok: false, reason: 'signed-out' };
  if (credential.expired()) return { ok: false, reason: 'expired' };

  const cached = readCachedOrgAccount(configDir, isDefault, home);
  if (!cached?.organizationUuid) return { ok: false, reason: 'no-organization' };

  return {
    ok: true,
    auth: {
      accessToken: credential.accessToken,
      organizationUuid: cached.organizationUuid,
      ...(cached.accountUuid !== undefined ? { accountUuid: cached.accountUuid } : {}),
    },
  };
}
