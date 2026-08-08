import type { OAuthToken } from '../store/credential.js';

/**
 * The two read-only questions foster asks the API, and the shapes it makes of
 * the answers.
 *
 * Both are GETs against `api.anthropic.com`, which is the token's own audience
 * and is built for programmatic use — unlike `claude.ai`, whose equivalent
 * endpoints sit behind a browser challenge foster will not try to defeat. So
 * what is reachable here is exactly profile and usage; the billing detail
 * (next charge, card, cancellation) lives only on the web origin and stays out
 * of reach, which is worth stating rather than papering over.
 *
 * Nothing here retries hard or follows redirects into other hosts. A call either
 * answers or returns undefined, because every caller already has an offline
 * answer to fall back to and a hang would be worse than a gap.
 */
const BASE = 'https://api.anthropic.com';
const HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
  accept: 'application/json',
} as const;

export interface LiveProfile {
  accountUuid?: string;
  email?: string;
  name?: string;
  organizationUuid?: string;
  organizationType?: string;
  rateLimitTier?: string;
  subscriptionStatus?: string;
  subscriptionCreatedAt?: string;
  hasExtraUsage?: boolean;
}

/** One usage window as the app draws it: a labelled bar with a reset time. */
export interface UsageWindow {
  /** "5-hour session", "Weekly · all models", "Weekly · Fable". */
  label: string;
  /** 0–100. */
  percent: number;
  /** "normal", "approaching_limit", "exceeded_limit" — the API's word. */
  severity?: string;
  /** ISO time the window resets, when there is one. */
  resetsAt?: string;
  /** The model a scoped weekly window is about, when it is scoped to one. */
  model?: string;
}

export interface UsageReport {
  windows: UsageWindow[];
  extraUsageEnabled: boolean;
  /** When foster asked — this answer is live, so its age is measured in seconds. */
  retrievedAt: number;
}

export async function fetchLiveProfile(
  auth: OAuthToken,
  now: number = Date.now(),
): Promise<LiveProfile | undefined> {
  const body = await getJson('/api/oauth/profile', auth, now);
  if (!body) return undefined;

  const account = asRecord(body.account);
  const organization = asRecord(body.organization);
  return {
    ...str('accountUuid', account?.uuid),
    ...str('email', account?.email),
    ...str('name', account?.full_name),
    ...str('organizationUuid', organization?.uuid),
    ...str('organizationType', organization?.organization_type),
    ...str('rateLimitTier', organization?.rate_limit_tier),
    ...str('subscriptionStatus', organization?.subscription_status),
    ...str('subscriptionCreatedAt', organization?.subscription_created_at),
    ...(typeof organization?.has_extra_usage_enabled === 'boolean'
      ? { hasExtraUsage: organization.has_extra_usage_enabled }
      : {}),
  };
}

export async function fetchLiveUsage(
  auth: OAuthToken,
  now: number = Date.now(),
): Promise<UsageReport | undefined> {
  const body = await getJson('/api/oauth/usage', auth, now);
  if (!body) return undefined;

  // The `limits` array is the authoritative list, because it carries the model
  // scope the flat `five_hour`/`seven_day` fields cannot — that is how the
  // per-model weekly window (Fable) is told apart from the all-models one.
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const windows: UsageWindow[] = [];
  for (const raw of limits) {
    const limit = asRecord(raw);
    if (!limit) continue;
    const model = asRecord(limit.scope)?.model;
    const modelName = asRecord(model)?.display_name;
    windows.push({
      label: labelFor(String(limit.group ?? ''), String(limit.kind ?? ''), asString(modelName)),
      percent: Math.round(Number(limit.percent ?? 0)),
      ...str('severity', limit.severity),
      ...str('resetsAt', limit.resets_at),
      ...str('model', modelName),
    });
  }

  const extra = asRecord(body.extra_usage);
  return {
    windows,
    extraUsageEnabled: extra?.is_enabled === true,
    retrievedAt: now,
  };
}

/**
 * A human label for a limit window.
 *
 * The API names windows by group and kind — "session", "weekly_all",
 * "weekly_scoped" — and a scoped weekly window carries the model it is about.
 * The labels mirror what the app prints so the two can be read side by side.
 */
function labelFor(group: string, kind: string, model: string | undefined): string {
  if (group === 'session' || kind === 'session') return '5-hour session';
  if (kind === 'weekly_scoped' && model) return `Weekly · ${model}`;
  if (kind === 'weekly_all' || group === 'weekly') return 'Weekly · all models';
  return kind || group || 'limit';
}

async function getJson(
  pathname: string,
  auth: OAuthToken,
  now: number,
): Promise<Record<string, unknown> | undefined> {
  if (auth.expiresAt && auth.expiresAt * 1000 < now) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      method: 'GET',
      headers: { ...HEADERS, Authorization: `Bearer ${auth.token}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return asRecord(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function str<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === 'string' && value.length > 0
    ? ({ [key]: value } as Record<K, string>)
    : {};
}
