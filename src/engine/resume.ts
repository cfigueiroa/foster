import { execFileSync } from 'node:child_process';
import { bareSessionId } from '../domain/naming.js';
import { liveSessionFor, sessionRegistryRoots } from '../store/liveSessions.js';

/**
 * Headless resume: one prompt into an existing conversation, via
 * `claude -p --resume`.
 *
 * The gate in front of it is the point of this module existing at all — two
 * writers on one transcript corrupt it, and the CLI's registry of live sessions
 * is the only place that says whether a conversation has a writer right now.
 * The command and the agent tool both go through here, so neither can skip it.
 */

export type ResumeRunner = (cliSessionId: string, prompt: string, timeoutMs: number) => string;

export interface ResumeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable for tests; production runs the real CLI. */
  runner?: ResumeRunner;
}

export type ResumeResult = { refused: string } | { cliSessionId: string; output: string };

const TIMEOUT_DEFAULT_MS = 300_000;
const OUTPUT_CAP = 100_000;

export function resumeConversation(
  cliSessionId: string,
  prompt: string,
  options: ResumeOptions = {},
): ResumeResult {
  const id = bareSessionId(cliSessionId);
  if (!/^[0-9a-f][0-9a-f-]{7,63}$/i.test(id)) {
    throw new Error(`"${cliSessionId}" does not look like a conversation id.`);
  }
  if (!prompt.trim()) throw new Error('The prompt must not be empty.');

  const live = liveSessionFor(id, sessionRegistryRoots(options.env ?? process.env));
  if (live) {
    return {
      refused:
        `A live claude process (pid ${live.pid}) is using this conversation right now` +
        (live.cwd ? ` in ${live.cwd}` : '') +
        '. Resuming it from outside would put two writers on one transcript.',
    };
  }

  const run = options.runner ?? runClaudeResume;
  const output = run(id, prompt, options.timeoutMs ?? TIMEOUT_DEFAULT_MS);
  const capped =
    output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n[output truncated]` : output;
  return { cliSessionId: id, output: capped };
}

/**
 * `claude -p --resume` with the prompt on stdin.
 *
 * stdin on purpose: on Windows the command resolves through a shell (the CLI is
 * a .cmd shim, which Node refuses to spawn directly), and a prompt has no
 * business being interpreted by one. The only argv values are literals and an
 * id validated to [0-9a-f-].
 */
function runClaudeResume(cliSessionId: string, prompt: string, timeoutMs: number): string {
  try {
    return execFileSync('claude', ['-p', '--resume', cliSessionId], {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Running \`claude -p --resume\` failed: ${detail}\n` +
        'The Claude Code CLI must be installed and signed in for headless resume.',
    );
  }
}
