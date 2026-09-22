import { describe, expect, it } from 'vitest';
import type { CodexRecord } from '../src/store/codex.js';
import {
  rolloutToTranscript,
  serialiseTranscript,
  titleFromRecords,
  SYNTHETIC_OPENER,
  type ContentBlock,
  type TranscriptRecord,
} from '../src/engine/codexTranscript.js';

// Builders for the raw record shapes the writer walks — the same shapes
// codexImport.test.ts uses, plus the top-level `timestamp` the writer reads.
function userMsg(text: string, timestamp?: string): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    ...(timestamp ? { timestamp } : {}),
  };
}
function assistantMsg(text: string, timestamp?: string): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ...(timestamp ? { timestamp } : {}),
  };
}
function agentMsg(text: string): CodexRecord {
  return { type: 'response_item', payload: { type: 'agent_message', message: text } };
}
function fnCall(callId: string, name = 'shell', args = '{"command":["ls"]}'): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name, arguments: args },
  };
}
function fnOut(callId: string, output: unknown = 'ok'): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output },
  };
}
function customCall(
  callId: string,
  name = 'apply_patch',
  input = '*** Update File: a.ts',
): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: callId, name, input },
  };
}
function customOut(callId: string, output: unknown = 'patched'): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: callId, output },
  };
}
function reasoning(): CodexRecord {
  return { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'aaaa0000' } };
}

const OPTS = { cliSessionId: 'sess-1', cwd: '/repo/demo' };

function blocks(record: TranscriptRecord): ContentBlock[] {
  return Array.isArray(record.message.content) ? record.message.content : [];
}

describe('rolloutToTranscript', () => {
  it('turns a user message into a user record and an assistant one into an assistant record', () => {
    const { records, stats } = rolloutToTranscript(
      [userMsg('hello'), assistantMsg('hi there')],
      OPTS,
    );
    expect(records.map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(records[0]!.message.content).toBe('hello');
    expect(blocks(records[1]!)).toEqual([{ type: 'text', text: 'hi there' }]);
    expect(stats.turns).toBe(1);
    expect(stats.assistantMessages).toBe(1);
  });

  it('pairs a tool call with its output by call_id, across both call shapes', () => {
    const { records, stats } = rolloutToTranscript(
      [userMsg('go'), fnCall('c1'), fnOut('c1'), customCall('c2'), customOut('c2')],
      OPTS,
    );
    const toolUses = records.flatMap((r) => blocks(r).filter((b) => b.type === 'tool_use'));
    const toolResults = records.flatMap((r) => blocks(r).filter((b) => b.type === 'tool_result'));
    expect(toolUses).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    // Each result names a tool_use that was actually emitted.
    const useIds = new Set(toolUses.map((b) => (b as { id: string }).id));
    for (const result of toolResults) {
      expect(useIds.has((result as { tool_use_id: string }).tool_use_id)).toBe(true);
    }
    expect(stats.toolCalls).toBe(2);
    expect(stats.unpairedToolCalls).toBe(0);
  });

  it('counts a tool call whose output never arrived as unpaired', () => {
    const { stats } = rolloutToTranscript([userMsg('go'), fnCall('c1')], OPTS);
    expect(stats.toolCalls).toBe(1);
    expect(stats.unpairedToolCalls).toBe(1);
  });

  it('counts reasoning without emitting a record for it', () => {
    const { records, stats } = rolloutToTranscript(
      [userMsg('go'), reasoning(), assistantMsg('done')],
      OPTS,
    );
    expect(stats.reasoning).toBe(1);
    expect(records).toHaveLength(2); // the user and the assistant, never the reasoning
    expect(records.every((r) => JSON.stringify(r).indexOf('encrypted') === -1)).toBe(true);
  });

  it('chains records by parentUuid, the root first', () => {
    const { records } = rolloutToTranscript(
      [userMsg('go'), assistantMsg('ok'), fnCall('c1'), fnOut('c1')],
      OPTS,
    );
    expect(records[0]!.parentUuid).toBeNull();
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.parentUuid).toBe(records[i - 1]!.uuid);
    }
    expect(new Set(records.map((r) => r.uuid)).size).toBe(records.length); // all distinct
  });

  it('skips a synthetic preamble and opens the first real turn instead', () => {
    const { records, stats } = rolloutToTranscript(
      [
        userMsg('<environment_context>cwd: /repo</environment_context>'),
        userMsg('real question'),
        assistantMsg('a'),
      ],
      OPTS,
    );
    expect(stats.turns).toBe(1);
    expect(records[0]!.message.content).toBe('real question');
  });

  it('peels an injected AGENTS.md block so the real message is the turn', () => {
    const injected =
      '# AGENTS.md instructions for /repo\nDo the thing.\n<environment_context>x</environment_context>';
    const { records, stats } = rolloutToTranscript(
      [userMsg(injected), userMsg('actual task'), assistantMsg('a')],
      OPTS,
    );
    expect(stats.turns).toBe(1);
    expect(records[0]!.message.content).toBe('actual task');
  });

  it('opens a labelled synthetic turn when work has no human message', () => {
    // An automated run: only injected context as "user", then real assistant work.
    const { records, stats } = rolloutToTranscript(
      [
        userMsg('<environment_context>x</environment_context>'),
        assistantMsg('working'),
        fnCall('c1'),
        fnOut('c1'),
      ],
      OPTS,
    );
    expect(stats.turns).toBe(0); // no real human turn
    expect(records[0]!.type).toBe('user');
    expect(records[0]!.message.content).toBe(SYNTHETIC_OPENER);
    expect(records.some((r) => blocks(r).some((b) => b.type === 'tool_use'))).toBe(true);
  });

  it('keeps a repeated assistant answer once (message and agent_message duplicate)', () => {
    const { records } = rolloutToTranscript(
      [userMsg('go'), assistantMsg('same'), agentMsg('same')],
      OPTS,
    );
    const texts = records.filter((r) => r.type === 'assistant');
    expect(texts).toHaveLength(1);
  });

  it('carries cwd and sessionId on every record and never lets time go backwards', () => {
    const { records } = rolloutToTranscript(
      [userMsg('go', '2026-09-01T10:00:00.000Z'), assistantMsg('ok', '2026-09-01T09:00:00.000Z')],
      OPTS,
    );
    expect(records.every((r) => r.cwd === '/repo/demo' && r.sessionId === 'sess-1')).toBe(true);
    // The assistant's own stamp is earlier; the chain must not regress.
    expect(Date.parse(records[1]!.timestamp)).toBeGreaterThanOrEqual(
      Date.parse(records[0]!.timestamp),
    );
  });

  it('parses a JSON tool argument and wraps a non-JSON one verbatim', () => {
    const { records } = rolloutToTranscript(
      [
        userMsg('go'),
        fnCall('c1', 'shell', '{"command":["ls"]}'),
        fnOut('c1'),
        customCall('c2', 'apply_patch', 'raw patch body'),
        customOut('c2'),
      ],
      OPTS,
    );
    const uses = records.flatMap((r) => blocks(r)).filter((b) => b.type === 'tool_use') as {
      name: string;
      input: unknown;
    }[];
    expect(uses[0]!.input).toEqual({ command: ['ls'] });
    expect(uses[1]!.input).toEqual({ raw: 'raw patch body' });
  });

  it('reads a tool output whether it came as a string or content blocks', () => {
    const { records } = rolloutToTranscript(
      [userMsg('go'), fnCall('c1'), fnOut('c1', [{ type: 'text', text: 'blocky' }])],
      OPTS,
    );
    const result = records.flatMap((r) => blocks(r)).find((b) => b.type === 'tool_result') as {
      content: string;
    };
    expect(result.content).toBe('blocky');
  });
});

describe('serialiseTranscript', () => {
  it('writes one JSON object per line, newline-terminated', () => {
    const { records } = rolloutToTranscript([userMsg('go'), assistantMsg('ok')], OPTS);
    const text = serialiseTranscript(records);
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    expect(text.endsWith('\n')).toBe(true);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('is empty for no records', () => {
    expect(serialiseTranscript([])).toBe('');
  });
});

describe('titleFromRecords', () => {
  it('takes the first assistant line, clipped', () => {
    const { records } = rolloutToTranscript(
      [
        userMsg('<environment_context>x</environment_context>'),
        assistantMsg('Doing the automated thing now'),
      ],
      OPTS,
    );
    expect(titleFromRecords(records)).toBe('Doing the automated thing now');
  });

  it('is undefined when nothing was said', () => {
    const { records } = rolloutToTranscript([userMsg('just a question')], OPTS);
    expect(titleFromRecords(records)).toBeUndefined();
  });
});
