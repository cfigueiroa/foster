import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where a write-with-app-closed command copies a file or a directory before
 * touching it — outside the Claude Desktop store entirely, the same place
 * `defaultLedgerPath` keeps the ledger, and relocatable the same way
 * (`FOSTER_HOME`).
 *
 * Earlier code put each backup next to the file it copied
 * (`<file>.bak-<second-resolution stamp>`), which sat inside the app's own
 * store and — worse — let two writes in the same run collide on one name: a
 * layout run that touches `claude_desktop_config.json` twice (once for groups,
 * once for the view-menu carry) took its second "backup" of the file the first
 * write had already changed, silently discarding the true original. Every
 * backup here gets its own name — a run-scoped timestamp directory plus a kind
 * label plus a process-lifetime counter — so no two calls, however close
 * together, ever share a path.
 */

let counter = 0;

export function backupsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.FOSTER_HOME ?? path.join(homedir(), '.foster'), 'backups');
}

function runDir(root: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15);
  return path.join(root, stamp);
}

/** A destination this call alone will ever be given — never reused, never guessed twice. */
function freshName(kind: string, now: Date, ext: string): string {
  counter += 1;
  return `${kind}-${now.getTime()}-${counter}${ext}`;
}

export interface BackupOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Copy one file aside. `kind` names what is being backed up, for a readable directory listing. */
export function backupFile(source: string, kind: string, options: BackupOptions = {}): string {
  const now = options.now?.() ?? new Date();
  const dir = runDir(backupsRoot(options.env), now);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, freshName(kind, now, path.extname(source)));
  copyFileSync(source, dest);
  return dest;
}

/**
 * Copy a whole directory aside — for a LevelDB store, which is a directory of
 * files rather than one file. Mirrors `pinstate.ts`'s `backupPinState`: `LOCK`
 * is skipped (Chromium recreates it, and copying it fails while anything holds
 * it), and a file that cannot be copied is a reason to stop, not to skip —
 * this is the one copy standing between a write and the app's own database.
 */
export function backupDirectory(source: string, kind: string, options: BackupOptions = {}): string {
  const now = options.now?.() ?? new Date();
  const dest = path.join(runDir(backupsRoot(options.env), now), freshName(kind, now, ''));
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name === 'LOCK') continue;
    const from = path.join(source, name);
    if (statSync(from).isFile()) copyFileSync(from, path.join(dest, name));
  }
  return dest;
}
