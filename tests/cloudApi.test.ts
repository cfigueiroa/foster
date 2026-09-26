import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCloudSession,
  fetchTeleportEvents,
  isCloudApiError,
  listCloudSessions,
} from '../src/engine/cloudApi.js';
import type { CloudAuth } from '../src/store/cloudAuth.js';

const AUTH: CloudAuth = {
  accessToken: 'test-token',
  organizationUuid: '00000000-0000-4000-8000-00000000000a',
};

/** Stubs global fetch with one canned response per call, in order — the same shape `usage.test.ts` uses. */
function stubFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `status ${r.status}`,
      json: () => Promise.resolve(r.body),
    } as Response);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('listCloudSessions', () => {
  it('maps a session list, reading repo/branch out of config.sources and config.outcomes', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          data: [
            {
              id: 'cse_00000000000000000000000001',
              title: 'Fix the thing',
              status: 'active',
              worker_status: 'idle',
              environment_kind: 'anthropic_cloud',
              created_at: '2026-09-01T00:00:00Z',
              last_event_at: '2026-09-01T01:00:00Z',
              config: {
                sources: [{ type: 'git_repository', url: 'https://example.com/acme/widgets' }],
                outcomes: [
                  {
                    type: 'git_repository',
                    git_info: { repo: 'acme/widgets', branches: ['claude/fix-thing'] },
                  },
                ],
              },
            },
            { id: 'cse_00000000000000000000000002', status: 'archived' },
          ],
        },
      },
    ]);

    const result = await listCloudSessions(AUTH);
    expect(isCloudApiError(result)).toBe(false);
    if (isCloudApiError(result)) throw result;
    expect(result).toEqual([
      {
        id: 'cse_00000000000000000000000001',
        title: 'Fix the thing',
        status: 'idle',
        environmentKind: 'anthropic_cloud',
        createdAt: '2026-09-01T00:00:00Z',
        lastEventAt: '2026-09-01T01:00:00Z',
        repo: {
          url: 'https://example.com/acme/widgets',
          repo: 'acme/widgets',
          branch: 'claude/fix-thing',
        },
      },
      { id: 'cse_00000000000000000000000002', title: 'Untitled', status: 'archived', repo: {} },
    ]);
  });

  it('sends the bearer token but no x-organization-uuid header', async () => {
    const calls = stubFetch([{ status: 200, body: { data: [] } }]);
    await listCloudSessions(AUTH);

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/code/sessions');
    expect(calls[0]!.headers.Authorization).toBe('Bearer test-token');
    expect(calls[0]!.headers['x-organization-uuid']).toBeUndefined();
  });

  it('turns a 401 into a typed error', async () => {
    stubFetch([{ status: 401, body: { error: { message: 'bad token' } } }]);
    const result = await listCloudSessions(AUTH);
    expect(isCloudApiError(result) && result.code).toBe('unauthorized');
  });

  it('follows next_cursor across pages, the shape measured against the real endpoint', async () => {
    const calls = stubFetch([
      {
        status: 200,
        body: {
          data: [{ id: 'cse_page1' }],
          next_cursor: 'CURSOR_1',
        },
      },
      {
        status: 200,
        body: {
          data: [{ id: 'cse_page2' }],
          next_cursor: '',
        },
      },
    ]);
    const result = await listCloudSessions(AUTH);
    expect(isCloudApiError(result)).toBe(false);
    expect((result as { id: string }[]).map((s) => s.id)).toEqual(['cse_page1', 'cse_page2']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain('cursor=');
    expect(calls[1]!.url).toContain('cursor=CURSOR_1');
  });

  it('stops at one page when next_cursor is absent', async () => {
    const calls = stubFetch([{ status: 200, body: { data: [{ id: 'cse_only' }] } }]);
    const result = await listCloudSessions(AUTH);
    expect(isCloudApiError(result)).toBe(false);
    expect((result as { id: string }[]).map((s) => s.id)).toEqual(['cse_only']);
    expect(calls).toHaveLength(1);
  });

  it('caps pagination rather than looping forever on a cursor that never ends', async () => {
    let requestCount = 0;
    vi.stubGlobal('fetch', () => {
      requestCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'ok',
        json: () =>
          Promise.resolve({ data: [{ id: `cse_${requestCount}` }], next_cursor: 'ALWAYS_MORE' }),
      } as Response);
    });
    const result = await listCloudSessions(AUTH);
    expect(isCloudApiError(result)).toBe(false);
    expect(requestCount).toBe(50);
    expect((result as { id: string }[]).length).toBe(50);
  });
});

describe('fetchCloudSession', () => {
  it('reads a session detail wrapped under response_shape', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          response_shape: {
            id: 'cse_00000000000000000000000001',
            title: 'Fix the thing',
            status: 'active',
            worker_status: 'idle',
            created_at: '2026-09-01T00:00:00Z',
            last_event_at: '2026-09-01T01:00:00Z',
            config: {
              sources: [{ type: 'git_repository', url: 'https://example.com/acme/widgets' }],
            },
            external_metadata: { container_cc_version: '2.1.999' },
          },
        },
      },
    ]);

    const result = await fetchCloudSession(AUTH, 'cse_00000000000000000000000001');
    expect(isCloudApiError(result)).toBe(false);
    if (isCloudApiError(result)) throw result;
    expect(result.title).toBe('Fix the thing');
    expect(result.containerCliVersion).toBe('2.1.999');
    expect(result.repo.url).toBe('https://example.com/acme/widgets');
  });

  it('turns a 404 into a typed error', async () => {
    stubFetch([{ status: 404, body: { error: { message: 'not found' } } }]);
    const result = await fetchCloudSession(AUTH, 'cse_nope');
    expect(isCloudApiError(result) && result.code).toBe('not_found');
  });
});

describe('fetchTeleportEvents', () => {
  function event(id: string, sidechain = false) {
    return {
      event_id: id,
      event_type: 'user',
      created_at: '2026-09-01T00:00:00Z',
      payload: { type: 'user', uuid: id, isSidechain: sidechain, sessionId: 's', timestamp: 't' },
    };
  }

  it('sends the org header and follows a cursor across pages', async () => {
    const calls = stubFetch([
      { status: 200, body: { data: [event('a')], next_cursor: 'page2' } },
      { status: 200, body: { data: [event('b')] } },
    ]);

    const result = await fetchTeleportEvents(AUTH, 'cse_x');
    expect(isCloudApiError(result)).toBe(false);
    if (isCloudApiError(result)) throw result;
    expect(result.map((e) => e.eventId)).toEqual(['a', 'b']);

    expect(calls[0]!.url).toContain('/v1/code/sessions/cse_x/teleport-events');
    expect(calls[0]!.url).toContain('limit=1000');
    expect(calls[0]!.headers['x-organization-uuid']).toBe(AUTH.organizationUuid);
    expect(calls[1]!.url).toContain('cursor=page2');
  });

  it('falls back to session_ingress when the primary endpoint answers null data', async () => {
    const calls = stubFetch([
      { status: 200, body: { data: null } },
      { status: 200, body: { data: [event('a')] } },
    ]);

    const result = await fetchTeleportEvents(AUTH, 'cse_x');
    expect(isCloudApiError(result)).toBe(false);
    expect(calls[1]!.url).toContain('/v1/session_ingress/session/cse_x');
  });

  it('falls back on a 404 from the primary endpoint too', async () => {
    const calls = stubFetch([
      { status: 404, body: { error: { message: 'nope' } } },
      { status: 200, body: { data: [event('a')] } },
    ]);
    const result = await fetchTeleportEvents(AUTH, 'cse_x');
    expect(isCloudApiError(result)).toBe(false);
    expect(calls[1]!.url).toContain('/v1/session_ingress/session/cse_x');
  });

  it('reports a real error from the fallback rather than swallowing it', async () => {
    const calls = stubFetch([
      { status: 200, body: { data: null } },
      { status: 403, body: { error: { message: 'forbidden' } } },
    ]);
    const result = await fetchTeleportEvents(AUTH, 'cse_x');
    expect(isCloudApiError(result) && result.code).toBe('forbidden');
    expect(calls).toHaveLength(2);
  });

  it('maps a 403 with type "untrusted_device" to that code', async () => {
    stubFetch([{ status: 403, body: { error: { type: 'untrusted_device', message: 'no' } } }]);
    const result = await fetchTeleportEvents(AUTH, 'cse_x');
    expect(isCloudApiError(result) && result.code).toBe('untrusted_device');
  });
});
