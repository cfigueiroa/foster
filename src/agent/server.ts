import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { errorMessage } from '../util/fs.js';
import type { AgentSdkModule } from './sdk.js';
import {
  appStatus,
  fosterSessionsTool,
  fosterStatus,
  labelAccount,
  listSessions,
  readTranscript,
  resumeHeadless,
  returnFosteringsTool,
  scanAccounts,
  sweepEverything,
  type AgentToolContext,
} from './tools.js';

/**
 * The in-process MCP server `foster agent` exposes to the model.
 *
 * This module is only wiring: names, descriptions and zod schemas around the
 * handlers in tools.ts, which is where the behaviour (and the tests) live. The
 * SDK arrives as an argument because it is loaded dynamically — see sdk.ts.
 */

export const SERVER_NAME = 'foster_session_mgmt';

export interface BuiltServer {
  server: McpSdkServerConfigWithInstance;
  /** Fully-qualified tool names, for the allowlist the query runs under. */
  allowedTools: string[];
}

export function buildServer(sdk: AgentSdkModule, ctx: AgentToolContext): BuiltServer {
  const { tool, createSdkMcpServer, z } = sdk;

  const respond = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });
  const refuse = (error: unknown) => ({
    content: [{ type: 'text' as const, text: errorMessage(error) }],
    isError: true,
  });
  /** Handlers throw plain Errors; the model gets the message, not a stack. */
  const wrap =
    <A>(handler: (args: A) => unknown) =>
    (args: A) => {
      try {
        return Promise.resolve(respond(handler(args)));
      } catch (error) {
        return Promise.resolve(refuse(error));
      }
    };

  const mutationGate =
    'Dry run unless apply is true — and apply is only honoured when the user started ' +
    '`foster agent` with --yes; without it the result says writes are disabled.';

  const tools = [
    tool(
      'scan_accounts',
      'Inventory of the accounts in the Claude Desktop store: per account/organization, how many ' +
        'native sessions and how many fostered copies, which one the sidebar currently shows, and ' +
        'any label the user gave it. Read-only.',
      {},
      wrap(() => scanAccounts(ctx)),
    ),
    tool(
      'list_sessions',
      'List Code sessions. By default: sessions from every account except the current one — the ' +
        'candidates for fostering. Pass accountUuid (a unique prefix works) to list exactly that ' +
        "account, the current one included. Each row carries the session's cliSessionId, which " +
        'read_transcript accepts. Read-only.',
      {
        accountUuid: z.string().optional().describe('unique prefix of an account uuid'),
        title: z.string().optional().describe('case-insensitive substring of the title'),
        cwd: z.string().optional().describe('case-insensitive substring of the working directory'),
        sinceDays: z.number().optional().describe('only sessions active in the last N days'),
        includeUnfosterable: z
          .boolean()
          .optional()
          .describe('also list sessions that can never appear in the sidebar'),
        limit: z.number().optional().describe('rows to return, default 100, max 500'),
      },
      wrap((args) => listSessions(ctx, args)),
    ),
    tool(
      'foster_status',
      'What is currently fostered according to the ledger, and whether any copies duplicate a ' +
        'conversation their account already had. Read-only.',
      {},
      wrap(() => fosterStatus(ctx)),
    ),
    tool(
      'app_status',
      'Whether Claude Desktop is running, since when, and what that means for which operations ' +
        'are safe right now. Read-only.',
      {},
      wrap(() => appStatus(ctx)),
    ),
    tool(
      'read_transcript',
      'Read part of a conversation transcript (the JSONL under ~/.claude/projects) to answer ' +
        'questions about what happened in a session. Takes the cliSessionId from list_sessions ' +
        'or foster_status. Read-only.',
      {
        cliSessionId: z.string().describe('the conversation id'),
        part: z
          .enum(['head', 'tail'])
          .optional()
          .describe('start or most recent part; default tail'),
        maxChars: z.number().optional().describe('how much to read, default 20000'),
      },
      wrap((args) => readTranscript(ctx, args)),
    ),
    tool(
      'label_account',
      "Give an account uuid a human name, recorded in foster's own ledger (never in the app).",
      {
        accountUuid: z.string(),
        label: z.string(),
      },
      wrap((args) => labelAccount(ctx, args)),
    ),
    tool(
      'foster_sessions',
      'Copy sessions from another account into the current one, so they appear in the sidebar ' +
        `after a restart. The originals are never modified. ${mutationGate}`,
      {
        sessionIds: z
          .array(z.string())
          .optional()
          .describe('specific sessions, by id or unique prefix; otherwise the filters select'),
        fromAccountUuid: z.string().optional().describe('unique prefix of the source account'),
        title: z.string().optional(),
        cwd: z.string().optional(),
        sinceDays: z.number().optional(),
        prefix: z.string().optional().describe('title prefix marking the copies'),
        apply: z.boolean().optional().describe('actually write; see the gate above'),
      },
      wrap((args) => fosterSessionsTool(ctx, args)),
    ),
    tool(
      'sweep_everything',
      'The whole job in one call: copy every fosterable session from the other accounts into ' +
        'the current one — archived included, and the copies stay archived — then bring back ' +
        'conversations the app deleted that nothing points at, then re-scan to confirm both are ' +
        'exhausted. Use this for "bring everything here", rather than foster_sessions, which ' +
        'leaves archived sessions behind and cannot reach deleted ones. It never purges and ' +
        'never consolidates: forks are counted and reported for the user to decide. The result ' +
        `carries the restart command, and says when foster must not run it itself. ${mutationGate}`,
      {
        prefix: z.string().optional().describe('title prefix marking the copies'),
        configDirs: z
          .array(z.string())
          .optional()
          .describe('extra Claude config directories to search for deleted conversations'),
        apply: z.boolean().optional().describe('actually write; see the gate above'),
      },
      wrap((args) => sweepEverything(ctx, args)),
    ),
    tool(
      'return_fosterings',
      'Remove fostered copies, restoring the previous state. Refuses copies a running Claude ' +
        `Desktop may hold in memory — the user must close the app first. ${mutationGate}`,
      {
        sessionIds: z
          .array(z.string())
          .optional()
          .describe('origin sessions, by id or unique prefix; otherwise the filters select'),
        title: z.string().optional(),
        duplicatesOnly: z
          .boolean()
          .optional()
          .describe('only copies duplicating a conversation their account already had'),
        allStores: z.boolean().optional().describe('include copies in other installations'),
        apply: z.boolean().optional().describe('actually remove; see the gate above'),
      },
      wrap((args) => returnFosteringsTool(ctx, args)),
    ),
    tool(
      'resume_headless',
      'Send one prompt to an existing conversation via `claude -p --resume` and return its ' +
        'answer. Appends to the transcript, so it requires the --yes start, and it refuses a ' +
        'conversation a live claude process is using right now.',
      {
        cliSessionId: z.string(),
        prompt: z.string(),
        timeoutSeconds: z.number().optional().describe('default 300, max 3600'),
      },
      wrap((args) => resumeHeadless(ctx, args)),
    ),
  ];

  return {
    // alwaysLoad: with the full Claude Code toolset the harness defers MCP tools
    // behind tool search, and the cheap default model reliably fumbled the
    // load-then-call dance (observed: three ToolSearch calls, zero tool calls,
    // then giving up). Ten tools are cheap enough to keep in the prompt.
    server: createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools, alwaysLoad: true }),
    allowedTools: [
      'scan_accounts',
      'list_sessions',
      'foster_status',
      'app_status',
      'read_transcript',
      'label_account',
      'foster_sessions',
      'sweep_everything',
      'return_fosterings',
      'resume_headless',
    ].map((name) => `mcp__${SERVER_NAME}__${name}`),
  };
}
