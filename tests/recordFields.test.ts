import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFields, scanConversation } from '../src/store/transcripts.js';

/**
 * `recordFields` replaces a `JSON.parse` of every line of every forked
 * transcript, which was the sweep's largest single cost — 57.3 s of garbage
 * collection out of 105.8 s, measured 21/09/2026 on a real store.
 *
 * The thing it must not do is differ from the parse it replaces. The set of
 * record ids is what decides which branch of a fork carried on and which is
 * marked stale, so a field read from the wrong place is a wrong verdict on
 * somebody's work. These tests pin the reading against the parse on the shapes
 * that could make them disagree; `scripts/scan-equivalence.ts` runs the same
 * comparison over a real store, where the corpus is the argument.
 */

/** What a parse of the whole record would have produced, for the same five fields. */
function byParsing(line: string): Record<string, string | boolean> | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const fields: Record<string, string | boolean> = {};
  for (const key of ['uuid', 'timestamp', 'type'] as const) {
    const value = record[key];
    if (typeof value === 'string') fields[key] = value;
  }
  for (const key of ['isApiErrorMessage', 'isSidechain'] as const) {
    const value = record[key];
    if (typeof value === 'boolean') fields[key] = value;
  }
  return fields;
}

/** Both readings of one line, so a test states the agreement rather than one side of it. */
function bothWays(line: string): {
  scanned: Record<string, string | boolean> | undefined;
  parsed: Record<string, string | boolean> | undefined;
} {
  const fields = recordFields(line);
  const scanned =
    fields === undefined ? undefined : { ...(fields as Record<string, string | boolean>) };
  return { scanned, parsed: byParsing(line) };
}

function agrees(line: string): Record<string, string | boolean> | undefined {
  const { scanned, parsed } = bothWays(line);
  expect(scanned).toEqual(parsed);
  return parsed;
}

const ID = '00000000-0000-4000-8000-00000000000a';
const NESTED = '00000000-0000-4000-8000-00000000000b';

describe('reading a record without building it', () => {
  it('reads the three fields an ordinary record carries', () => {
    const fields = agrees(
      JSON.stringify({
        parentUuid: NESTED,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        uuid: ID,
        timestamp: '2026-09-21T06:34:00.000Z',
      }),
    );
    expect(fields).toEqual({
      uuid: ID,
      type: 'assistant',
      timestamp: '2026-09-21T06:34:00.000Z',
    });
  });

  it('never takes a uuid quoted inside a tool result for the record it belongs to', () => {
    // The reason this is not a regex. A tool that printed a transcript, a diff of
    // one, or a foster summary puts other records' ids in the line.
    const fields = agrees(
      JSON.stringify({
        type: 'user',
        toolUseResult: { stdout: `{"uuid":"${NESTED}","type":"assistant"}` },
        uuid: ID,
        timestamp: '2026-09-21T06:34:00.000Z',
      }),
    );
    expect(fields!.uuid).toBe(ID);
    expect(fields!.type).toBe('user');
  });

  it('never takes a uuid from a nested object of its own', () => {
    const fields = agrees(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', uuid: NESTED }] },
        uuid: ID,
      }),
    );
    expect(fields).toEqual({ uuid: ID, type: 'user' });
  });

  it('is not fooled by a quote, a backslash or a brace inside a string', () => {
    agrees(
      JSON.stringify({
        type: 'user',
        message: { content: `a " quote, a \\ backslash, a { brace and "uuid":"${NESTED}"` },
        uuid: ID,
      }),
    );
    // A value ending in a backslash is the case an escape-blind scan gets wrong:
    // the closing quote looks escaped.
    agrees(JSON.stringify({ type: 'user', message: 'ends in a backslash \\', uuid: ID }));
    agrees(JSON.stringify({ type: 'user', message: '\\\\', uuid: ID }));
  });

  it('decodes an escape in one of the three fields rather than reporting it raw', () => {
    const fields = agrees(`{"type":"a\\u0062c","uuid":"${ID}"}`);
    expect(fields!.type).toBe('abc');
  });

  it('takes the last of a repeated key, as a parse does', () => {
    const fields = agrees(`{"uuid":"${NESTED}","type":"user","uuid":"${ID}"}`);
    expect(fields!.uuid).toBe(ID);
  });

  it('drops a repeated key whose later value is not a string, as a parse does', () => {
    const fields = agrees(`{"uuid":"${NESTED}","uuid":7,"type":"user"}`);
    expect(fields).toEqual({ type: 'user' });
  });

  it('ignores a field that is not a string at all', () => {
    agrees(`{"uuid":${JSON.stringify(ID)},"timestamp":null,"type":["user"]}`);
  });

  it('reads a record whose keys are spaced out', () => {
    agrees(`{ "type" : "user" , "uuid" : "${ID}" }`);
  });

  it('skips a line that is not one whole object', () => {
    for (const line of [
      '',
      '   ',
      'not json',
      `{"uuid":"${ID}"`, // a torn tail, which is what a killed write leaves
      `{"uuid":"${ID}"}}`,
      `{"uuid":"${ID}"} {"uuid":"${NESTED}"}`,
      `["${ID}"]`,
      `{"uuid":"unterminated`,
    ]) {
      expect(recordFields(line), line).toBeUndefined();
    }
  });

  it('reads a record with no fields of interest as a record with none', () => {
    expect(agrees('{"summary":"a title","leafUuid":"x"}')).toEqual({});
  });
});

describe('the two booleans a whole-file scan needs', () => {
  it('reads isApiErrorMessage and isSidechain as booleans, not strings', () => {
    const fields = agrees(
      JSON.stringify({
        type: 'assistant',
        uuid: ID,
        isApiErrorMessage: true,
        isSidechain: false,
        model: '<synthetic>',
      }),
    );
    expect(fields).toEqual({
      type: 'assistant',
      uuid: ID,
      isApiErrorMessage: true,
      isSidechain: false,
    });
  });

  it('takes the last of a repeated boolean key, as a parse does', () => {
    const fields = agrees(`{"isSidechain":true,"uuid":"${ID}","isSidechain":false}`);
    expect(fields).toEqual({ uuid: ID, isSidechain: false });
  });

  it('drops a repeated boolean key whose later value is not a boolean, as a parse does', () => {
    const fields = agrees(`{"isSidechain":true,"isSidechain":"x","uuid":"${ID}"}`);
    expect(fields).toEqual({ uuid: ID });
  });

  it('ignores the booleans when the record does not carry them', () => {
    expect(agrees(JSON.stringify({ type: 'user', uuid: ID }))).toEqual({ type: 'user', uuid: ID });
  });

  it('never takes an isApiErrorMessage quoted inside a tool result', () => {
    const fields = agrees(
      JSON.stringify({
        type: 'user',
        toolUseResult: { stdout: '{"isApiErrorMessage":true}' },
        uuid: ID,
      }),
    );
    expect(fields!.isApiErrorMessage).toBeUndefined();
  });
});

describe('what a field holds on to', () => {
  it('hands back an id that does not keep its record alive', () => {
    // The defect this pins cost a build. `line.slice(from, to)` answers with a
    // *sliced string* at 13 characters or more — a view that keeps the whole
    // parent alive — and a uuid is 36, so every id kept in a scan's Set pinned
    // the record it came from. Measured 21/09/2026: a dry `foster sweep` on this
    // store died at `Ineffective mark-compacts near heap limit` with 3.8 GB of
    // heap, where the parse it replaced had never come near it.
    //
    // Measured the same day, on the two readings side by side over 2000 lines of
    // 200 KB: viewing kept 395 MB live, copying kept 5 MB. The threshold below
    // sits between them with two orders of magnitude to spare, so this fails on
    // the defect and passes on the fix without depending on when a collection
    // happens to run.
    const LINES = 2000;
    const PAYLOAD = 200 * 1024;

    const before = process.memoryUsage().heapUsed;
    const ids: string[] = [];
    for (let n = 0; n < LINES; n++) {
      const id = `00000000-0000-4000-8000-0000000000${String(n % 100).padStart(2, '0')}`;
      // Built inside the loop and never kept: whatever stays live afterwards is
      // held by the ids, not by this.
      const line = `{"type":"user","text":"${'x'.repeat(PAYLOAD)}","uuid":"${id}"}`;
      const fields = recordFields(line);
      expect(fields!.uuid).toBe(id);
      ids.push(fields!.uuid!);
    }

    const heldMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    expect(ids).toHaveLength(LINES);
    expect(heldMb).toBeLessThan(100);
  });
});

describe('scanning a whole conversation', () => {
  it('counts the records, and the last answer, exactly as a parse of each line would', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-scan-'));
    const file = path.join(dir, 'conversation.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', uuid: ID, timestamp: '2026-09-21T06:00:00.000Z' }),
      // A tool result quoting another record: counted once, for its own id.
      JSON.stringify({
        type: 'assistant',
        uuid: NESTED,
        timestamp: '2026-09-21T06:10:00.000Z',
        toolUseResult: { stdout: `{"uuid":"ffffffff-0000-4000-8000-00000000000f"}` },
      }),
      // The app's own bookkeeping, which carries no uuid.
      JSON.stringify({ type: 'summary', summary: 'a title' }),
      // A click after the last answer: the last message, never the last answer.
      JSON.stringify({
        type: 'user',
        uuid: '00000000-0000-4000-8000-00000000000c',
        timestamp: '2026-09-21T07:00:00.000Z',
      }),
      '',
      '{ torn',
    ];
    writeFileSync(file, `${lines.join('\n')}\n`);

    const scan = scanConversation(file);
    expect([...scan.uuids].sort()).toEqual(
      [ID, NESTED, '00000000-0000-4000-8000-00000000000c'].sort(),
    );
    expect(scan.lastMessageAt).toBe(Date.parse('2026-09-21T07:00:00.000Z'));
    expect(scan.lastAssistantAt).toBe(Date.parse('2026-09-21T06:10:00.000Z'));
  });

  it('takes the max timestamp, not the last record in file order', () => {
    // `branches.ts` already says copies do not preserve file order; a scan
    // that took the last line as the newest was trusting an order this file
    // never promised.
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-scan-'));
    const file = path.join(dir, 'conversation.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', uuid: ID, timestamp: '2026-09-21T09:00:00.000Z' }),
      // Written later in the file, but an earlier moment.
      JSON.stringify({ type: 'user', uuid: NESTED, timestamp: '2026-09-21T05:00:00.000Z' }),
    ];
    writeFileSync(file, `${lines.join('\n')}\n`);

    const scan = scanConversation(file);
    expect(scan.lastMessageAt).toBe(Date.parse('2026-09-21T09:00:00.000Z'));
    expect(scan.lastAssistantAt).toBe(Date.parse('2026-09-21T09:00:00.000Z'));
  });

  it('never counts the app’s own usage-limit record as the last answer', () => {
    // The record the app writes in the model's own place when a usage limit
    // cuts the conversation off: `isApiErrorMessage: true`, model
    // `<synthetic>`. Scenario measured: a row opened from a `(stale…)` mark,
    // typed "continue", and hit the weekly limit before a real answer came
    // back — the branch pass read that as a fresh answer and called the row
    // diverged, archiving the row that actually held the work.
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-scan-'));
    const file = path.join(dir, 'conversation.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', uuid: ID, timestamp: '2026-09-21T06:00:00.000Z' }),
      JSON.stringify({ type: 'user', uuid: NESTED, timestamp: '2026-09-21T08:59:00.000Z' }),
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-00000000000d',
        timestamp: '2026-09-21T09:00:00.000Z',
        isApiErrorMessage: true,
        model: '<synthetic>',
        error: 'rate_limit',
      }),
    ];
    writeFileSync(file, `${lines.join('\n')}\n`);

    const scan = scanConversation(file);
    // The last thing said still moves — the limit record is a real message —
    // but it never counts as an answer.
    expect(scan.lastMessageAt).toBe(Date.parse('2026-09-21T09:00:00.000Z'));
    expect(scan.lastAssistantAt).toBe(Date.parse('2026-09-21T06:00:00.000Z'));
  });

  it('never counts a sidechain record as the last answer', () => {
    // A subagent's turn, not the main conversation's.
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-scan-'));
    const file = path.join(dir, 'conversation.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', uuid: ID, timestamp: '2026-09-21T06:00:00.000Z' }),
      JSON.stringify({
        type: 'assistant',
        uuid: NESTED,
        timestamp: '2026-09-21T09:00:00.000Z',
        isSidechain: true,
      }),
    ];
    writeFileSync(file, `${lines.join('\n')}\n`);

    const scan = scanConversation(file);
    expect(scan.lastAssistantAt).toBe(Date.parse('2026-09-21T06:00:00.000Z'));
  });

  it('reads a record that straddles the chunk boundary', () => {
    // The streamer reads a megabyte at a time, so a record longer than that is
    // assembled across reads; a scan that lost it would under-count a branch.
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-scan-'));
    const file = path.join(dir, 'conversation.jsonl');
    const big = 'x'.repeat(3 * 1024 * 1024);
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'assistant',
        message: { content: big },
        uuid: ID,
        timestamp: '2026-09-21T06:00:00.000Z',
      })}\n`,
    );

    const scan = scanConversation(file);
    expect([...scan.uuids]).toEqual([ID]);
    expect(scan.lastAssistantAt).toBe(Date.parse('2026-09-21T06:00:00.000Z'));
  });
});
