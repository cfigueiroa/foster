import type { CodexRecord, CodexRolloutMeta } from '../store/codex.js';

/**
 * Codex rollout -> normalised turns.
 *
 * This is the parser half of issue #19's first, read-only slice: it counts
 * what a rollout holds, it does not write a Claude transcript from it. See
 * `FIDELITY_NOTE` below for the reason the eventual write half cannot be a
 * faithful round-trip either.
 *
 * `tongtongtju/sessionbridge`'s `codex-parser.ts` was read for its shapes (see
 * the issue) and its `event_msg/user_message` turn-opener is kept as the
 * fallback here, but on its own it is measured broken: on rollouts written
 * this month by current Codex builds it opens 0 of 16 turns for cli_version
 * 0.151.0, because that build opens a turn with `response_item/message`
 * (`role: "user"`) instead — the primary case this parser checks first.
 */

export interface CodexToolCall {
  callId: string;
  /**
   * Which record shape opened the call. Both exist in the corpus (measured at
   * roughly 53%/47% function_call/custom_tool_call) and neither maps onto one
   * Claude tool cleanly — see `FIDELITY_NOTE`.
   */
  kind: 'function_call' | 'custom_tool_call';
  name?: string;
  /** Whether the matching `*_output` record arrived before the rollout ended. */
  paired: boolean;
}

export interface CodexTurn {
  /** What the user actually typed — never a synthetic preamble; see `isSyntheticPreamble`. */
  text: string;
  assistantText: string[];
  toolCalls: CodexToolCall[];
  reasoningCount: number;
}

export interface CodexThread {
  turns: CodexTurn[];
  /** Every tool call in the rollout, including any opened before the first real turn. */
  toolCallCount: number;
  /**
   * Every reasoning item in the rollout. Reasoning arrives as `encrypted_content`
   * — opaque, and not ours to decrypt or guess at — so it is counted, never
   * rendered, exactly as the issue asks.
   */
  reasoningCount: number;
  /** The first real turn's opening line, trimmed and clipped. Absent when the rollout holds no real turn at all. */
  title?: string;
}

/**
 * Codex opens every thread with synthetic user records the person never typed
 * — `<environment_context>`, `<user_instructions>` and others sharing the same
 * shape: the whole message is one XML element. Opening a turn on one titles
 * the thread `<environment_context>` and inflates the turn count by one;
 * measured on a live probe, skipping them moved the title to the first human
 * sentence and dropped the turn count from 4 to 3. Detected structurally
 * (a single matching tag wraps the whole trimmed message) rather than by
 * naming every tag Codex might use, since "and friends" is an open set.
 */
const SYNTHETIC_PREAMBLE = /^<([a-zA-Z][\w-]*)>[\s\S]*<\/\1>\s*$/;

export function isSyntheticPreamble(text: string): boolean {
  return SYNTHETIC_PREAMBLE.test(text.trim());
}

/** How long a title is allowed to run before it is clipped for display. */
const TITLE_LIMIT = 80;

function clipTitle(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length > TITLE_LIMIT ? `${oneLine.slice(0, TITLE_LIMIT - 1)}…` : oneLine;
}

/** Text out of a `response_item` message's content blocks — `input_text` for a user turn, `output_text` for an assistant one. */
function blockText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

type TurnOpener = 'response_item/message' | 'event_msg/user_message';

/**
 * Which record shape this rollout uses to open a turn.
 *
 * Decided once per rollout rather than per record: the two shapes belong to
 * different Codex builds (see the cli_version table in the issue), never mixed
 * within one file, so the first `response_item/message` with `role: "user"`
 * settles it for the whole read. Its absence falls back to the older
 * `event_msg/user_message` shape.
 */
function detectOpener(records: readonly CodexRecord[]): TurnOpener {
  for (const record of records) {
    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!payload) continue;
    if (payload.type === 'message' && payload.role === 'user') return 'response_item/message';
  }
  return 'event_msg/user_message';
}

/** Parse a rollout's records into normalised turns. Nothing here writes anything. */
export function parseCodexRollout(records: readonly CodexRecord[]): CodexThread {
  const opener = detectOpener(records);

  const turns: CodexTurn[] = [];
  let currentTurn: CodexTurn | undefined;
  // Keyed on call_id alone, shared between function_call and custom_tool_call:
  // the issue asks for calls to be "paired... across" both shapes, and a single
  // map does that for free — pairing never looks at which shape opened the call.
  const pending = new Map<string, CodexToolCall>();
  let toolCallCount = 0;
  let reasoningCount = 0;

  const openTurn = (text: string): void => {
    if (isSyntheticPreamble(text)) {
      // Not a real turn: nothing before the first genuine one is misattributed
      // to a synthetic preamble either, so records that follow with no open
      // turn (see below) are simply uncounted-as-turn-content, same as before
      // any turn opens at all.
      currentTurn = undefined;
      return;
    }
    currentTurn = { text: text.trim(), assistantText: [], toolCalls: [], reasoningCount: 0 };
    turns.push(currentTurn);
  };

  const addAssistantText = (text: string | undefined): void => {
    if (!currentTurn || !text) return;
    // 0.151.0 answers with both a `role: "assistant"` message and a separate
    // `agent_message` record carrying the same text (see the module comment).
    // Kept once: a duplicate does not change a turn or tool-call count, and
    // --list never renders this text at all.
    if (!currentTurn.assistantText.includes(text)) currentTurn.assistantText.push(text);
  };

  for (const record of records) {
    if (record.type === 'event_msg') {
      const payload = record.payload;
      const kind = payload?.type;
      if (kind === 'user_message' && opener === 'event_msg/user_message') {
        openTurn(typeof payload?.message === 'string' ? payload.message : '');
      } else if (kind === 'agent_message') {
        addAssistantText(typeof payload?.message === 'string' ? payload.message : undefined);
      }
      // Every other event_msg kind (token_count, task_started, task_complete, ...)
      // is UI bookkeeping with no turn content.
      continue;
    }

    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!payload) continue;
    // Narrowed to a plain string first rather than switched on directly: the
    // field reads as `unknown` off `Record<string, unknown>`, and every other
    // read in this file goes through the same typeof check before trusting a
    // value's shape.
    const kind = typeof payload.type === 'string' ? payload.type : undefined;

    switch (kind) {
      case 'message': {
        if (payload.role === 'user' && opener === 'response_item/message') {
          openTurn(blockText(payload));
        } else if (payload.role === 'assistant') {
          addAssistantText(blockText(payload) || undefined);
        }
        // `role: "developer"` instructions carry no turn content of their own.
        break;
      }
      case 'agent_message': {
        // The response_item counterpart the issue's probe found the old
        // parser had no case for at all.
        const text = payload.message;
        addAssistantText(typeof text === 'string' ? text : undefined);
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
        const call: CodexToolCall = {
          callId: callId ?? `unlinked-${toolCallCount}`,
          kind,
          ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
          paired: false,
        };
        toolCallCount++;
        currentTurn?.toolCalls.push(call);
        if (callId) pending.set(callId, call);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
        const open = callId ? pending.get(callId) : undefined;
        if (open && callId) {
          open.paired = true;
          pending.delete(callId);
        }
        break;
      }
      case 'reasoning': {
        reasoningCount++;
        if (currentTurn) currentTurn.reasoningCount++;
        break;
      }
      default:
        // web_search_call and anything future: no turn content this inventory counts.
        break;
    }
  }

  return {
    turns,
    toolCallCount,
    reasoningCount,
    ...(turns[0] !== undefined ? { title: clipTitle(turns[0].text) } : {}),
  };
}

/** One thread's inventory row — what `foster import-codex --list` prints, and nothing it would need to write. */
export interface CodexInventoryEntry {
  file: string;
  id: string;
  cwd?: string;
  cliVersion?: string;
  title?: string;
  turnCount: number;
  toolCallCount: number;
  reasoningCount: number;
  updatedAt: number;
}

export function inventoryEntry(meta: CodexRolloutMeta, thread: CodexThread): CodexInventoryEntry {
  return {
    file: meta.file,
    id: meta.id,
    ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
    ...(meta.cliVersion !== undefined ? { cliVersion: meta.cliVersion } : {}),
    ...(thread.title !== undefined ? { title: thread.title } : {}),
    turnCount: thread.turns.length,
    toolCallCount: thread.toolCallCount,
    reasoningCount: thread.reasoningCount,
    updatedAt: meta.mtimeMs,
  };
}

/**
 * The fidelity limit that must follow this inventory wherever a person reads
 * it: neither tool-call shape round-trips to a specific Claude tool. `Grep`
 * and `Bash` both collapse to `exec_command` on the way in, so the direction
 * back is a guess, and an `apply_patch` argument is not a valid `Edit` input
 * at all. A rollout converted from this inventory would be a readable record,
 * not a replayable one — the write half of this issue is blocked partly on
 * deciding what to do about that.
 */
export const FIDELITY_NOTE =
  'Tool calls do not round-trip: Grep and Bash both collapse to exec_command, and ' +
  'apply_patch is not a valid Edit input. A converted transcript would be a readable ' +
  'record, not a replayable one.';
