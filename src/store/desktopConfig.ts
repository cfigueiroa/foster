import { readFileSync } from 'node:fs';
import type { StoreLayout } from '../domain/types.js';
import { writeFileAtomic } from '../util/fsatomic.js';
import { backupFile, type BackupOptions } from '../util/backups.js';
import { nonCanonicalNumbers } from '../util/jsonNumbers.js';

/**
 * The one safe way to rewrite `claude_desktop_config.json` — the file
 * `appPrefs.ts`, `groupScopes.ts` and `viewPrefs.ts` all share with the MCP
 * server list and everything else the app keeps there.
 *
 * Before this, each of the three carried its own copy of the same shape: read
 * the file twice (once to diff against, once to mutate), refuse up front on a
 * number literal a `JSON.parse`/`stringify` round trip would silently rewrite,
 * mutate the second parse, back the original up, compare every key the write
 * was not meant to touch, and only then write. The three copies had already
 * drifted — `writeAppPref` alone was missing the number-literal guard — which
 * is what `rewriteDesktopConfig` closes: one rewrite path, so a fix to it
 * reaches all three call sites instead of two of the three by accident.
 *
 * `allowedPaths` names every place `mutate` is permitted to change, each as a
 * chain of keys from the document root (`['preferences', 'menuBarEnabled']`,
 * or one entry per key `writeEpitaxyPrefs` is asked to set). An exact path is
 * a leaf write — the whole value there is expected to differ and is not
 * compared further. A path that is only a *prefix* of an allowed path is a
 * container being descended through on the way to one — everything else
 * alongside it, at every level, must come back unchanged or the write is
 * refused with the file untouched.
 */

export type ConfigPath = readonly string[];

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pathStatus(path: ConfigPath, allowed: readonly ConfigPath[]): 'exact' | 'prefix' | 'no' {
  let sawPrefix = false;
  for (const candidate of allowed) {
    if (candidate.length === path.length && candidate.every((seg, i) => seg === path[i])) {
      return 'exact';
    }
    if (candidate.length > path.length && path.every((seg, i) => seg === candidate[i])) {
      sawPrefix = true;
    }
  }
  return sawPrefix ? 'prefix' : 'no';
}

/**
 * Every path, at every level, where `before` and `after` disagree and
 * `allowedPaths` did not say that was expected. Recurses only through a path
 * that is itself a prefix of something allowed — an object elsewhere in the
 * document that merely happens to differ (it should not) is reported once, at
 * its own top level, rather than walked into.
 */
function movedPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowedPaths: readonly ConfigPath[],
  prefix: ConfigPath = [],
): string[] {
  const moved: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const here = [...prefix, key];
    const status = pathStatus(here, allowedPaths);
    if (status === 'exact') continue;
    if (status === 'prefix') {
      moved.push(...movedPaths(asObject(before[key]), asObject(after[key]), allowedPaths, here));
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      moved.push(here.join('.'));
    }
  }
  return moved;
}

export interface RewriteResult {
  backup: string;
}

/**
 * Read `store.desktopConfigFile`, let `mutate` change only what `allowedPaths`
 * lists, and write the result back — or refuse with the file untouched.
 *
 * Refused up front, before `mutate` even runs, if the raw file holds a number
 * literal a `JSON.parse`/`stringify` round trip would silently rewrite (an
 * integer past `Number.MAX_SAFE_INTEGER`, a trailing `.0`, exponent
 * notation…) — see `util/jsonNumbers.ts`. The "did anything else move" check
 * below compares two already-parsed trees, so a number that changed shape
 * during that same parse is invisible to it; this is the check that would
 * have caught it, so it runs first and writes nothing either way.
 *
 * A backup is taken — under `~/.foster/backups`, never next to the file it
 * copies, see `util/backups.ts` — before the comparison below, whether or not
 * that comparison ends up refusing the write: a refusal still leaves a copy
 * of what was there for whoever reads the "would have changed too" message.
 */
export function rewriteDesktopConfig(
  store: StoreLayout,
  kind: string,
  allowedPaths: readonly ConfigPath[],
  mutate: (after: Record<string, unknown>) => void,
  options: BackupOptions = {},
): RewriteResult {
  const raw = readFileSync(store.desktopConfigFile, 'utf8');
  const lossy = nonCanonicalNumbers(raw)[0];
  if (lossy) {
    throw new Error(
      `refusing to write: ${store.desktopConfigFile} holds a number literal that a JSON round-trip would rewrite (\`${lossy.literal}\`, at offset ${lossy.index}). Nothing was written.`,
    );
  }
  const before = JSON.parse(raw) as Record<string, unknown>;
  const after = JSON.parse(raw) as Record<string, unknown>;

  mutate(after);

  const backup = backupFile(store.desktopConfigFile, kind, options);

  const text = JSON.stringify(after, null, 2);
  const back = JSON.parse(text) as Record<string, unknown>;
  const moved = movedPaths(before, back, allowedPaths);
  if (moved.length > 0) {
    throw new Error(
      `refusing to write: ${moved.join(', ')} would have changed too. Nothing was written; the backup is at ${backup}`,
    );
  }

  writeFileAtomic(store.desktopConfigFile, text);
  return { backup };
}
