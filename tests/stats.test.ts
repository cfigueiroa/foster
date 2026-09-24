import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeStats,
  usageEventsInFile,
  weekKey,
  type LimitStopEvent,
  type StatsConversation,
  type StatsDeps,
  type UsageEvent,
} from '../src/engine/stats.js';
import { USAGE_LIMIT } from '../src/engine/revive.js';
import { NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

/**
 * `foster stats` — token usage, sessions and usage-limit stops read out of
 * transcripts. `computeStats` is tested against a fake `StatsDeps` (no disk
 * involved); `usageEventsInFile` is tested against real files, since it is the
 * half that has to agree with what a transcript actually says.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function deps(conversations: StatsConversation[], events: Record<string, UsageEvent[]>): StatsDeps {
  const stops: Record<string, LimitStopEvent[]> = {};
  return {
    conversations: () => conversations,
    eventsOf: (id, since) => ({
      usage: (events[id] ?? []).filter((event) => event.at >= since),
      stops: (stops[id] ?? []).filter((event) => event.at >= since),
    }),
  };
}

function depsWithStops(
  conversations: StatsConversation[],
  usage: Record<string, UsageEvent[]>,
  stops: Record<string, LimitStopEvent[]>,
): StatsDeps {
  return {
    conversations: () => conversations,
    eventsOf: (id, since) => ({
      usage: (usage[id] ?? []).filter((event) => event.at >= since),
      stops: (stops[id] ?? []).filter((event) => event.at >= since),
    }),
  };
}

describe('computeStats', () => {
  it('sums tokens and sessions per account', () => {
    const report = computeStats(
      { since: NOW - 7 * DAY, by: 'account' },
      deps(
        [
          { cliSessionId: 'a', account: OLD_ACCOUNT },
          { cliSessionId: 'b', account: NEW_ACCOUNT },
        ],
        {
          a: [
            {
              at: NOW,
              model: 'claude-sonnet-5',
              inputTokens: 10,
              outputTokens: 20,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          ],
          b: [
            {
              at: NOW,
              model: 'claude-sonnet-5',
              inputTokens: 5,
              outputTokens: 5,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          ],
        },
      ),
    );

    expect(report.buckets).toHaveLength(2);
    expect(report.totals).toEqual({
      sessions: 2,
      inputTokens: 15,
      outputTokens: 25,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      limitStops: 0,
    });
    const old = report.buckets.find((b) => b.key.account === OLD_ACCOUNT.accountUuid);
    expect(old?.inputTokens).toBe(10);
    expect(old?.sessions).toBe(1);
  });

  it('buckets a conversation no card claims as unattributed, not dropped', () => {
    const report = computeStats(
      { since: NOW - DAY, by: 'account' },
      deps([{ cliSessionId: 'orphan' }], {
        orphan: [
          {
            at: NOW,
            model: 'claude-sonnet-5',
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        ],
      }),
    );

    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]!.key.account).toBeUndefined();
    expect(report.buckets[0]!.sessions).toBe(1);
  });

  it('leaves out events before the window', () => {
    const report = computeStats(
      { since: NOW, by: 'account' },
      deps([{ cliSessionId: 'a', account: OLD_ACCOUNT }], {
        a: [
          {
            at: NOW - DAY,
            model: 'claude-sonnet-5',
            inputTokens: 100,
            outputTokens: 100,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        ],
      }),
    );

    expect(report.buckets).toEqual([]);
    expect(report.totals.sessions).toBe(0);
  });

  it('groups by model across accounts when asked', () => {
    const report = computeStats(
      { since: NOW - DAY, by: 'model' },
      deps(
        [
          { cliSessionId: 'a', account: OLD_ACCOUNT },
          { cliSessionId: 'b', account: NEW_ACCOUNT },
        ],
        {
          a: [
            {
              at: NOW,
              model: 'claude-opus-5',
              inputTokens: 3,
              outputTokens: 3,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          ],
          b: [
            {
              at: NOW,
              model: 'claude-opus-5',
              inputTokens: 4,
              outputTokens: 4,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          ],
        },
      ),
    );

    expect(report.buckets).toEqual([
      {
        key: { model: 'claude-opus-5' },
        sessions: 2,
        inputTokens: 7,
        outputTokens: 7,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        limitStops: 0,
      },
    ]);
  });

  it('groups by week, chronologically, with sessions counted once even if they span weeks', () => {
    const week1 = Date.parse('2026-09-07T10:00:00.000Z'); // Monday of week 1
    const week2 = Date.parse('2026-09-14T10:00:00.000Z'); // Monday of week 2

    const report = computeStats(
      { since: week1, by: 'week' },
      deps([{ cliSessionId: 'a', account: OLD_ACCOUNT }], {
        a: [
          {
            at: week1,
            model: 'x',
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          {
            at: week2,
            model: 'x',
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        ],
      }),
    );

    expect(report.buckets.map((b) => b.key.week)).toEqual([weekKey(week1), weekKey(week2)]);
    expect(report.buckets.every((b) => b.sessions === 1)).toBe(true);
    // The conversation counts once in the total even though it touched two weeks.
    expect(report.totals.sessions).toBe(1);
  });

  it('counts a usage-limit stop, and a session that only stopped with no usage', () => {
    const report = computeStats(
      { since: NOW - DAY, by: 'account' },
      depsWithStops(
        [{ cliSessionId: 'stopped', account: OLD_ACCOUNT }],
        {},
        { stopped: [{ at: NOW, model: '<synthetic>' }] },
      ),
    );

    expect(report.totals).toEqual({
      sessions: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      limitStops: 1,
    });
    expect(report.buckets[0]!.limitStops).toBe(1);
  });
});

describe('weekKey', () => {
  it('is the Monday (UTC) a moment falls in', () => {
    expect(weekKey(Date.parse('2026-09-24T12:00:00.000Z'))).toBe('2026-09-21');
    expect(weekKey(Date.parse('2026-09-21T00:00:00.000Z'))).toBe('2026-09-21');
    expect(weekKey(Date.parse('2026-09-27T23:59:59.000Z'))).toBe('2026-09-21');
    expect(weekKey(Date.parse('2026-09-28T00:00:00.000Z'))).toBe('2026-09-28');
  });
});

describe('usageEventsInFile', () => {
  function write(records: unknown[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-stats-'));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
    return file;
  }

  it('reads a real assistant usage record', () => {
    const file = write([
      { type: 'user', timestamp: '2026-09-24T10:00:00.000Z' },
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:01:00.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 2,
            output_tokens: 375,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        },
      },
    ]);

    const { usage, stops } = usageEventsInFile(file, 0);

    expect(stops).toEqual([]);
    expect(usage).toEqual([
      {
        at: Date.parse('2026-09-24T10:01:00.000Z'),
        model: 'claude-sonnet-5',
        inputTokens: 2,
        outputTokens: 375,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
      },
    ]);
  });

  it("reads a usage-limit stop with revive's own detection, and ignores a sidechain", () => {
    const file = write([
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:00:00.000Z',
        isApiErrorMessage: true,
        error: USAGE_LIMIT,
        message: { model: '<synthetic>' },
      },
      {
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-09-24T10:00:01.000Z',
        isApiErrorMessage: true,
        error: USAGE_LIMIT,
        message: { model: '<synthetic>' },
      },
    ]);

    const { usage, stops } = usageEventsInFile(file, 0);

    expect(usage).toEqual([]);
    expect(stops).toEqual([{ at: Date.parse('2026-09-24T10:00:00.000Z'), model: '<synthetic>' }]);
  });

  it('attributes a usage-limit stop to the real model that was running, not the placeholder', () => {
    const file = write([
      {
        type: 'assistant',
        timestamp: '2026-09-24T09:00:00.000Z',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:00:00.000Z',
        isApiErrorMessage: true,
        error: USAGE_LIMIT,
        message: { model: '<synthetic>' },
      },
    ]);

    const { stops } = usageEventsInFile(file, 0);

    expect(stops).toEqual([{ at: Date.parse('2026-09-24T10:00:00.000Z'), model: 'claude-opus-5' }]);
  });

  it('falls back to the stop record itself when no real model preceded it', () => {
    const file = write([
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:00:00.000Z',
        isApiErrorMessage: true,
        error: USAGE_LIMIT,
        message: { model: '<synthetic>' },
      },
    ]);

    const { stops } = usageEventsInFile(file, 0);

    expect(stops).toEqual([{ at: Date.parse('2026-09-24T10:00:00.000Z'), model: '<synthetic>' }]);
  });

  it('ignores an error that is not a usage limit', () => {
    const file = write([
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:00:00.000Z',
        isApiErrorMessage: true,
        error: 'invalid_request',
        message: { model: 'claude-sonnet-5' },
      },
    ]);

    expect(usageEventsInFile(file, 0)).toEqual({ usage: [], stops: [] });
  });

  it('respects the since cutoff', () => {
    const file = write([
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:00:00.000Z',
        message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);

    expect(usageEventsInFile(file, Date.parse('2026-09-25T00:00:00.000Z')).usage).toEqual([]);
    expect(usageEventsInFile(file, Date.parse('2026-09-01T00:00:00.000Z')).usage).toHaveLength(1);
  });

  it('is empty for a file that is not there', () => {
    expect(usageEventsInFile(path.join(tmpdir(), 'no-such-transcript.jsonl'), 0)).toEqual({
      usage: [],
      stops: [],
    });
  });
});
