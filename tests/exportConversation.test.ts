import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readConversationRecords,
  renderConversation,
  renderHtml,
  renderJsonl,
  renderMarkdown,
} from '../src/engine/exportConversation.js';

function userRecord(uuid: string, text: string, when: string): string {
  return JSON.stringify({
    uuid,
    type: 'user',
    timestamp: when,
    message: { role: 'user', content: text },
  });
}

function assistantRecord(uuid: string, text: string, when: string): string {
  return JSON.stringify({
    uuid,
    type: 'assistant',
    timestamp: when,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function toolUseRecord(uuid: string, name: string, when: string): string {
  return JSON.stringify({
    uuid,
    type: 'assistant',
    timestamp: when,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name, input: { path: 'a.ts' } }],
    },
  });
}

/** The app's own bookkeeping — no uuid, must never appear in a render. */
const META = JSON.stringify({ type: 'custom-title', customTitle: '↪ Work' });

function writeFile(records: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'foster-export-'));
  const file = path.join(dir, 'transcript.jsonl');
  writeFileSync(file, `${records.join('\n')}\n`, 'utf8');
  return file;
}

describe('readConversationRecords', () => {
  it('skips a file that vanished (ENOENT) rather than throwing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-export-'));
    const gone = path.join(dir, 'gone.jsonl');
    const file = writeFile([userRecord('u1', 'hello', '2026-09-01T00:00:00.000Z')]);

    expect(readConversationRecords([gone, file])).toHaveLength(1);
  });

  it('throws, naming the file, when a file exists but cannot be read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-export-'));
    const asDir = path.join(dir, 'transcript.jsonl');
    mkdirSync(asDir);

    expect(() => readConversationRecords([asDir])).toThrow(asDir);
  });

  it('reads user and assistant turns in timeline order', () => {
    const file = writeFile([
      META,
      userRecord('u1', 'hello', '2026-09-01T00:00:00.000Z'),
      assistantRecord('a1', 'hi there', '2026-09-01T00:00:01.000Z'),
    ]);

    const records = readConversationRecords([file]);
    expect(records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
  });

  it('unions two files of one conversation and drops the duplicate uuid', () => {
    const shared = userRecord('shared', 'shared turn', '2026-09-01T00:00:00.000Z');
    const first = writeFile([
      shared,
      assistantRecord('only-first', 'a', '2026-09-01T00:00:01.000Z'),
    ]);
    const second = writeFile([
      shared,
      assistantRecord('only-second', 'b', '2026-09-01T00:00:02.000Z'),
    ]);

    const records = readConversationRecords([first, second]);
    expect(records.map((r) => r.uuid).sort()).toEqual(
      ['only-first', 'only-second', 'shared'].sort(),
    );
  });

  it('orders by timestamp even when a later file is read first', () => {
    const early = writeFile([
      assistantRecord('later-read-earlier-ts', 'early', '2026-09-01T00:00:00.000Z'),
    ]);
    const late = writeFile([assistantRecord('read-first', 'late', '2026-09-01T00:00:05.000Z')]);

    const records = readConversationRecords([late, early]);
    expect(records.map((r) => r.uuid)).toEqual(['later-read-earlier-ts', 'read-first']);
  });

  it('drops the app’s own bookkeeping records, which carry no uuid', () => {
    const file = writeFile([META, userRecord('u1', 'hi', '2026-09-01T00:00:00.000Z')]);
    const records = readConversationRecords([file]);
    expect(records).toHaveLength(1);
  });

  it('skips a torn or malformed line without losing the rest of the file', () => {
    const file = writeFile([
      userRecord('u1', 'hi', '2026-09-01T00:00:00.000Z'),
      '{not valid json',
      assistantRecord('a1', 'hello back', '2026-09-01T00:00:01.000Z'),
    ]);
    const records = readConversationRecords([file]);
    expect(records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
  });
});

describe('renderMarkdown', () => {
  it('shows user/assistant turns as headings and tool calls as one line', () => {
    const file = writeFile([
      userRecord('u1', 'please fix the bug', '2026-09-01T00:00:00.000Z'),
      toolUseRecord('t1', 'Edit', '2026-09-01T00:00:01.000Z'),
      assistantRecord('a1', 'fixed it', '2026-09-01T00:00:02.000Z'),
    ]);
    const records = readConversationRecords([file]);

    const md = renderMarkdown(records, { cliSessionId: 'convo-1', title: 'Bug fix', cwd: '/work' });

    expect(md).toContain('# Bug fix');
    expect(md).toContain('- id: convo-1');
    expect(md).toContain('- cwd: /work');
    expect(md).toContain('### User');
    expect(md).toContain('please fix the bug');
    expect(md).toContain('> tool: Edit');
    expect(md).toContain('### Assistant');
    expect(md).toContain('fixed it');
    // One line per tool call, not the raw input dumped alongside it.
    expect(md).not.toContain('a.ts');
  });

  it('leaves out a turn whose only content this render passes over', () => {
    const file = writeFile([
      JSON.stringify({
        uuid: 'thinking-only',
        type: 'assistant',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      }),
    ]);
    const records = readConversationRecords([file]);
    const md = renderMarkdown(records, { cliSessionId: 'convo-1' });
    expect(md).not.toContain('###');
  });
});

describe('renderHtml', () => {
  it('is self-contained and escapes message text', () => {
    const file = writeFile([
      userRecord('u1', '<script>alert(1)</script>', '2026-09-01T00:00:00.000Z'),
    ]);
    const records = readConversationRecords([file]);

    const html = renderHtml(records, { cliSessionId: 'convo-1', title: 'A <b> title' });

    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt; title');
    // No external resource: every rule lives in an inline <style>.
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/<script src=/);
  });
});

describe('renderJsonl', () => {
  it('passes every record through, deduplicated and ordered, one per line', () => {
    const file = writeFile([
      userRecord('u1', 'hi', '2026-09-01T00:00:00.000Z'),
      assistantRecord('a1', 'hello', '2026-09-01T00:00:01.000Z'),
    ]);
    const records = readConversationRecords([file]);

    const jsonl = renderJsonl(records);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).uuid).toBe('u1');
    expect(JSON.parse(lines[1]!).uuid).toBe('a1');
  });

  it('renders an empty conversation as an empty string', () => {
    expect(renderJsonl([])).toBe('');
  });
});

describe('renderConversation', () => {
  it('dispatches on format', () => {
    const file = writeFile([userRecord('u1', 'hi', '2026-09-01T00:00:00.000Z')]);
    const records = readConversationRecords([file]);
    const meta = { cliSessionId: 'convo-1' };

    expect(renderConversation(records, meta, 'md')).toContain('### User');
    expect(renderConversation(records, meta, 'html')).toContain('<!doctype html>');
    expect(JSON.parse(renderConversation(records, meta, 'jsonl').trim()).uuid).toBe('u1');
  });
});
