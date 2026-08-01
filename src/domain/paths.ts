import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AccountRef, StoreLayout } from './types.js';

const CODE_SESSIONS = 'claude-code-sessions';
const AGENT_SESSIONS = 'local-agent-mode-sessions';

/**
 * Claude Desktop ships on Windows as an MSIX package, so the AppData it sees is
 * redirected into the package container. Writing to the plain %APPDATA%\Claude
 * would be invisible to the app; the physical package path is the real store.
 *
 * The package folder name ends in a publisher hash (identical on every machine),
 * so it is matched by prefix rather than hardcoded.
 */
export function candidateStoreRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  const localAppData = env.LOCALAPPDATA;

  if (localAppData) {
    const packages = path.join(localAppData, 'Packages');
    if (existsSync(packages)) {
      for (const entry of safeReaddir(packages)) {
        if (!entry.startsWith('Claude')) continue;
        roots.push(path.join(packages, entry, 'LocalCache', 'Roaming', 'Claude'));
      }
    }
  }

  // Non-MSIX installs (and other platforms) keep userData in the conventional spot.
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'Claude'));
  roots.push(path.join(homedir(), '.config', 'Claude'));
  roots.push(path.join(homedir(), 'Library', 'Application Support', 'Claude'));

  return roots.filter((dir) => existsSync(path.join(dir, CODE_SESSIONS)));
}

/**
 * Resolve the store to operate on. An explicit override always wins, which is how
 * tests point the whole tool at a synthetic store in a temp directory.
 */
export function resolveStore(override?: string, env: NodeJS.ProcessEnv = process.env): StoreLayout {
  const root = override ?? candidateStoreRoots(env)[0];
  if (!root) {
    throw new Error(
      'Could not locate a Claude Desktop store. Pass --store <path> to point at it explicitly.',
    );
  }
  return layoutFor(root);
}

export function layoutFor(root: string): StoreLayout {
  return {
    root,
    codeSessionsDir: path.join(root, CODE_SESSIONS),
    agentSessionsDir: path.join(root, AGENT_SESSIONS),
    configFile: path.join(root, 'config.json'),
  };
}

/** Sessions live at <codeSessionsDir>/<accountUuid>/<organizationUuid>/. */
export function accountDir(store: StoreLayout, account: AccountRef): string {
  return path.join(store.codeSessionsDir, account.accountUuid, account.organizationUuid);
}

export function sessionFileName(sessionId: string): string {
  return `${sessionId}.json`;
}

export function sessionPath(store: StoreLayout, account: AccountRef, sessionId: string): string {
  return path.join(accountDir(store, account), sessionFileName(sessionId));
}

/**
 * Deleting a session in the app leaves a tombstone next to the sessions. The app
 * writes one for the sessionId and one for the cliSessionId. They do not block a
 * later re-foster (verified), but they are useful to recognise while scanning.
 */
export function tombstonePath(store: StoreLayout, account: AccountRef, id: string): string {
  const bare = id.startsWith('local_') ? id.slice('local_'.length) : id;
  return path.join(accountDir(store, account), `deleted_${bare}`);
}

/** Directory names that are account/organization UUIDs rather than app-internal folders. */
export function listAccountDirs(store: StoreLayout): AccountRef[] {
  const out: AccountRef[] = [];
  for (const accountUuid of safeReaddir(store.codeSessionsDir)) {
    const accountPath = path.join(store.codeSessionsDir, accountUuid);
    if (!isDirectory(accountPath)) continue;
    for (const organizationUuid of safeReaddir(accountPath)) {
      if (!isDirectory(path.join(accountPath, organizationUuid))) continue;
      out.push({ accountUuid, organizationUuid });
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
