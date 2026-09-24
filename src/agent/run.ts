import pc from 'picocolors';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { loadAgentSdk } from './sdk.js';
import { buildServer, SERVER_NAME } from './server.js';
import type { AgentToolContext } from './tools.js';

/** Read-only built-ins kept in reach either way — the same trio a gated run falls back to. */
const READ_ONLY_BUILTINS = ['Read', 'Glob', 'Grep'];

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

export const SYSTEM_PROMPT = `You are the agent behind \`foster agent\`, operating foster — a CLI that makes
Claude Desktop Code sessions from a previous local account visible in the current account's
sidebar, non-destructively.

Domain facts you can rely on:
- A Code session is a small JSON card in the store, bound to an account only by directory path.
  The conversation itself is a separate transcript file, account-agnostic, shared by every card
  that points at it (cliSessionId).
- Fostering copies a card into the current account under a fresh session id; originals are never
  modified. Returning deletes only what foster wrote. Both are recorded in foster's own ledger.
- The sidebar is built when Claude Desktop starts: changes appear only after an app restart.
- Mutations via the foster_session_mgmt tools are dry runs unless the user started foster agent
  with --yes AND you pass apply. When a result says writes are disabled, report that to the user
  instead of retrying.
- Never advise deleting fostered sessions in the app's UI; return_fosterings is the way back.
- "Bring everything here" is sweep_everything, not foster_sessions: foster_sessions leaves
  archived sessions behind (on one real store, 15 offered against 141) and cannot reach
  conversations deleted in the app. sweep_everything does both, gives every branch of a forked
  conversation a row of its own (the branch that carried on keeps its title, the rest are marked
  stale and archived), and re-scans to say whether anything is left. Never run consolidate.
- \`foster purge\` destroys conversations on disk and cannot be undone. It is deliberately not one
  of your tools, and you must never run it through the shell either — not with --yes, not with
  --confirm, not to "clean up". If a task seems to call for it, say so and let the user run it.
- \`foster switch\`, \`foster point\` and \`foster client new\` change which account a config
  directory is signed in as, and \`foster vault\` holds credentials. None of them are your tools
  and you must not run them through the shell. Changing who the user is signed in as is not a
  step on the way to something else, and a credential is not a file for a model to move: say
  what you would switch and why, and let the user do it. Reading is fine — \`foster clients\`,
  \`accounts\`, \`usage\` and \`renewals\` answer "which account has quota" without any of this.
- \`foster profile open\`, \`foster client open\`, \`foster profile new|register|forget\` and
  \`foster client register|forget\` start interactive programs or change what foster remembers
  about accounts; none of them is your tool and you must not run them through the shell. If a
  task needs an app or a terminal open on some account, say which one and let the user open it.

You also have Claude Code's general tools. Two rules about them:
- For anything touching the session store or fostered copies, use the foster_session_mgmt tools,
  never raw file operations: the foster tools go through the engine's safety gates and ledger,
  and a direct write bypasses both and can corrupt what the app or foster tracks.
- Without --yes the run is read-only: built-in tools that write or execute are denied by the
  permission layer. Report a denial as the user's choice, not as an error to work around.

Report counts and outcomes plainly, and quote session titles rather than raw uuids when both are
available.`;

/**
 * The tool-related half of the query options — split out so it can be built,
 * and inspected, without loading the Agent SDK or spawning a model.
 *
 * Two shapes, chosen by the same switch the CLI has: --yes.
 *
 * Without it, `tools` stays the full Claude Code preset and `permissionMode`
 * is `'default'` — headless 'default' auto-denies every tool that would have
 * asked (Bash, edits, web; there is no terminal to ask in), so a read-only run
 * is read-only because nothing risky is ever approved, not because it was
 * never offered. That is today's behaviour, kept exactly: a run that only
 * ever wanted to read still sees the whole toolset and picks what it needs.
 *
 * With it, `permissionMode: 'bypassPermissions'` removes that layer — every
 * tool call is approved without being asked — so the toolset itself has to be
 * the gate instead: `tools` is trimmed to the read-only builtins (no Bash, no
 * Write/Edit, no WebFetch/WebSearch), and `allowedTools` to that plus the
 * foster MCP tools, which is what --yes is actually for. `canUseTool` is a
 * second, independent gate on top of the trimmed toolset rather than a
 * replacement for it — it denies any call whose name did not make the
 * allowlist, which catches a tool the harness resolves some other way (a
 * toolAlias, a name this build of the SDK adds later) that `tools` alone
 * would not have kept out.
 */
export function buildToolOptions(
  fosterTools: string[],
  allowWrites: boolean,
): Pick<
  Options,
  'tools' | 'allowedTools' | 'permissionMode' | 'allowDangerouslySkipPermissions' | 'canUseTool'
> {
  const allowedTools = [...fosterTools, ...READ_ONLY_BUILTINS];

  if (!allowWrites) {
    return {
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools,
      permissionMode: 'default',
    };
  }

  return {
    tools: [...READ_ONLY_BUILTINS],
    allowedTools,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    canUseTool: denyOutsideAllowlist(allowedTools),
  };
}

/** Denies any tool call whose name is not in `allowed` — see `buildToolOptions`. */
export function denyOutsideAllowlist(allowed: string[]): CanUseTool {
  const allowedSet = new Set(allowed);
  return async (toolName, input) =>
    allowedSet.has(toolName)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `${toolName} is not available to foster agent --yes.` };
}

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
    ...buildToolOptions(allowedTools, options.allowWrites),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
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
