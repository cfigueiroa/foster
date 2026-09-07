import { describe, expect, it } from 'vitest';
import type { CodexRecord } from '../src/store/codex.js';
import {
  inventoryEntry,
  isSyntheticPreamble,
  parseCodexRollout,
} from '../src/engine/codexImport.js';

// Small builders for the record shapes codexImport.ts reads. Kept close to
// what tongtongtju/sessionbridge's types.ts documents (fetched and read while
// building this parser) rather than invented independently, since the point
// of the fixtures is to exercise the real branches the issue names.

function sessionMeta(cwd = '/repo'): CodexRecord {
  return {
    type: 'session_meta',
    payload: { id: '00000000-0000-4000-8000-00000000000a', cwd, originator: 'codex_cli_rs' },
  };
}

function userMessage(text: string): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

function assistantMessage(text: string): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

function agentMessageItem(text: string): CodexRecord {
  return { type: 'response_item', payload: { type: 'agent_message', message: text } };
}

function eventUserMessage(text: string): CodexRecord {
  return { type: 'event_msg', payload: { type: 'user_message', message: text } };
}

function functionCall(callId: string, name = 'shell'): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name, arguments: '{}' },
  };
}

function functionCallOutput(callId: string): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: 'ok' },
  };
}

function customToolCall(callId: string, name = 'apply_patch'): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: callId, name, input: '*** Update File: a.ts' },
  };
}

function customToolCallOutput(callId: string): CodexRecord {
  return {
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: callId, output: 'ok' },
  };
}

/** Reasoning always carries encrypted_content — opaque on purpose, never a real payload here. */
function reasoning(): CodexRecord {
  return { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'aaaa0000' } };
}

describe('isSyntheticPreamble', () => {
  it('recognises a message that is one XML element wrapping the whole text', () => {
    expect(isSyntheticPreamble('<environment_context>cwd: /repo</environment_context>')).toBe(true);
    expect(isSyntheticPreamble('<user_instructions>Be terse.</user_instructions>')).toBe(true);
  });

  it('leaves an ordinary sentence alone, even one that mentions a tag', () => {
    expect(isSyntheticPreamble('Please fix the <Button> component')).toBe(false);
    expect(isSyntheticPreamble('Rewrite src/foo.ts')).toBe(false);
  });
});

describe('parseCodexRollout', () => {
  it('opens a turn on response_item/message with role user', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Fix the failing test'),
      assistantMessage('Done.'),
    ]);
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]!.text).toBe('Fix the failing test');
    expect(thread.turns[0]!.assistantText).toEqual(['Done.']);
    expect(thread.title).toBe('Fix the failing test');
  });

  it('falls back to event_msg/user_message when no response_item/message with role user exists', () => {
    // The shape older Codex builds wrote, per the issue's cli_version table —
    // response_item/message never appears here at all.
    const thread = parseCodexRollout([
      sessionMeta(),
      eventUserMessage('Add a changelog entry'),
      assistantMessage('Added.'),
    ]);
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]!.text).toBe('Add a changelog entry');
  });

  it('does not fall back to event_msg/user_message when response_item/message is present', () => {
    // Both shapes in one file would be unusual, but the opener is decided once
    // for the whole rollout — an event_msg/user_message record must not also
    // open a turn once the newer shape has been seen.
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Real turn'),
      eventUserMessage('Should not open a second turn'),
    ]);
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]!.text).toBe('Real turn');
  });

  it('skips the XML-wrapped synthetic preamble Codex opens every thread with', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('<environment_context>cwd: /repo\nshell: bash</environment_context>'),
      userMessage('<user_instructions>Keep commits small.</user_instructions>'),
      userMessage('Actually fix the bug in src/parser.ts'),
      assistantMessage('Fixed.'),
    ]);
    // Three response_item/message(role:user) records went in; only the one a
    // person actually wrote should come out as a turn.
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]!.text).toBe('Actually fix the bug in src/parser.ts');
    expect(thread.title).toBe('Actually fix the bug in src/parser.ts');
  });

  it('titles the thread from the first real turn, never a preamble', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('<environment_context>only context</environment_context>'),
    ]);
    // No real turn at all: no title to offer, rather than the preamble's text.
    expect(thread.turns).toHaveLength(0);
    expect(thread.title).toBeUndefined();
  });

  it('pairs a function_call with its function_call_output by call_id', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Run the tests'),
      functionCall('call_1', 'shell'),
      functionCallOutput('call_1'),
    ]);
    expect(thread.toolCallCount).toBe(1);
    expect(thread.turns[0]!.toolCalls).toEqual([
      { callId: 'call_1', kind: 'function_call', name: 'shell', paired: true },
    ]);
  });

  it('pairs a custom_tool_call with its custom_tool_call_output by call_id', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Apply the patch'),
      customToolCall('call_2', 'apply_patch'),
      customToolCallOutput('call_2'),
    ]);
    expect(thread.toolCallCount).toBe(1);
    expect(thread.turns[0]!.toolCalls).toEqual([
      { callId: 'call_2', kind: 'custom_tool_call', name: 'apply_patch', paired: true },
    ]);
  });

  it('pairs across the two shapes: the map is keyed on call_id alone', () => {
    // Not a shape Codex is known to mix, but the pairing map must not care —
    // the issue asks for calls "paired... across function_call and
    // custom_tool_call", and a shape-aware map would silently miss this.
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Do the thing'),
      functionCall('call_3', 'shell'),
      customToolCallOutput('call_3'),
    ]);
    expect(thread.turns[0]!.toolCalls[0]!.paired).toBe(true);
  });

  it('leaves a tool call unpaired when no output ever arrives', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Start something long-running'),
      functionCall('call_4', 'shell'),
    ]);
    expect(thread.toolCallCount).toBe(1);
    expect(thread.turns[0]!.toolCalls[0]!.paired).toBe(false);
  });

  it('counts reasoning without rendering its (encrypted, unverifiable) content', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('Think it through'),
      reasoning(),
      reasoning(),
      assistantMessage('Here is the answer.'),
    ]);
    expect(thread.reasoningCount).toBe(2);
    expect(thread.turns[0]!.reasoningCount).toBe(2);
    // Nothing about the encrypted payload appears anywhere in the result.
    expect(JSON.stringify(thread)).not.toContain('aaaa0000');
  });

  it('counts a reasoning item that arrives before any real turn has opened', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('<environment_context>context only</environment_context>'),
      reasoning(),
    ]);
    expect(thread.reasoningCount).toBe(1);
    expect(thread.turns).toHaveLength(0);
  });

  it('reads assistant text from response_item/agent_message, the 0.151.0 shape sessionbridge had no case for', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('What is the plan?'),
      agentMessageItem('Ship the read-only slice first.'),
    ]);
    expect(thread.turns[0]!.assistantText).toEqual(['Ship the read-only slice first.']);
  });

  it('does not double-count the same answer when it arrives as both message and agent_message', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('What is the plan?'),
      assistantMessage('Ship the read-only slice first.'),
      agentMessageItem('Ship the read-only slice first.'),
    ]);
    expect(thread.turns[0]!.assistantText).toEqual(['Ship the read-only slice first.']);
  });

  it('separates tool calls made in different turns', () => {
    const thread = parseCodexRollout([
      sessionMeta(),
      userMessage('First ask'),
      functionCall('call_5'),
      functionCallOutput('call_5'),
      userMessage('Second ask'),
      customToolCall('call_6'),
    ]);
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0]!.toolCalls).toHaveLength(1);
    expect(thread.turns[1]!.toolCalls).toHaveLength(1);
    expect(thread.toolCallCount).toBe(2);
  });

  it('clips a long title to one line at a bounded length', () => {
    const long = 'x'.repeat(200);
    const thread = parseCodexRollout([sessionMeta(), userMessage(`${long}\nsecond line`)]);
    expect(thread.title).toBeDefined();
    expect(thread.title!.length).toBeLessThanOrEqual(80);
    expect(thread.title).not.toContain('\n');
  });
});

describe('inventoryEntry', () => {
  it('combines rollout meta and a parsed thread into one printable row', () => {
    const thread = parseCodexRollout([
      sessionMeta('/work/project'),
      userMessage('Do the thing'),
      functionCall('call_7'),
      functionCallOutput('call_7'),
    ]);
    const entry = inventoryEntry(
      {
        file: '/codex/sessions/2026/09/07/rollout-1.jsonl',
        id: '00000000-0000-4000-8000-00000000000a',
        cwd: '/work/project',
        cliVersion: '0.151.0',
        mtimeMs: 1_700_000_000_000,
      },
      thread,
    );
    expect(entry).toEqual({
      file: '/codex/sessions/2026/09/07/rollout-1.jsonl',
      id: '00000000-0000-4000-8000-00000000000a',
      cwd: '/work/project',
      cliVersion: '0.151.0',
      title: 'Do the thing',
      turnCount: 1,
      toolCallCount: 1,
      reasoningCount: 0,
      updatedAt: 1_700_000_000_000,
    });
  });
});
