import type { StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { project } from '../ledger/project.js';
import { fetchLiveProfile, type LiveProfile } from './anthropicApi.js';
import { asOAuthToken } from './switch.js';
import { readAccessToken, type OAuthToken } from '../store/credential.js';
import { readConfig } from '../store/config.js';
import { readCliCredential } from '../store/cliCredential.js';
import { listClients } from '../store/clients.js';
import { currentCredential, listAll, rememberCredential, vaultRoot } from './vault.js';

/**
 * Ask the API who an account is, using a credential foster already holds.
 *
 * The gap this fills: the app only ever caches the profile of the account signed
 * in now, so every other account is a bare directory until someone signs into it
 * with foster watching. But a credential for that account may already be on the
 * machine — in a CLI client, or in foster's own vault — and the profile endpoint
 * answers for whatever token is presented. So the account can be named without a
 * sign-in, by presenting its own credential and asking.
 *
 * Two rules make this safe rather than a guess. A token only ever answers for
 * *itself*, so there is no way to enumerate an organization — identifying account
 * X requires a credential *for* X. And the answer names its own `accountUuid`, so
 * a credential that turns out to belong to someone else is discarded on the
 * mismatch rather than recorded against the account that was asked about. The
 * failure mode of naming the wrong account cannot arise.
 *
 * Nothing here is automatic: like `usage` and `renewals`, it goes to the network
 * only when a person asks. `api.anthropic.com` only, no token minted or renewed,
 * every failure silent with an offline explanation to fall back on.
 */

export interface IdentifyOutcome {
  accountUuid: string;
  /** The profile the API returned, when a held credential matched this account. */
  profile?: LiveProfile;
  /** Why no profile — for the message the caller shows. */
  reason?: 'no-credential' | 'expired-only' | 'no-answer';
}

/** A credential foster holds, tagged with where it came from for the message. */
interface Candidate {
  auth: OAuthToken;
  expired: boolean;
  /**
   * Whose it is, when that is already on disk — the app's own config hint, a
   * client's cached profile, a vault entry the API has answered for before.
   * Never a guess: absent means unknown, and only the API settles it.
   */
  owner?: string;
}

/**
 * Every credential on the machine that could answer for *some* account, newest
 * intent first. None is opened here beyond turning it into a bearer token; which
 * account each belongs to is the API's to say, not ours to assume from a
 * filename.
 */
function candidates(store: StoreLayout, now: number): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const add = (auth: OAuthToken | undefined, owner?: string) => {
    if (!auth?.token || seen.has(auth.token)) return;
    seen.add(auth.token);
    found.push({
      auth,
      expired: auth.expiresAt !== undefined && auth.expiresAt * 1000 <= now,
      ...(owner ? { owner } : {}),
    });
  };

  // The Desktop OAuth cache: the account signed into the app right now.
  add(readAccessToken(store), signedInAccount(store));

  // Every CLI client that has a credential on disk.
  for (const client of listClients()) {
    if (!client.signedIn) continue;
    const credential = readCliCredential(client.configDir);
    if (credential) add(asOAuthToken(credential), client.identity?.profile?.accountUuid);
  }

  // The vault: every credential foster has ever been handed.
  const root = vaultRoot();
  for (const entry of listAll(root)) {
    const held = currentCredential(root, entry.surface, entry.email);
    if (held) add(asOAuthToken(held.credential), entry.accountUuid);
  }

  return found;
}

/**
 * Identify one account by presenting the credentials foster holds until one
 * answers as that account. Records the sighting in the ledger — the same event
 * `whoami` and `label` write, so the dashboard and `/accounts` pick it up with
 * no further work — and fills in a vault entry's `accountUuid` when the token
 * that matched came from one that lacked it.
 */
export async function identifyAccount(
  store: StoreLayout,
  ledger: Ledger,
  accountUuid: string,
  now: number = Date.now(),
): Promise<IdentifyOutcome> {
  const pool = candidates(store, now);
  if (pool.length === 0) return { accountUuid, reason: 'no-credential' };

  let sawLiveCredential = false;
  for (const candidate of pool) {
    if (candidate.expired) continue;
    sawLiveCredential = true;
    const profile = await fetchLiveProfile(candidate.auth, now);
    // A token answers for itself: only the one whose account is the one asked
    // about is this account's, and any other is simply the wrong key tried.
    if (profile?.accountUuid && profile.accountUuid === accountUuid) {
      recordSighting(ledger, accountUuid, profile);
      backfillVault(vaultRoot(), profile, now);
      return { accountUuid, profile };
    }
  }

  // A live credential answered, just never as this account; versus every
  // candidate being expired, which the CLI fixes on its next run.
  return { accountUuid, reason: sawLiveCredential ? 'no-answer' : 'expired-only' };
}

/**
 * Name every account a held credential can speak for and the ledger has no
 * identity for yet — the automatic half of this file.
 *
 * Two things keep it from being a network call on every run. Each credential is
 * asked *once* per run rather than once per account: a token answers with its
 * own `accountUuid`, so a single round names everyone it can, where asking per
 * account would be one request per pair. And a credential whose owner is already
 * on disk — the app's config hint, a client's cached profile, a vault entry the
 * API has answered for before — is skipped once that owner has an identity, so
 * the run after the first goes nowhere near the network.
 *
 * The two rules above still hold: a token only ever answers for itself, and the
 * answer names its own account, so nothing is recorded against an account that
 * was merely asked about. Every failure is silent — this runs ahead of commands
 * that only mean to print something, and a name is never worth an error.
 */
export async function identifyHeldAccounts(
  store: StoreLayout,
  ledger: Ledger,
  now: number = Date.now(),
): Promise<string[]> {
  const known = project(ledger.read()).identities;
  const named: string[] = [];

  for (const candidate of candidates(store, now)) {
    if (candidate.expired) continue;
    if (candidate.owner && known.has(candidate.owner)) continue;

    const profile = await fetchLiveProfile(candidate.auth, now);
    const accountUuid = profile?.accountUuid;
    if (!profile || !accountUuid || known.has(accountUuid)) continue;

    recordSighting(ledger, accountUuid, profile);
    backfillVault(vaultRoot(), profile, now);
    // Folded in as we go: a later credential is skipped outright when it
    // carries this account as its owner, and never recorded twice when it
    // does not — a credential whose owner is unknown still costs the one
    // question it takes to find out.
    known.set(accountUuid, {
      seenAt: now,
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.name ? { name: profile.name } : {}),
    });
    named.push(accountUuid);
  }

  return named;
}

/** True when foster holds no fresh credential that could name this account. */
export function canIdentify(store: StoreLayout, now: number = Date.now()): boolean {
  return candidates(store, now).some((candidate) => !candidate.expired);
}

/** The account the store is signed into, so the caller can skip it (already cached). */
export function signedInAccount(store: StoreLayout): string | undefined {
  return readConfig(store).lastKnownAccountUuid;
}

function recordSighting(ledger: Ledger, accountUuid: string, profile: LiveProfile): void {
  const known = project(ledger.read()).identities.get(accountUuid);
  const sighting = {
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.rateLimitTier ? { plan: profile.rateLimitTier } : {}),
    profile: {
      accountUuid,
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.organizationUuid ? { organizationUuid: profile.organizationUuid } : {}),
      ...(profile.organizationType ? { organizationType: profile.organizationType } : {}),
      ...(profile.rateLimitTier ? { rateLimitTier: profile.rateLimitTier } : {}),
      ...(profile.subscriptionStatus ? { subscriptionStatus: profile.subscriptionStatus } : {}),
    },
  };
  // Only when it adds something: a re-identify that saw the same profile should
  // not grow the ledger by a line that changes nothing.
  if (
    known &&
    known.email === sighting.email &&
    known.name === sighting.name &&
    known.plan === sighting.plan
  ) {
    return;
  }
  ledger.append({ kind: 'account_identity_seen', accountUuid, ...sighting });
}

/**
 * A vault entry taken before foster asked the API has no `accountUuid`. When the
 * credential that just matched came from such an entry, the answer supplies the
 * missing id — appended, never rewritten, because the vault is append-only.
 */
function backfillVault(root: string, profile: LiveProfile, now: number): void {
  if (!profile.accountUuid || !profile.email) return;
  for (const entry of listAll(root)) {
    if (entry.accountUuid || entry.email.toLowerCase() !== profile.email.toLowerCase()) continue;
    const held = currentCredential(root, entry.surface, entry.email);
    if (!held) continue;
    // Same credential bytes, now carrying the id — rememberCredential no-ops if
    // the newest record already holds these exact bytes, so this only writes
    // when it is genuinely adding the id.
    rememberCredential(root, entry.surface, profile.email, held.credential, {
      accountUuid: profile.accountUuid,
      now,
    });
  }
}
