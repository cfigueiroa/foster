import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type * as ZodModule from 'zod';

/**
 * Loading the Claude Agent SDK without shipping it.
 *
 * The release is a single self-contained bundle — install.ps1 fetches and
 * SHA256-verifies exactly one file, and the smoke test refuses a build that
 * produces more. The Agent SDK cannot live inside that file: it is megabytes of
 * vendored runtime plus a per-platform native binary, and bundling a package
 * that resolves its own binaries relative to its install location would break
 * it anyway. So it stays a devDependency (for types and `npm run dev`) and is
 * resolved at runtime instead:
 *
 *  1. next to this module — a dev checkout, where node_modules exists;
 *  2. under `~/.foster/agent/`, where `foster agent --setup` installs it once.
 *
 * The imports below are dynamic with a computed path, which the bundler leaves
 * verbatim rather than splitting into a chunk — the property the release
 * depends on.
 */

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Kept in step with the devDependency by hand; version:check does not cover it. */
const SDK_INSTALL_RANGE = '^0.3.220';

export interface AgentSdkModule {
  query: typeof query;
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
  z: typeof ZodModule.z;
}

export class AgentSdkNotInstalledError extends Error {
  constructor(depsDir: string) {
    super(
      'The Claude Agent SDK is not installed.\n' +
        `Run \`foster agent --setup\` to install it once (an npm download into ${depsDir}).`,
    );
    this.name = 'AgentSdkNotInstalledError';
  }
}

/** Where --setup installs the SDK: beside the ledger, never inside the app's store. */
export function agentDepsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FOSTER_HOME ?? path.join(homedir(), '.foster');
  return path.join(base, 'agent');
}

function resolveFrom(anchor: string, specifier: string): string | undefined {
  try {
    return createRequire(anchor).resolve(specifier);
  } catch {
    return undefined;
  }
}

/** The SDK's entry point, wherever it is installed — or nothing. */
export function resolveAgentSdkPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    resolveFrom(import.meta.url, SDK_PACKAGE) ??
    // The anchor file does not need to exist; resolution only walks node_modules
    // upward from its directory.
    resolveFrom(path.join(agentDepsDir(env), 'package.json'), SDK_PACKAGE)
  );
}

export async function loadAgentSdk(env: NodeJS.ProcessEnv = process.env): Promise<AgentSdkModule> {
  const sdkPath = resolveAgentSdkPath(env);
  if (!sdkPath) throw new AgentSdkNotInstalledError(agentDepsDir(env));

  // zod is the SDK's peer, installed next to it; anchoring at the SDK's own
  // entry file finds the copy the SDK itself would load.
  const zodPath = resolveFrom(sdkPath, 'zod');
  if (!zodPath) throw new AgentSdkNotInstalledError(agentDepsDir(env));

  const sdk = (await import(pathToFileURL(sdkPath).href)) as {
    query: typeof query;
    tool: typeof tool;
    createSdkMcpServer: typeof createSdkMcpServer;
  };
  const zod = (await import(pathToFileURL(zodPath).href)) as typeof ZodModule;

  return {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    z: zod.z,
  };
}

/**
 * One-time install into ~/.foster/agent — a real npm install, so the SDK's
 * peers and its per-platform binary arrive the same way they would anywhere
 * else, and a later `--setup` updates within the pinned range.
 */
export function installAgentSdk(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): void {
  const dir = agentDepsDir(env);
  mkdirSync(dir, { recursive: true });

  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: 'foster-agent-deps', private: true }, null, 2)}\n`,
      'utf8',
    );
  }

  log(`Installing ${SDK_PACKAGE}@${SDK_INSTALL_RANGE} into ${dir} …`);
  execFileSync(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `${SDK_PACKAGE}@${SDK_INSTALL_RANGE}`,
    ],
    {
      cwd: dir,
      stdio: 'inherit',
      // npm on Windows is npm.cmd, which Node will only start through a shell.
      // Every argument above is a literal, so there is nothing to interpret.
      shell: process.platform === 'win32',
    },
  );
  log('Done.');
}
