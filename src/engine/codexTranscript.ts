import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.js';
import type { CodexRecord } from '../store/codex.js';
import { detectOpener, isSyntheticPreamble, withoutPreamble } from './codexImport.js';

/**
 * Codex rollout -> Claude transcript records: the write half of issue #19.
 *
 * The inventory parser (`codexImport.ts`) reads the same rollouts but keeps only
 * counts — it never carries a tool call's arguments or a message's text out, on
 * purpose, because `--list` does not need them. This does, so it walks the raw
 * records itself rather than going through `CodexThread`, and produces one
 * newline-delimited Claude record per turn part, chained by `uuid`/`parentUuid`
 * the way a real transcript is.
 *
 * What it cannot do is make the result *replayable*. Codex tool calls do not map
 * onto Claude tools one-to-one (see `FIDELITY_NOTE`), and reasoning arrives as
 * opaque `encrypted_content` — so a tool call keeps its Codex name and its raw
 * arguments verbatim rather than being dressed up as a `Bash` or an `Edit` it is
 * not, and reasoning is counted, never invented. The record reads; it does not
 * resume.
 */

/** A single content block inside a Claude message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** One transcript record, in the shape the app appends to and foster reads. */
export interface TranscriptRecord {
  parentUuid: string | null;
  isSidechain: false;
  userType: 'external';
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  type: 'user' | 'assistant';
  message: ClaudeMessage;
  uuid: string;
  timestamp: string;
}

export interface ConvertedRollout {
  records: TranscriptRecord[];
  stats: {
    /** User turns opened — synthetic preambles never count. */
    turns: number;
    assistantMessages: number;
    toolCalls: number;
    /** Tool calls whose `*_output` never arrived. */
    unpairedToolCalls: number;
    /** Reasoning items, counted and not rendered. */
    reasoning: number;
  };
}

export interface ConvertOptions {
  /** The transcript's conversation id — the rollout's own id. */
  cliSessionId: string;
  /** Where the conversation ran, written onto every record. */
  cwd: string;
  gitBranch?: string;
}

/**
 * The opener stood in when a rollout has real assistant work but no message a
 * person typed — an automated or scheduled Codex run, whose only user record is
 * the injected context (`<environment_context>`, an AGENTS.md block) that
 * `withoutPreamble` strips to nothing. Dropping these would lose real work; a
 * transcript has to start with a user turn for the app to render it, so one is
 * opened, and it says plainly what it is rather than pretending to be the person.
 */
export const SYNTHETIC_OPENER =
  '(Imported from a Codex session that opened with injected context and no separate user message.)';

/** The text of a `*_output` record, whether it came as a string or content blocks. */
function outputText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (typeof block === 'string') parts.push(block);
      else if (typeof block === 'object' && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** The text of a `response_item` message's content blocks. */
function messageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * A tool call's arguments as Claude `input`. Kept honest rather than replayable:
 * a `function_call` carries a JSON `arguments` string, which is parsed to an
 * object when it is one; a `custom_tool_call` carries a free-form `input` string
 * (an `apply_patch` body, say), which is not JSON and is wrapped verbatim under
 * `raw` rather than forced into a shape it does not have.
 */
function toolInput(payload: Record<string, unknown>, kind: string): unknown {
  const rawField = kind === 'function_call' ? payload.arguments : payload.input;
  const raw = typeof rawField === 'string' ? rawField : '';
  if (raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // Not JSON — a patch body, a bare command. Keep it verbatim.
  }
  return { raw };
}

/**
 * Convert a rollout's raw records into Claude transcript records.
 *
 * Order is preserved and the `parentUuid` chain follows it, so opening the
 * result shows the conversation as it ran. A tool call becomes an assistant
 * `tool_use` block and its matching `*_output` a following user `tool_result`,
 * paired by `call_id` — the app pairs on `tool_use_id`, not adjacency, so the
 * reasoning and events Codex writes between them do not matter.
 */
export function rolloutToTranscript(
  records: readonly CodexRecord[],
  options: ConvertOptions,
): ConvertedRollout {
  const opener = detectOpener(records);
  const out: TranscriptRecord[] = [];
  let parentUuid: string | null = null;
  let started = false;
  let lastAssistantText: string | undefined;
  // call_id -> the tool_use id we minted, so an output can name its call.
  const toolIds = new Map<string, string>();

  const stats = {
    turns: 0,
    assistantMessages: 0,
    toolCalls: 0,
    unpairedToolCalls: 0,
    reasoning: 0,
  };
  const pending = new Set<string>();

  // Timestamps: a real one from the record when it has it, otherwise the last
  // one seen, and never going backwards — a chain the app reads left to right
  // must not carry a record dated before the one it follows.
  let lastTs = 0;
  let lastIso = '';
  const stamp = (record: CodexRecord): string => {
    const parsed = record.timestamp ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(parsed) && parsed >= lastTs) {
      lastTs = parsed;
      lastIso = new Date(parsed).toISOString();
    } else if (lastIso === '') {
      lastIso = new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
      lastTs = Date.parse(lastIso);
    }
    return lastIso;
  };

  const push = (type: 'user' | 'assistant', message: ClaudeMessage, record: CodexRecord): void => {
    const uuid = randomUUID();
    out.push({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: options.cwd,
      sessionId: options.cliSessionId,
      version: VERSION,
      ...(options.gitBranch !== undefined ? { gitBranch: options.gitBranch } : {}),
      type,
      message,
      uuid,
      timestamp: stamp(record),
    });
    parentUuid = uuid;
  };

  // Open a stand-in user turn for a rollout whose work has no human message in
  // front of it — see SYNTHETIC_OPENER. `stats.turns` is left at zero: there was
  // no real turn, and the count should say so.
  const openImplicit = (record: CodexRecord): void => {
    started = true;
    push('user', { role: 'user', content: SYNTHETIC_OPENER }, record);
  };

  const addAssistantText = (text: string, record: CodexRecord): void => {
    if (text === '') return;
    if (!started) openImplicit(record);
    // 0.151.0 answers as both a `role: assistant` message and an `agent_message`
    // with the same text; keep it once, exactly as the inventory parser does.
    if (text === lastAssistantText) return;
    lastAssistantText = text;
    stats.assistantMessages += 1;
    push('assistant', { role: 'assistant', content: [{ type: 'text', text }] }, record);
  };

  for (const record of records) {
    if (record.type === 'event_msg') {
      const payload = record.payload;
      const kind = payload?.type;
      if (kind === 'user_message' && opener === 'event_msg/user_message') {
        const text = typeof payload?.message === 'string' ? payload.message : '';
        if (!isSyntheticPreamble(text)) {
          started = true;
          lastAssistantText = undefined;
          stats.turns += 1;
          push('user', { role: 'user', content: withoutPreamble(text) }, record);
        }
      } else if (kind === 'agent_message') {
        addAssistantText(typeof payload?.message === 'string' ? payload.message : '', record);
      }
      continue;
    }

    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!payload) continue;
    const kind = typeof payload.type === 'string' ? payload.type : undefined;

    switch (kind) {
      case 'message': {
        if (payload.role === 'user' && opener === 'response_item/message') {
          const text = messageText(payload);
          if (!isSyntheticPreamble(text)) {
            started = true;
            lastAssistantText = undefined;
            stats.turns += 1;
            push('user', { role: 'user', content: withoutPreamble(text) }, record);
          }
        } else if (payload.role === 'assistant') {
          addAssistantText(messageText(payload), record);
        }
        break;
      }
      case 'agent_message': {
        addAssistantText(typeof payload.message === 'string' ? payload.message : '', record);
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        if (!started) openImplicit(record);
        const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
        const id = `toolu_${randomUUID().replace(/-/g, '')}`;
        if (callId) {
          toolIds.set(callId, id);
          pending.add(callId);
        }
        stats.toolCalls += 1;
        const name =
          typeof payload.name === 'string' && payload.name !== '' ? payload.name : 'tool';
        push(
          'assistant',
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id, name, input: toolInput(payload, kind) }],
          },
          record,
        );
        // A tool call ends any run of identical assistant text.
        lastAssistantText = undefined;
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
        const id = callId ? toolIds.get(callId) : undefined;
        if (!id) break;
        pending.delete(callId!);
        push(
          'user',
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: outputText(payload) }],
          },
          record,
        );
        lastAssistantText = undefined;
        break;
      }
      case 'reasoning': {
        stats.reasoning += 1;
        break;
      }
      default:
        break;
    }
  }

  stats.unpairedToolCalls = pending.size;
  return { records: out, stats };
}

/**
 * A title for a thread the parser could not title — an automated run with no
 * human turn (see SYNTHETIC_OPENER). The first thing the assistant said
 * describes the work better than the "(recovered conversation)" fallback, and
 * better than every such card wearing the same words.
 */
export function titleFromRecords(records: readonly TranscriptRecord[]): string | undefined {
  for (const record of records) {
    if (record.type !== 'assistant' || !Array.isArray(record.message.content)) continue;
    for (const block of record.message.content) {
      if (block.type === 'text' && block.text.trim() !== '') {
        const oneLine = block.text.trim().replace(/\s+/g, ' ');
        return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
      }
    }
  }
  return undefined;
}

/** Serialise records to the newline-delimited JSON a `.jsonl` transcript holds. */
export function serialiseTranscript(records: readonly TranscriptRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
