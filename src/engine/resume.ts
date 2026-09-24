import { execFileSync, spawn } from 'node:child_process';
import { bareSessionId } from '../domain/naming.js';
import { liveSessionFor, sessionRegistryRoots } from '../store/liveSessions.js';
import { scrubbedEnv } from './launchEnv.js';

/**
 * Headless resume: one prompt into an existing conversation, via
 * `claude -p --resume`.
 *
 * The gate in front of it is the point of this module existing at all — two
 * writers on one transcript corrupt it, and the CLI's registry of live sessions
 * is the only place that says whether a conversation has a writer right now.
 * The command and the agent tool both go through here, so neither can skip it.
 */

export type ResumeRunner = (
  cliSessionId: string,
  prompt: string,
  timeoutMs: number,
) => string | Promise<string>;

export interface ResumeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable for tests; production runs the real CLI. */
  runner?: ResumeRunner;
}

export type ResumeResult = { refused: string } | { cliSessionId: string; output: string };

const TIMEOUT_DEFAULT_MS = 300_000;
const OUTPUT_CAP = 100_000;

export async function resumeConversation(
  cliSessionId: string,
  prompt: string,
  options: ResumeOptions = {},
): Promise<ResumeResult> {
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

  const configDir = (options.env ?? process.env).CLAUDE_CONFIG_DIR;
  const run: ResumeRunner =
    options.runner ??
    ((sessionId, p, timeoutMs) => runClaudeResume(sessionId, p, timeoutMs, configDir));
  const output = await run(id, prompt, options.timeoutMs ?? TIMEOUT_DEFAULT_MS);
  const capped =
    output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n[output truncated]` : output;
  return { cliSessionId: id, output: capped };
}

/** Stops accumulating a stream past this many bytes — a runaway process must not grow this process's heap without bound. */
const STREAM_HARD_CAP = 16 * 1024 * 1024;

/**
 * `claude -p --resume` with the prompt on stdin.
 *
 * stdin on purpose: on Windows the command resolves through a shell (the CLI is
 * a .cmd shim, which Node refuses to spawn directly), and a prompt has no
 * business being interpreted by one. The only argv values are literals and an
 * id validated to [0-9a-f-].
 *
 * Async `spawn`, not `execFileSync`, and the difference is the point. Measured:
 * `execFileSync`'s own `timeout` sends its kill signal to the one pid it started
 * directly — on Windows, with `shell: true`, that pid is `cmd.exe`. A `.cmd`
 * shim needs a shell to resolve at all, but `cmd.exe` does not forward a signal
 * to whatever *it* went on to start; killing it leaves that child — here, the
 * real `claude` process — running and still appending to the transcript. The
 * caller believes the run is over and a second writer is now on the same file.
 * `spawn` plus a timer this function owns fixes that: on timeout it runs
 * `taskkill /PID <pid> /T /F` against the pid `spawn()` itself returned (the
 * shell), and `/T` walks down to every process that shell started — `claude`
 * included. The env is `scrubbedEnv` of `process.env`, for the same reason
 * every other launch in this codebase uses it: a `claude` started from inside
 * a hosted session must not come up thinking it is hosted too
 * (`launchEnv.ts`). `scrubbedEnv` strips everything starting with `CLAUDE`,
 * case-insensitively — including `CLAUDE_CONFIG_DIR` — so `configDir` (read
 * by the caller from the same env `sessionRegistryRoots` used for the
 * live-writer check, before the scrub) is put back explicitly: that is the
 * only thing standing between this spawn and the operator's own `~/.claude`,
 * in exactly the multi-account scenario `foster client open <client>` sets up
 * by putting `CLAUDE_CONFIG_DIR` on the tab (see AGENTS.md). Scrub-then-set
 * is the same two-step `buildPsCommand`/`launch.ts` already uses for `wt`.
 */
function runClaudeResume(
  cliSessionId: string,
  prompt: string,
  timeoutMs: number,
  configDir: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const scrubbed = scrubbedEnv(process.env);
    const spawnEnv = configDir ? { ...scrubbed, CLAUDE_CONFIG_DIR: configDir } : scrubbed;
    const child = spawn('claude', ['-p', '--resume', cliSessionId], {
      env: spawnEnv,
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < STREAM_HARD_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STREAM_HARD_CAP) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Running \`claude -p --resume\` failed: ${error.message}\n` +
            'The Claude Code CLI must be installed and signed in for headless resume.',
        ),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `\`claude -p --resume\` did not answer within ${timeoutMs}ms; the process tree was killed.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Running \`claude -p --resume\` failed (exit ${code}${signal ? `, signal ${signal}` : ''}): ` +
              `${(stderr || stdout).trim()}\n` +
              'The Claude Code CLI must be installed and signed in for headless resume.',
          ),
        );
        return;
      }
      resolve(stdout);
    });

    child.stdin?.end(prompt);
  });
}

/**
 * Kills the process tree rooted at `pid` — see the comment on `runClaudeResume`.
 * Scoped to exactly the pid that call just spawned: this function starts no
 * process of its own and never touches a pid it was not handed.
 *
 * `taskkill` is Windows-only. On win32 `spawn` above runs through a shell (a
 * `.cmd` shim needs one to resolve at all), so the spawned pid is the shell's,
 * and `/T` is what walks down to the real `claude` process it started — a
 * plain kill of the shell pid would leave `claude` running and orphaned,
 * which is the exact bug this module exists to close. On every other
 * platform `shell: false` is used instead (see `runClaudeResume`), so
 * `child.pid` already names the real `claude` process directly — no shell,
 * no tree to walk — and `process.kill` with `SIGKILL` reaches it the same
 * way `execFileSync`'s own timeout used to, before this module switched to
 * `spawn`.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000,
        stdio: 'ignore',
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already exited between the timeout firing and the kill running, or
    // taskkill itself could not be found — either way, nothing more to do.
  }
}
