import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { comparablePath, directoryKey, samePath } from '../domain/paths.js';
import { fileExists } from '../util/fs.js';
import { configDirCandidates, inUseConfigDir, looksLikeClient } from './configDirs.js';
import { planName, type CachedIdentity } from './identity.js';
import { liveSessions, writerAlive, type WriterCheck } from './liveSessions.js';
import { indexTranscripts } from './transcripts.js';

/**
 * The Claude Code clients on this machine.
 *
 * One client is one config directory. Nothing else makes a CLI account: the CLI
 * reads `CLAUDE_CONFIG_DIR`, and credential, settings, conversations and live
 * registry all live under whatever it names — so running a second account is
 * making a second directory, and the machine's client list is its directory
 * list. This is that list, with what each directory can say for itself: who is
 * signed in, how much has happened there, and whether a process is in it right
 * now.
 *
 * Everything here reads. The identity comes from the profile the CLI cached in
 * its own config file; the credential beside it contributes only its existence,
 * which is what "signed in" means on this machine — the file is never opened.
 */

export interface ClaudeClient {
  /** The config directory — the value `CLAUDE_CONFIG_DIR` would be set to. */
  configDir: string;
  /** True for `~/.claude`, the directory the CLI uses when nothing points it elsewhere. */
  isDefault: boolean;
  /** True for the directory this process's own environment resolves to. */
  inUse: boolean;
  /** Whether a login has left its credential here. Presence only; the file is never read. */
  signedIn: boolean;
  /** Who is signed in, from the client's own cached profile. */
  identity?: CachedIdentity;
  /** Conversations on disk under this client's `projects/` tree. */
  conversations: number;
  /** The newest transcript's mtime — when this client last did something. */
  lastUsedAt?: number;
  /** Live `claude` processes registered in this client right now. */
  live: number;
  /**
   * What this names, when the directory itself is a junction to elsewhere —
   * `~/.claude-frota -> ~/.claude-contas/llm02`, measured. The junction is
   * still `configDir`: it is the path anything pointed at it would open. This
   * is only ever set from the directory's own filesystem entry, never from
   * folding two enumerated candidates together.
   */
  linkTarget?: string;
}

/**
 * Every client on the machine, the default first.
 *
 * The candidates are `configDirCandidates`' plus, when the caller passes them,
 * registered client roots (`registeredClientDirs`, `configDirs.ts`) —
 * `registeredDirs` is always an explicit argument here, never a default that
 * reads the ledger itself: `identify` calls this with nothing and must keep
 * getting nothing, because a default that quietly grew to include registered
 * roots would hand fleet credentials to `identify`'s API call without anyone
 * asking for that. See `tests/clients.test.ts` for the guard.
 *
 * Folded by `directoryKey`, not by comparing path strings: a junction and its
 * target are two spellings of one directory to the filesystem, and a machine
 * with one client should not be told it has two just because one candidate
 * arrived via `configDirCandidates`' sibling scan and the other via a
 * registered container's children. `configDirCandidates` is read first, so a
 * junction sibling wins the row and carries its target in `linkTarget`; the
 * container child that duplicates it is folded away silently, its identity
 * already shown through the link.
 */
export function listClients(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
  registeredDirs: string[] = [],
  alive: WriterCheck = writerAlive,
  home: string = homedir(),
): ClaudeClient[] {
  const defaultDir = path.join(home, '.claude');
  const inUseDir = inUseConfigDir(env, home);

  const seen = new Set<string>();
  const clients: ClaudeClient[] = [];
  for (const dir of [...configDirCandidates(env, extra, home), ...registeredDirs]) {
    const key = directoryKey(dir) ?? comparablePath(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!looksLikeClient(dir)) continue;
    clients.push(readClient(dir, { defaultDir, inUseDir, home, alive }));
  }

  return clients.sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.configDir.localeCompare(b.configDir),
  );
}

/**
 * What a client directory names, when the directory itself is a junction.
 *
 * Reading through it — `.claude.json`, `projects/`, `sessions/` — already
 * reaches the target transparently, so identity and counts need no separate
 * target-aware path; only the display needs to know a link is there at all,
 * and what it names.
 */
function readLinkTarget(dir: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    return undefined;
  }
  if (!stats.isSymbolicLink()) return undefined;

  try {
    // Windows hands back the verbatim \\?\ form; not part of any path anyone typed.
    return readlinkSync(dir).replace(/^\\\\\?\\/, '');
  } catch {
    return undefined;
  }
}

function readClient(
  dir: string,
  ctx: { defaultDir: string; inUseDir: string; home: string; alive: WriterCheck },
): ClaudeClient {
  const isDefault = samePath(dir, ctx.defaultDir);
  const transcripts = indexTranscripts(path.join(dir, 'projects'));
  const lastUsedAt = newestMtime(transcripts.values());
  const identity = readClientIdentity(dir, isDefault, ctx.home);
  const linkTarget = readLinkTarget(dir);

  return {
    configDir: dir,
    isDefault,
    inUse: samePath(dir, ctx.inUseDir),
    signedIn: fileExists(path.join(dir, '.credentials.json')),
    ...(identity ? { identity } : {}),
    conversations: transcripts.size,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    live: liveSessions([path.join(dir, 'sessions')], ctx.alive).length,
    ...(linkTarget ? { linkTarget } : {}),
  };
}

/**
 * The signed-in identity, from the profile the CLI cached for itself.
 *
 * The CLI keeps a copy of the profile it fetched, in its config file under
 * `oauthAccount` — email, display name, and the rate-limit tier the plan is
 * read from. That copy is cached page data, the same at-rest category as the
 * session files; the credential next to it is not read, here or anywhere.
 *
 * Parsed rather than scraped, unlike the Desktop cache: this is a small JSON
 * file in a shape the CLI itself round-trips on every run, not a database
 * engine's private table, and a parse that fails yields a client with no
 * identity rather than a crash.
 *
 * The default client keeps the file beside its directory, at `~/.claude.json`,
 * rather than inside it; a directory the variable has pointed at keeps its own
 * within. For the default both are looked at, home first, because the home copy
 * is the one the CLI actually writes when nothing redirects it — an in-dir copy
 * can be a relic of a spell of `CLAUDE_CONFIG_DIR=~/.claude`, months stale.
 */
export function readClientIdentity(
  dir: string,
  isDefault: boolean,
  home: string,
): CachedIdentity | undefined {
  const candidates = isDefault
    ? [path.join(home, '.claude.json'), path.join(dir, '.claude.json')]
    : [path.join(dir, '.claude.json')];

  for (const file of candidates) {
    const account = readOauthAccount(file);
    if (!account) continue;

    const plan = planName(account.userRateLimitTier) ?? planName(account.organizationRateLimitTier);
    const identity: CachedIdentity = {
      ...(account.emailAddress ? { email: account.emailAddress } : {}),
      ...(account.displayName ? { name: account.displayName } : {}),
      ...(plan ? { plan } : {}),
    };
    if (identity.email || identity.name || identity.plan) return identity;
  }
  return undefined;
}

/** The string fields of `oauthAccount`, or nothing for a file that is missing, torn or foreign. */
function readOauthAccount(file: string): Record<string, string | undefined> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: unknown };
    const account = parsed.oauthAccount;
    if (typeof account !== 'object' || account === null) return undefined;

    const fields: Record<string, string | undefined> = {};
    for (const key of [
      'emailAddress',
      'displayName',
      'userRateLimitTier',
      'organizationRateLimitTier',
    ]) {
      const value = (account as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) fields[key] = value;
    }
    return fields;
  } catch {
    return undefined;
  }
}

function newestMtime(files: Iterable<string>): number | undefined {
  let newest: number | undefined;
  for (const file of files) {
    try {
      const at = statSync(file).mtimeMs;
      if (newest === undefined || at > newest) newest = at;
    } catch {
      // A transcript that vanished between listing and statting is not activity.
    }
  }
  return newest;
}
