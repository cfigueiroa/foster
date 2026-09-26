import type { CloudAuth } from '../store/cloudAuth.js';

/**
 * The Claude Code cloud-sessions API — `foster cloud`'s read side.
 *
 * Undocumented and private: there is no published spec for any of this, only
 * what reading the installed CLI's own bundle shows. Measured against
 * `@anthropic-ai/claude-code` 2.1.278 (`bin/claude.exe`, a bundled Node
 * binary — read with a byte search for the literal strings a build like this
 * cannot obfuscate away: `/v1/code/sessions`, header names, the minified
 * functions that build them) and against seven real sessions on one signed-in
 * account (2026-09-24). It can change under a future CLI release with no
 * notice to foster; nothing here should be trusted as a contract the way
 * `anthropicApi.ts`'s two endpoints are.
 *
 * `claude.ai` auth only — `api.anthropic.com` accepts the same OAuth bearer
 * token `anthropicApi.ts` uses, and the CLI itself throws
 * "Cloud sessions are only available on the first-party Anthropic API
 * provider" before ever reaching the network when the only credential on hand
 * is an API key. `readCloudAuth` only ever hands this module a token read from
 * `.credentials.json`, so that condition cannot arise here — noted because a
 * future caller reusing this module against some other stored token should
 * know the API itself enforces it, not just foster's own plumbing.
 */

const BASE = 'https://api.anthropic.com';
const TIMEOUT_MS = 20_000;

/** `qv(token)` in the CLI bundle — the headers every one of these calls sends. */
function baseHeaders(auth: CloudAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    // The CLI's own value (`Am()`) branches on CLAUDE_CODE_ENTRYPOINT and a
    // dozen other client shells; foster is none of them, so it names itself
    // rather than borrowing a label that would misdescribe the caller.
    'anthropic-client-platform': 'foster_cli',
  };
}

/** Added on top of the base headers for the two calls the bundle sends it on: teleport-events and its session_ingress fallback. */
function withOrg(auth: CloudAuth): Record<string, string> {
  return { ...baseHeaders(auth), 'x-organization-uuid': auth.organizationUuid };
}

export type CloudApiErrorCode =
  | 'unauthorized'
  | 'untrusted_device'
  | 'session_stale_relogin'
  | 'not_found'
  | 'forbidden'
  | 'network'
  | 'unexpected';

export interface CloudApiError {
  code: CloudApiErrorCode;
  message: string;
  status?: number;
}

function isError<T>(value: T | CloudApiError): value is CloudApiError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}
export { isError as isCloudApiError };

/**
 * Read a non-2xx response into a typed error.
 *
 * `untrusted_device` and `session_stale_relogin` are named in the bundle's own
 * error copy (see the module comment) as reasons a device or a sign-in is no
 * longer trusted; assumed rather than measured to arrive as `error.type` on the
 * response body, following the shape every other Anthropic API error uses —
 * this codebase has never seen either fire, so a body that does not carry a
 * recognisable `type` falls back to a status-based reading instead of guessing
 * at a code this has not observed.
 */
async function errorFrom(response: Response): Promise<CloudApiError> {
  let bodyType: string | undefined;
  let bodyMessage: string | undefined;
  try {
    const body = (await response.json()) as { error?: { type?: string; message?: string } };
    bodyType = body.error?.type;
    bodyMessage = body.error?.message;
  } catch {
    // No JSON body, or not the shape expected — fall through to status alone.
  }

  if (bodyType === 'untrusted_device' || bodyType === 'session_stale_relogin') {
    return {
      code: bodyType,
      message:
        bodyMessage ??
        (bodyType === 'untrusted_device'
          ? "the server no longer accepts this machine's device proof — sign in again on this machine"
          : 'the sign-in on this machine has expired — sign in again on this machine'),
      status: response.status,
    };
  }

  if (response.status === 401) {
    return {
      code: 'unauthorized',
      message: bodyMessage ?? 'the access token was rejected',
      status: 401,
    };
  }
  if (response.status === 403) {
    return {
      code: 'forbidden',
      message: bodyMessage ?? 'the API refused this request (403)',
      status: 403,
    };
  }
  if (response.status === 404) {
    return { code: 'not_found', message: bodyMessage ?? 'no such session', status: 404 };
  }
  return {
    code: 'unexpected',
    message: bodyMessage ?? `${response.status} ${response.statusText}`,
    status: response.status,
  };
}

async function get(
  url: string,
  headers: Record<string, string>,
  params?: Record<string, string>,
): Promise<Response | CloudApiError> {
  const full = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) full.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(full.toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return await errorFrom(response);
    return response;
  } catch (error) {
    return {
      code: 'network',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** A repository hint read off a session's `config.sources`/`config.outcomes` — never used for a git operation, only printed. */
export interface CloudRepoHint {
  /** The clone URL from `config.sources[].url`, when the session names a git repository source. */
  url?: string;
  /** `owner/repo` from `config.outcomes[].git_info.repo`, when the session has run at least once. */
  repo?: string;
  /** The first branch name the session's own git_info reports, when it has one. */
  branch?: string;
}

function repoHintFrom(config: Record<string, unknown> | undefined): CloudRepoHint {
  if (!config) return {};
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const gitSource = sources.find(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' &&
      s !== null &&
      (s as Record<string, unknown>).type === 'git_repository',
  );
  const url = typeof gitSource?.url === 'string' ? gitSource.url : undefined;

  const outcomes = Array.isArray(config.outcomes) ? config.outcomes : [];
  const gitOutcome = outcomes.find(
    (o): o is Record<string, unknown> =>
      typeof o === 'object' &&
      o !== null &&
      (o as Record<string, unknown>).type === 'git_repository',
  );
  const gitInfo =
    typeof gitOutcome?.git_info === 'object' && gitOutcome.git_info !== null
      ? (gitOutcome.git_info as Record<string, unknown>)
      : undefined;
  const repo = typeof gitInfo?.repo === 'string' ? gitInfo.repo : undefined;
  const branches = Array.isArray(gitInfo?.branches) ? gitInfo.branches : [];
  const branch = typeof branches[0] === 'string' ? branches[0] : undefined;

  return {
    ...(url !== undefined ? { url } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
}

export interface CloudSessionSummary {
  id: string;
  title: string;
  /** `'archived'` when the session's own `status` says so, otherwise its `worker_status` (`idle`, `working`, `requires_action`, …). */
  status: string;
  environmentKind?: string;
  createdAt?: string;
  lastEventAt?: string;
  repo: CloudRepoHint;
}

/** Kept so a runaway cursor cannot page forever — the same reasoning as `TELEPORT_MAX_PAGES`. */
const SESSIONS_MAX_PAGES = 50;

/**
 * `GET /v1/code/sessions` — every cloud session on this account, paginated.
 *
 * Sends no `x-organization-uuid`: measured against the real endpoint (and
 * matching the bundle's own `iar()`), the list call authenticates purely off
 * the bearer token's own account.
 *
 * The first cut of this function read only the first page: every account
 * probed while this module was first written (2026-09-24) returned its whole
 * list — seven sessions — in one page, so the response's own pagination
 * fields were never read. Measured directly against the real endpoint while
 * fixing `foster sweep --cloud` (2026-09-26, a read-only `GET` with the
 * default client's own token, raw output kept only in a scratch temp
 * directory and deleted after reading): a real account with more than one
 * page returns `{ data, next_cursor, resume_token }`, and a page 20 items
 * long (this account has more than that) still carries a non-empty
 * `next_cursor`. Re-requesting with `?cursor=<next_cursor>` returned the next
 * 20, a different set of ids, with its own `next_cursor` — the same opaque
 * base64 cursor `fetchTeleportEventsFrom` already reads for a different
 * endpoint, not the `has_more`/`last_id` shape an earlier guess assumed
 * before this was actually measured. An empty or absent `next_cursor` is what
 * ends the loop; `resume_token` is read by neither this function nor anything
 * downstream — it names a different resume mechanism the bundle uses
 * elsewhere, outside this command's scope.
 */
export async function listCloudSessions(
  auth: CloudAuth,
): Promise<CloudSessionSummary[] | CloudApiError> {
  const out: CloudSessionSummary[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < SESSIONS_MAX_PAGES; page++) {
    const params: Record<string, string> = {};
    if (cursor !== undefined) params.cursor = cursor;

    const result = await get(`${BASE}/v1/code/sessions`, baseHeaders(auth), params);
    if (isError(result)) return result;

    let body: { data?: unknown[]; next_cursor?: unknown };
    try {
      body = (await result.json()) as typeof body;
    } catch (error) {
      return {
        code: 'unexpected',
        message: `could not parse the session list: ${String(error)}`,
      };
    }

    for (const raw of body.data ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.id !== 'string') continue;
      const config =
        typeof s.config === 'object' && s.config !== null
          ? (s.config as Record<string, unknown>)
          : undefined;
      out.push({
        id: s.id,
        title: typeof s.title === 'string' && s.title !== '' ? s.title : 'Untitled',
        status:
          s.status === 'archived'
            ? 'archived'
            : typeof s.worker_status === 'string'
              ? s.worker_status
              : 'idle',
        ...(typeof s.environment_kind === 'string' ? { environmentKind: s.environment_kind } : {}),
        ...(typeof s.created_at === 'string' ? { createdAt: s.created_at } : {}),
        ...(typeof s.last_event_at === 'string' ? { lastEventAt: s.last_event_at } : {}),
        repo: repoHintFrom(config),
      });
    }

    const next = typeof body.next_cursor === 'string' ? body.next_cursor : undefined;
    if (!next) break;
    cursor = next;
  }

  return out;
}

export interface CloudSessionDetail extends CloudSessionSummary {
  /** The CLI build that most recently ran inside the container, when the session has run at least once. */
  containerCliVersion?: string;
}

/** `GET /v1/code/sessions/{id}` — one session's current detail (title, status, repo/branch), for `cloud pull`'s card and hint. */
export async function fetchCloudSession(
  auth: CloudAuth,
  id: string,
): Promise<CloudSessionDetail | CloudApiError> {
  const result = await get(`${BASE}/v1/code/sessions/${encodeURIComponent(id)}`, baseHeaders(auth));
  if (isError(result)) return result;

  let body: Record<string, unknown>;
  try {
    const parsed = (await result.json()) as Record<string, unknown>;
    // Measured: the real response wraps the session under `response_shape`
    // rather than at the top level. Read through it when present, and fall
    // back to the top level in case that wrapping is specific to this one
    // endpoint version — either way `id`/`title` below are what decide
    // whether anything usable came back.
    body =
      typeof parsed.response_shape === 'object' && parsed.response_shape !== null
        ? (parsed.response_shape as Record<string, unknown>)
        : parsed;
  } catch (error) {
    return { code: 'unexpected', message: `could not parse the session: ${String(error)}` };
  }

  if (typeof body.id !== 'string') {
    return { code: 'unexpected', message: 'the session response had no id' };
  }
  const config =
    typeof body.config === 'object' && body.config !== null
      ? (body.config as Record<string, unknown>)
      : undefined;
  const externalMeta =
    typeof body.external_metadata === 'object' && body.external_metadata !== null
      ? (body.external_metadata as Record<string, unknown>)
      : undefined;

  return {
    id: body.id,
    title: typeof body.title === 'string' && body.title !== '' ? body.title : 'Untitled',
    status:
      body.status === 'archived'
        ? 'archived'
        : typeof body.worker_status === 'string'
          ? body.worker_status
          : 'idle',
    ...(typeof body.environment_kind === 'string'
      ? { environmentKind: body.environment_kind }
      : {}),
    ...(typeof body.created_at === 'string' ? { createdAt: body.created_at } : {}),
    ...(typeof body.last_event_at === 'string' ? { lastEventAt: body.last_event_at } : {}),
    ...(typeof externalMeta?.container_cc_version === 'string'
      ? { containerCliVersion: externalMeta.container_cc_version }
      : {}),
    repo: repoHintFrom(config),
  };
}

/** One raw teleport event, before its `payload` is read as a transcript record — see `cloudTranscript.ts`. */
export interface TeleportEvent {
  eventId: string;
  eventType: string;
  createdAt?: string;
  payload: Record<string, unknown>;
}

const TELEPORT_PAGE_LIMIT = 1000;
/** The bundle's own ceiling (`N=100` in `bot()`) — kept so a runaway cursor cannot page forever. */
const TELEPORT_MAX_PAGES = 100;

/**
 * `GET /v1/code/sessions/{id}/teleport-events`, paginated — the session's own
 * history, which `cloudTranscript.ts` turns into a Claude transcript.
 *
 * Falls back to `GET /v1/session_ingress/session/{id}` on a `null` result the
 * way the bundle's `bot()` does (`if(M===null) ... M=await Sot(...)`) —
 * measured only on the primary endpoint, since every real session probed here
 * answered it directly; the fallback exists in this module on the strength of
 * reading the bundle alone, not of having exercised it.
 */
export async function fetchTeleportEvents(
  auth: CloudAuth,
  id: string,
): Promise<TeleportEvent[] | CloudApiError> {
  const primary = await fetchTeleportEventsFrom(
    `${BASE}/v1/code/sessions/${encodeURIComponent(id)}/teleport-events`,
    auth,
  );
  if (primary !== null) return primary;

  const fallback = await fetchTeleportEventsFrom(
    `${BASE}/v1/session_ingress/session/${encodeURIComponent(id)}`,
    auth,
  );
  if (fallback !== null) return fallback;
  return { code: 'not_found', message: `no session history at either endpoint for ${id}` };
}

/** `null` only for the one condition that means "try the fallback URL instead" — everything else is a real result or a real error. */
async function fetchTeleportEventsFrom(
  url: string,
  auth: CloudAuth,
): Promise<TeleportEvent[] | CloudApiError | null> {
  const headers = withOrg(auth);
  const events: TeleportEvent[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < TELEPORT_MAX_PAGES; page++) {
    const params: Record<string, string> = { limit: String(TELEPORT_PAGE_LIMIT) };
    if (cursor !== undefined) params.cursor = cursor;

    const result = await get(url, headers, params);
    if (isError(result)) {
      if (result.code === 'not_found' && page === 0) return null; // let the caller try the fallback
      return result;
    }

    let body: { data?: unknown[]; next_cursor?: unknown; cursor?: unknown };
    try {
      body = (await result.json()) as typeof body;
    } catch (error) {
      return { code: 'unexpected', message: `could not parse teleport events: ${String(error)}` };
    }
    if (body.data === null) return null; // the bundle's own "try the fallback" signal

    for (const raw of body.data ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as Record<string, unknown>;
      const payload =
        typeof e.payload === 'object' && e.payload !== null
          ? (e.payload as Record<string, unknown>)
          : undefined;
      if (typeof e.event_id !== 'string' || typeof e.event_type !== 'string' || !payload) continue;
      events.push({
        eventId: e.event_id,
        eventType: e.event_type,
        ...(typeof e.created_at === 'string' ? { createdAt: e.created_at } : {}),
        payload,
      });
    }

    const next = body.next_cursor ?? body.cursor;
    if (typeof next !== 'string' || next === '') break;
    cursor = next;
  }

  return events;
}
