import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDirectory, safeReaddir } from '../util/fs.js';
import { sessionFileName, tombstoneFileName } from './naming.js';
import type { AccountRef, StoreLayout } from './types.js';

export { sessionFileName } from './naming.js';

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

  // The app's own profile override, applied at its entry point before anything
  // else: `CLAUDE_USER_DATA_DIR` becomes userData outright. Running a second
  // profile is the only way to hold two accounts at once, so a store reached that
  // way has to be findable — and it wins, because an environment that sets it is
  // an environment where the app would use it.
  if (env.CLAUDE_USER_DATA_DIR) roots.push(env.CLAUDE_USER_DATA_DIR);

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
  // Normalised once, here, so every comparison and every line printed downstream
  // sees one spelling. A path typed with forward slashes on Windows otherwise
  // travels all the way to the screen as `D:\Local/Profile`.
  const resolved = path.resolve(root);
  return {
    root: resolved,
    codeSessionsDir: path.join(resolved, CODE_SESSIONS),
    agentSessionsDir: path.join(resolved, AGENT_SESSIONS),
    configFile: path.join(resolved, 'config.json'),
  };
}

/** Sessions live at <codeSessionsDir>/<accountUuid>/<organizationUuid>/. */
export function accountDir(store: StoreLayout, account: AccountRef): string {
  return path.join(store.codeSessionsDir, account.accountUuid, account.organizationUuid);
}

export function sessionPath(store: StoreLayout, account: AccountRef, sessionId: string): string {
  return path.join(accountDir(store, account), sessionFileName(sessionId));
}

/**
 * A path in the form used for comparing two of them.
 *
 * `path.resolve` settles separators and relative segments but not case, and on
 * Windows `D:\Store` and `d:\store` are the same directory. Comparing them raw
 * makes a store passed with different capitalisation look like a different
 * installation — which would quietly report nothing fostered rather than fail.
 */
export function comparablePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/**
 * How to recognise a store's own processes.
 *
 * Two facts are needed and neither is guessable from the path alone. The
 * packaged installation answers to more than one name — the package directory
 * foster resolves, and the pre-virtualisation `%APPDATA%` path the app passes to
 * its children — so matching by a single spelling would miss it. And its main
 * process carries no `--user-data-dir` at all, so a switchless process means
 * "the default installation" rather than "any installation": treating it as a
 * wildcard made a profile report the default app as its own, which for a command
 * that closes an app is the wrong way to be wrong.
 */
export interface StoreIdentity {
  /** Every path that names this store. */
  roots: string[];
  /** Whether this is the installed app, whose main process omits the switch. */
  isDefault: boolean;
}

export function storeIdentity(root: string, env: NodeJS.ProcessEnv = process.env): StoreIdentity {
  const candidates = candidateStoreRoots(env);
  const isDefault = candidates.some((dir) => samePath(dir, root));
  return { roots: isDefault ? candidates : [root], isDefault };
}

/**
 * Whether a store holds a given Code session.
 *
 * The app stamps the session it hosts into the environment of the CLI it starts,
 * and the instance that stamped it is the one whose store the file lives in. That
 * makes this the only local way to tell which of several running installations
 * foster is running inside — the marker itself names no store.
 */
export function storeHoldsSession(root: string, sessionId: string): boolean {
  const store = layoutFor(root);
  return listAccountDirs(store).some((account) =>
    existsSync(sessionPath(store, account, sessionId)),
  );
}

/**
 * The store a session file belongs to, read back out of its path.
 *
 * Copies can now be written into a store other than the one foster resolved, and
 * the ledger records only the absolute path. Undoing one has to reason about the
 * installation that actually holds it — checking the wrong app would answer "safe
 * to delete" about a file another running app is holding.
 *
 * The layout is fixed at four levels: <root>/claude-code-sessions/<account>/<org>/<file>.
 */
export function storeRootOfCopy(copyPath: string): string {
  return path.resolve(copyPath, '..', '..', '..', '..');
}

/**
 * Deleting a session in the app leaves a tombstone next to the sessions. The app
 * writes one for the sessionId and one for the cliSessionId. They do not block a
 * later re-foster (verified), but they are useful to recognise while scanning.
 */
export function tombstonePath(store: StoreLayout, account: AccountRef, id: string): string {
  return path.join(accountDir(store, account), tombstoneFileName(id));
}

/** Account/organization pairs under an arbitrary <base>/<accountUuid>/<organizationUuid> tree. */
export function listAccountDirsIn(base: string): AccountRef[] {
  const out: AccountRef[] = [];
  for (const accountUuid of safeReaddir(base)) {
    const accountPath = path.join(base, accountUuid);
    if (!isDirectory(accountPath)) continue;
    for (const organizationUuid of safeReaddir(accountPath)) {
      if (!isDirectory(path.join(accountPath, organizationUuid))) continue;
      out.push({ accountUuid, organizationUuid });
    }
  }
  return out;
}

export function listAccountDirs(store: StoreLayout): AccountRef[] {
  return listAccountDirsIn(store.codeSessionsDir);
}

/**
 * Cowork sandboxes are not fosterable, but the app creates this tree for an
 * account before any Code session exists — which makes it the only local way to
 * learn a brand-new account's organization.
 */
export function listAgentAccountDirs(store: StoreLayout): AccountRef[] {
  return listAccountDirsIn(store.agentSessionsDir);
}

/**
 * Picks which organization of an account the sidebar is most likely reading.
 *
 * The config records only the account, so for an account holding more than one
 * organization the answer is not written down anywhere. The app rewrites session
 * files as it runs, so the most recently touched directory is the one in use —
 * a heuristic, but a well-founded one, and far better than taking whichever
 * directory the filesystem happened to list first: copies written into an
 * organization the app never reads would simply never appear, with nothing to
 * indicate why.
 *
 * Callers that know better should pass the organization explicitly.
 */
export function pickActiveOrganization(
  candidates: AccountRef[],
  store: StoreLayout,
): AccountRef | undefined {
  if (candidates.length <= 1) return candidates[0];

  return [...candidates].sort((a, b) => modifiedAt(store, b) - modifiedAt(store, a))[0];
}

function modifiedAt(store: StoreLayout, ref: AccountRef): number {
  try {
    return statSync(accountDir(store, ref)).mtimeMs;
  } catch {
    return 0;
  }
}
