import pc from 'picocolors';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { loadAgentSdk } from './sdk.js';
import { buildServer, SERVER_NAME } from './server.js';
import type { AgentToolContext } from './tools.js';

/**
 * `foster agent` — one task, one headless Claude run, foster's operations as
 * its only tools.
 *
 * The shape mirrors how Claude Desktop itself runs Code sessions: the host
 * process (here, foster) spawns the agent and serves it an in-process MCP
 * server over the same stdio pair. There is no endpoint into the app's own
 * internal servers, so foster reproduces the pattern rather than plugging in.
 */

export interface AgentRunOptions {
  task: string;
  store: StoreLayout;
  ledger: Ledger;
  /** True only when the user passed --yes; the model can never turn this on. */
  allowWrites: boolean;
  model?: string;
  maxTurns?: number;
}

const SYSTEM_PROMPT = `You are the agent behind \`foster agent\`, operating foster — a CLI that makes
Claude Desktop Code sessions from a previous local account visible in the current account's
sidebar, non-destructively.

Domain facts you can rely on:
- A Code session is a small JSON card in the store, bound to an account only by directory path.
  The conversation itself is a separate transcript file, account-agnostic, shared by every card
  that points at it (cliSessionId).
- Fostering copies a card into the current account under a fresh session id; originals are never
  modified. Returning deletes only what foster wrote. Both are recorded in foster's own ledger.
- The sidebar is built when Claude Desktop starts: changes appear only after an app restart.
- Mutations are dry runs unless the user started foster agent with --yes AND you pass apply.
  When a result says writes are disabled, report that to the user instead of retrying.
- Never advise deleting fostered sessions in the app's UI; return_fosterings is the way back.

Work with the tools you were given; report counts and outcomes plainly, and quote session titles
rather than raw uuids when both are available.`;

/** Runs the task and returns the process exit code. */
export async function runAgent(options: AgentRunOptions): Promise<number> {
  const sdk = await loadAgentSdk();

  const ctx: AgentToolContext = {
    store: options.store,
    ledger: options.ledger,
    allowWrites: options.allowWrites,
  };
  const { server, allowedTools } = buildServer(sdk, ctx);

  const queryOptions: Options = {
    mcpServers: { [SERVER_NAME]: server },
    // No built-in tools: the agent's whole world is the session-management
    // server. What it cannot do, it cannot be prompt-injected into doing.
    tools: [],
    allowedTools,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: options.maxTurns ?? 50,
    ...(options.model ? { model: options.model } : {}),
  };

  let exitCode = 1;
  for await (const message of sdk.query({ prompt: options.task, options: queryOptions })) {
    exitCode = render(message, exitCode);
  }
  return exitCode;
}

/** Prints what matters from the stream; returns the exit code so far. */
function render(message: SDKMessage, exitCode: number): number {
  if (message.type === 'system' && message.subtype === 'init') {
    console.log(pc.dim(`model ${message.model} — ${message.tools.length} tools`));
    return exitCode;
  }

  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(block.text);
      } else if (block.type === 'tool_use') {
        console.log(pc.dim(`→ ${shortToolName(block.name)} ${previewArgs(block.input)}`));
      }
    }
    return exitCode;
  }

  if (message.type === 'result') {
    if (message.subtype === 'success') {
      console.log(
        pc.dim(
          `\n${message.num_turns} turn(s), ${(message.duration_ms / 1000).toFixed(1)}s` +
            (message.total_cost_usd ? `, $${message.total_cost_usd.toFixed(4)}` : ''),
        ),
      );
      return message.is_error ? 1 : 0;
    }
    console.error(pc.red(`\nThe agent stopped: ${message.subtype.replace(/_/g, ' ')}`));
    if ('errors' in message && message.errors.length > 0) {
      for (const error of message.errors) console.error(pc.red(`  ${error}`));
    }
    return 1;
  }

  return exitCode;
}

function shortToolName(name: string): string {
  const prefix = `mcp__${SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function previewArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const text = JSON.stringify(input);
  if (text === '{}') return '';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
