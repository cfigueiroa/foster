import { homedir } from 'node:os';
import path from 'node:path';
import type { LedgerState } from '../ledger/project.js';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * Every directory the CLI might call home.
 *
 * One `claude` account is one config directory: `CLAUDE_CONFIG_DIR` when it is
 * set, `~/.claude` otherwise, and a sibling per further account — running a
 * second subscription just means pointing the CLI at a directory of its own.
 * This enumeration used to be written out wherever something needed it, once
 * per question; the copies agreed, and nothing kept them agreeing. What counts
 * as a candidate is decided here once, and each consumer keeps only the
 * question it asks of one — transcripts look under `projects/`, the live
 * registry under `sessions/`, the client list at the directory itself.
 *
 * Candidates, not certainties: nothing is checked beyond one listing of the
 * home directory, so a candidate may be missing, or may be a stray file that
 * happens to start with `.claude`, and every consumer filters for what it
 * actually needs. Deduplicated as strings only; folding two spellings of one
 * directory is left to the consumer, as `indexAllTranscripts` does, because
 * only the consumer knows whether the spelling matters.
 */
/**
 * The directory this process's own environment resolves to.
 *
 * One rule, stated once: `CLAUDE_CONFIG_DIR` when it is set, `~/.claude`
 * otherwise. It is the same rule the CLI itself follows, and it decides which
 * client `clients` marks with a star and which one a credential command acts on
 * by default — two answers that must never disagree, which is the argument for
 * it living beside the enumeration rather than being written out again wherever
 * it is needed.
 */
export function inUseConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
}

export function configDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
  home: string = homedir(),
): string[] {
  const dirs = new Set<string>();

  for (const dir of [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), ...extra]) {
    if (dir) dirs.add(dir);
  }
  for (const entry of safeReaddir(home)) {
    if (entry.startsWith('.claude')) dirs.add(path.join(home, entry));
  }

  return [...dirs];
}

/**
 * Whether a directory is a CLI client at all.
 *
 * Inspection, not naming: the evidence accepted is wider than a transcript
 * scan's, because the question is wider — a client that has never held a
 * conversation is still a client. Any artefact the CLI itself leaves counts.
 * An empty directory counts too: that is what a client looks like between
 * `mkdir` and its first run, and refusing to list it would answer "where is
 * the client I just created?" with silence. What does not count is a
 * directory holding only unrelated files — a `.claude-notes` full of markdown
 * is somebody's folder, not an account.
 *
 * Lives here, not in `clients.ts`, because `registeredClientDirs` below needs
 * it to judge a container's children and `clients.ts` already depends on this
 * module — putting it the other way round would make the two modules import
 * each other.
 */
const CLIENT_MARKS = ['.claude.json', '.credentials.json', 'settings.json', 'projects', 'sessions'];

export function looksLikeClient(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  const entries = safeReaddir(dir);
  return entries.length === 0 || entries.some((entry) => CLIENT_MARKS.includes(entry));
}

/**
 * Directories a registered client root offers for listing and launch.
 *
 * Two shapes, because `client register` records which one it saw: a `client`
 * root is the directory itself, already a config directory; a `container`
 * root — `~/.claude-contas` holding one folder per account — is walked one
 * level down, and each child still has to pass `looksLikeClient` on its own.
 * Deeper than one level is not walked: a container of containers is not a
 * shape `register --container` claims to describe, and guessing at nesting
 * would list directories nobody registered.
 *
 * This feeds listing and launch only. It is never folded into
 * `configDirCandidates`, so nothing it names reaches `purge`, `restore`,
 * `live --prune/--stop`, `switch` or `point` — those keep needing
 * `--config-dir` to reach a registered root, on purpose. A test in
 * `tests/clients.test.ts` guards that `configDirCandidates` does not change
 * shape to swallow this.
 */
export function registeredClientDirs(state: LedgerState): string[] {
  const dirs: string[] = [];
  for (const [root, as] of state.clientRoots) {
    if (as === 'client') {
      dirs.push(root);
      continue;
    }
    for (const entry of safeReaddir(root)) {
      const child = path.join(root, entry);
      if (looksLikeClient(child)) dirs.push(child);
    }
  }
  return dirs;
}
