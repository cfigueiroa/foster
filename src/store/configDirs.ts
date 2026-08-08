import { homedir } from 'node:os';
import path from 'node:path';
import { safeReaddir } from '../util/fs.js';

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
