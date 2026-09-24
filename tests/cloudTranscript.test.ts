import { describe, expect, it } from 'vitest';
import {
  continuationNotice,
  serialiseCloudTranscript,
  teleportEventsToTranscript,
} from '../src/engine/cloudTranscript.js';
import type { TeleportEvent } from '../src/engine/cloudApi.js';

const OLD_SESSION_ID = '4a000000-0000-4000-8000-000000000000';

/** A teleport event shaped like the ones measured off a real session — see cloudApi.ts's module comment. */
function userEvent(
  uuid: string,
  parentUuid: string | null,
  text: string,
  sidechain = false,
): TeleportEvent {
  return {
    eventId: uuid,
    eventType: 'user',
    createdAt: '2026-09-01T00:00:00.000Z',
    payload: {
      type: 'user',
      uuid,
      parentUuid,
      isSidechain: sidechain,
      sessionId: OLD_SESSION_ID,
      timestamp: '2026-09-01T00:00:00.000Z',
      message: { role: 'user', content: text },
    },
  };
}

function assistantEvent(
  uuid: string,
  parentUuid: string,
  text: string,
  sidechain = false,
): TeleportEvent {
  return {
    eventId: uuid,
    eventType: 'assistant',
    createdAt: '2026-09-01T00:01:00.000Z',
    payload: {
      type: 'assistant',
      uuid,
      parentUuid,
      isSidechain: sidechain,
      sessionId: OLD_SESSION_ID,
      timestamp: '2026-09-01T00:01:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

describe('teleportEventsToTranscript', () => {
  it('rewrites sessionId and cwd on every record, keeps the parentUuid chain, and appends a continuation notice', () => {
    const events = [userEvent('u1', null, 'please build it'), assistantEvent('a1', 'u1', 'on it')];
    const result = teleportEventsToTranscript(events, {
      sessionId: 'new-session-uuid',
      cwd: '/repo/demo',
      now: 1_700_000_000_000,
    });

    expect(result.stats).toEqual({ total: 2, sidechainsDropped: 0, kept: 3 });
    expect(result.records).toHaveLength(3);

    for (const record of result.records) {
      expect(record.sessionId).toBe('new-session-uuid');
      expect(record.cwd).toBe('/repo/demo');
    }
    // uuid/parentUuid are left exactly as the API sent them.
    expect(result.records[0]!.uuid).toBe('u1');
    expect(result.records[0]!.parentUuid).toBeNull();
    expect(result.records[1]!.uuid).toBe('a1');
    expect(result.records[1]!.parentUuid).toBe('u1');

    const notice = result.records[2]!;
    expect(notice.parentUuid).toBe('a1'); // chained onto the last real record
    expect(notice.type).toBe('user');
    expect(notice.isMeta).toBe(true);
    expect((notice.message as { content: string }).content).toBe(continuationNotice('/repo/demo'));
  });

  it('adds userType and version, which the raw payload never carries', () => {
    const events = [userEvent('u1', null, 'hi')];
    const [record] = teleportEventsToTranscript(events, { sessionId: 's', cwd: '/x' }).records;
    expect(record!.userType).toBe('external');
    expect(typeof record!.version).toBe('string');
  });

  it('drops sidechain records and counts them, without touching the survivors', () => {
    const events = [
      userEvent('u1', null, 'main line'),
      userEvent('side1', 'u1', 'a sidechain digression', true),
      assistantEvent('a1', 'u1', 'answer'),
    ];
    const result = teleportEventsToTranscript(events, { sessionId: 's', cwd: '/x' });

    expect(result.stats.sidechainsDropped).toBe(1);
    expect(result.records.map((r) => r.uuid)).toEqual(['u1', 'a1', expect.any(String)]);
  });

  it('opens the continuation notice with a null parent when every event was a sidechain', () => {
    const events = [userEvent('side1', null, 'only a sidechain', true)];
    const result = teleportEventsToTranscript(events, { sessionId: 's', cwd: '/x' });

    expect(result.records).toHaveLength(1); // just the notice
    expect(result.records[0]!.parentUuid).toBeNull();
  });

  it('carries a git branch onto every record and the notice, when one is given', () => {
    const events = [userEvent('u1', null, 'hi')];
    const result = teleportEventsToTranscript(events, {
      sessionId: 's',
      cwd: '/x',
      gitBranch: 'claude/fix',
    });
    for (const record of result.records) expect(record.gitBranch).toBe('claude/fix');
  });

  it('leaves an existing gitBranch on a record alone rather than overwriting it', () => {
    const withBranch = userEvent('u1', null, 'hi');
    withBranch.payload.gitBranch = 'original-branch';
    const [record] = teleportEventsToTranscript([withBranch], {
      sessionId: 's',
      cwd: '/x',
      gitBranch: 'new-branch',
    }).records;
    expect(record!.gitBranch).toBe('original-branch');
  });

  it('preserves type-specific fields it does not know about, like an attachment or a system record', () => {
    const events: TeleportEvent[] = [
      {
        eventId: 'att1',
        eventType: 'attachment',
        payload: {
          type: 'attachment',
          uuid: 'att1',
          parentUuid: null,
          isSidechain: false,
          sessionId: OLD_SESSION_ID,
          timestamp: '2026-09-01T00:00:00.000Z',
          attachment: { type: 'environment', snapshot: { platform: 'linux' } },
        },
      },
    ];
    const [record] = teleportEventsToTranscript(events, { sessionId: 's', cwd: '/x' }).records;
    expect(record!.type).toBe('attachment');
    expect(record!.attachment).toEqual({ type: 'environment', snapshot: { platform: 'linux' } });
    expect(record!.sessionId).toBe('s'); // still rewritten
  });

  it('produces well-formed JSONL when serialised', () => {
    const events = [userEvent('u1', null, 'hi'), assistantEvent('a1', 'u1', 'hello')];
    const result = teleportEventsToTranscript(events, { sessionId: 's', cwd: '/x' });
    const text = serialiseCloudTranscript(result.records);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
