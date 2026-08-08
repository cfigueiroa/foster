import { readFileSync, statSync } from 'node:fs';
import { brotliDecompressSync, constants, gunzipSync } from 'node:zlib';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * The account's profile, read out of the app's HTTP response cache.
 *
 * This is the same category of file as the web storage next door — a copy the
 * app kept of something it fetched, not a credential — but it is a far better
 * source, and finding it corrected a claim made here for a long time. The
 * profile *was* persisted into Local Storage, inside the React Query cache; on a
 * real machine that cache now persists empty (`"queries":[]`) and the only
 * current copy of the profile is a cached response body. Everything the app
 * shows under your avatar is in it.
 *
 * Two differences from the crude reader in `identity.ts` are worth stating,
 * because they invert its trade-off. The bodies are gzip- or brotli-compressed,
 * so scanning bytes for text finds nothing at all — the compression is exactly
 * why the older reader concluded the profile was gone. And once decompressed
 * this is JSON, so it is *parsed* rather than pattern-matched: an object either
 * carries `account.uuid` equal to the account being asked about or it does not,
 * which is a fact, where "an address near a UUID" was a guess. The failure mode
 * that produced `6@ai.television.ses` cannot arise here.
 *
 * The reasoning that keeps `identity.ts` crude still holds for LevelDB: parsing
 * a database whose format is the app's to change is what crashed the process.
 * `gunzipSync` on a byte range is not that — a wrong guess throws, and throwing
 * is caught.
 */
export interface AccountProfile {
  accountUuid: string;
  email?: string;
  name?: string;
  displayName?: string;
  /** When the account itself was created, as the API reports it. */
  createdAt?: string;
  organizationUuid?: string;
  organizationName?: string;
  /** The organization's own word for its type — "claude_max", "claude_pro". */
  organizationType?: string;
  /**
   * The raw tier, kept verbatim beside the friendly name because it carries what
   * the friendly name throws away: `default_claude_max_20x` is a different
   * subscription from `default_claude_max_5x`, and "Max" cannot say which.
   */
  rateLimitTier?: string;
  billingType?: string;
  /** "active", "canceled", "past_due" — the API's word, not an interpretation. */
  subscriptionStatus?: string;
  /** When the subscription began. For a subscription in its first period this is also when it was first charged. */
  subscriptionCreatedAt?: string;
  hasExtraUsage?: boolean;
  /** Set when a charge is waiting on the cardholder to authorise it. */
  paymentNeedsAuth?: boolean;
  /* The fields below come from the billing endpoint, which the app does not
     always leave in the cache — present when it has, absent when it has not. */
  /** The date the subscription renews, when the billing endpoint's answer was cached. */
  nextChargeDate?: string;
  /** Set when the plan is scheduled to end — the difference between "active" and "active but cancelling". */
  planEndingAt?: string;
  billingInterval?: string;
  currency?: string;
  cardBrand?: string;
  cardLast4?: string;
}

/**
 * Everything the response cache can say about one account, or undefined.
 *
 * Only the account signed in now is ever found here, and that is a property of
 * the source rather than a limit of the reading: a response cache holds what was
 * fetched, and the app only ever fetches the profile of the session it is in.
 * Naming the other accounts is what the ledger is for.
 */
export function readProfileFromResponseCache(
  store: StoreLayout,
  accountUuid: string | undefined,
): AccountProfile | undefined {
  if (!accountUuid) return undefined;
  const wanted = accountUuid.toLowerCase();
  let profile: AccountProfile | undefined;
  let billing: Record<string, unknown> | undefined;

  for (const value of cachedJson(store)) {
    // The account object is the anchor: it names the account outright, so there
    // is nothing to infer and nothing to get wrong.
    const account = asRecord(value.account);
    if (!profile && typeof account?.uuid === 'string' && account.uuid.toLowerCase() === wanted) {
      profile = fromBootstrap(account, asRecord(value.organization));
    }
    // The billing answer names no account, so it is only trusted once the
    // profile has said which organization is ours — and then only if it is
    // shaped like the billing endpoint's reply rather than merely mentioning it.
    if (!billing && looksLikeBilling(value)) billing = value;
    if (profile && billing) break;
  }

  if (!profile) return undefined;
  return billing ? { ...profile, ...fromBilling(billing) } : profile;
}

function fromBootstrap(
  account: Record<string, unknown>,
  organization: Record<string, unknown> | undefined,
): AccountProfile {
  return {
    accountUuid: String(account.uuid),
    ...str('email', account.email ?? account.email_address),
    ...str('name', account.full_name),
    ...str('displayName', account.display_name),
    ...str('createdAt', account.created_at),
    ...str('organizationUuid', organization?.uuid),
    ...str('organizationName', organization?.name),
    ...str('organizationType', organization?.organization_type),
    ...str('rateLimitTier', organization?.rate_limit_tier),
    ...str('billingType', organization?.billing_type),
    ...str('subscriptionStatus', organization?.subscription_status),
    ...str('subscriptionCreatedAt', organization?.subscription_created_at),
    ...(typeof organization?.has_extra_usage_enabled === 'boolean'
      ? { hasExtraUsage: organization.has_extra_usage_enabled }
      : {}),
    ...(organization?.payment_auth_hosted_invoice_url ? { paymentNeedsAuth: true } : {}),
  };
}

function fromBilling(billing: Record<string, unknown>): Partial<AccountProfile> {
  const card = asRecord(billing.payment_method);
  return {
    ...str('nextChargeDate', billing.next_charge_date),
    ...str('planEndingAt', billing.plan_ending_at),
    ...str('billingInterval', billing.billing_interval),
    ...str('currency', billing.currency),
    ...str('cardBrand', card?.brand),
    ...str('cardLast4', card?.last4),
    // The billing endpoint's `status` is the authoritative one when it is here;
    // the bootstrap's is a summary of the same thing.
    ...str('subscriptionStatus', billing.status),
  };
}

/**
 * Whether an object is the billing endpoint's answer.
 *
 * Recognised by two fields together rather than one, because "status" alone is
 * the most common word in a JSON cache and would match nearly anything.
 */
function looksLikeBilling(value: Record<string, unknown>): boolean {
  return 'next_charge_date' in value && ('status' in value || 'plan_ending_at' in value);
}

function str<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === 'string' && value.length > 0
    ? ({ [key]: value } as Record<K, string>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Every JSON object the response cache holds, decompressed.
 *
 * The cache stores a body however the server sent it, so a body is looked for
 * three ways: as it lies, gunzipped from each point a gzip member begins, and
 * brotli-decompressed whole. The offset scan is what finds a body stored inside
 * a larger block file, which is where the profile actually lives — the block
 * carries several entries and the body starts partway in, so decompressing from
 * byte zero finds nothing.
 */
function* cachedJson(store: StoreLayout): Generator<Record<string, unknown>> {
  const budget = { files: MAX_FILES };
  for (const file of cacheFiles(path.join(store.root, 'Cache', 'Cache_Data'), budget)) {
    let bytes: Buffer;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      bytes = readFileSync(file);
    } catch {
      continue;
    }

    for (const body of decompressions(bytes)) {
      const value = parseJson(body);
      if (value) yield value;
    }
  }
}

function* decompressions(bytes: Buffer): Generator<string> {
  yield bytes.toString('utf8');

  for (let at = 0; at + 3 <= bytes.length; at++) {
    // The gzip member header: magic, then the one compression method that exists.
    if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b || bytes[at + 2] !== 0x08) continue;
    try {
      // A member inside a block file is followed by whatever came next, so the
      // stream ends early on purpose; a sync flush accepts that rather than
      // treating the truncation as corruption.
      yield gunzipSync(bytes.subarray(at), {
        finishFlush: constants.Z_SYNC_FLUSH,
      }).toString('utf8');
    } catch {
      // Not a gzip member after all — the magic occurs in ordinary data too.
    }
  }

  try {
    yield brotliDecompressSync(bytes, {
      finishFlush: constants.BROTLI_OPERATION_FLUSH,
    }).toString('utf8');
  } catch {
    // Not brotli.
  }
}

/**
 * A JSON object from text that is usually not JSON at all.
 *
 * A decompressed body is whatever the server sent — HTML, JavaScript, an image —
 * so the cheap check comes first and the parse only runs on something that opens
 * like an object carrying a field worth having.
 */
function parseJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start === -1 || start > 64) return undefined;
  if (!text.includes('"account"') && !text.includes('"next_charge_date"')) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start).trim());
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function* cacheFiles(root: string, budget: { files: number }): Generator<string> {
  for (const entry of safeReaddir(root)) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry);
    try {
      if (isDirectory(full)) {
        yield* cacheFiles(full, budget);
        continue;
      }
    } catch {
      continue;
    }
    budget.files -= 1;
    yield full;
  }
}

/** The cache holds whole media files; a profile response is a few hundred bytes. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;
