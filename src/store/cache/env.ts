import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * `<FOSTER_HOME>/cache` — the persistent scan cache's own directory, a sibling
 * of the ledger rather than something under it. Relocatable with `FOSTER_HOME`
 * exactly as the ledger is, so a test or a second profile never shares one
 * with the real machine.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FOSTER_HOME ?? path.join(homedir(), '.foster');
  return path.join(base, 'cache');
}

/**
 * Whether the persistent cache is out of the running for this invocation.
 *
 * `noCacheFlag` is `--no-cache`, read by the caller from commander's parsed
 * options. `FOSTER_NO_CACHE` is its scriptable twin — for a detached restart
 * or a scheduled task, which never sees a flag typed at a prompt — and either
 * one alone is enough; neither implies the other must also be set. Any value
 * but empty or `0` counts as set, the same convention the rest of foster reads
 * an on/off environment variable by.
 */
export function cacheDisabled(env: NodeJS.ProcessEnv = process.env, noCacheFlag = false): boolean {
  if (noCacheFlag) return true;
  const raw = env.FOSTER_NO_CACHE;
  return raw !== undefined && raw !== '' && raw !== '0';
}

export interface CacheStats {
  dir: string;
  exists: boolean;
  files: number;
  bytes: number;
  /** The most recently written cache file's mtime, when there is one. */
  newestMtimeMs?: number;
}

/** What `foster doctor` reports: size and age, read directly off the files. */
export function cacheStats(dir: string): CacheStats {
  if (!existsSync(dir)) return { dir, exists: false, files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  let newest: number | undefined;
  for (const entry of readdirSync(dir)) {
    let stat;
    try {
      stat = statSync(path.join(dir, entry));
    } catch {
      // Removed between the listing and the stat; counts for nothing.
      continue;
    }
    if (!stat.isFile()) continue;
    files += 1;
    bytes += stat.size;
    if (newest === undefined || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return {
    dir,
    exists: true,
    files,
    bytes,
    ...(newest === undefined ? {} : { newestMtimeMs: newest }),
  };
}

/** `foster cache clear`: every file in the cache directory, removed. */
export function clearCache(dir: string): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    try {
      rmSync(path.join(dir, entry), { force: true });
      removed += 1;
    } catch {
      // Best effort: a file another process is mid-write on is left for that
      // writer to replace, not fought over.
    }
  }
  return removed;
}

export function ensureCacheDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
