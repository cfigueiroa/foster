import { constants as fsConstants, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
 * label plus the writing process's pid plus a process-lifetime counter — so no
 * two calls, however close together, ever share a path.
 *
 * The pid alone does not finish the job: the timestamp directory
 * (second-resolution) is itself built from `now`, and a clock that has not
 * ticked yet is exactly the case that used to bite (bug measured 22/09/2026 —
 * a detached `foster layout --restart` and the in-app process it was
 * restarting around, both writing backups within the same second). `backupFile`
 * asks for the name `COPYFILE_EXCL`-only, so a name reused anyway — a clock
 * that jumped backwards, or a `now()` fixture two callers happen to share in a
 * test — fails loudly instead of quietly overwriting the earlier backup, and
 * is retried once under a new suffix rather than left to throw.
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
function freshName(kind: string, now: Date, ext: string, retry: number): string {
  counter += 1;
  const suffix = retry > 0 ? `-r${retry}` : '';
  return `${kind}-${now.getTime()}-${process.pid}-${counter}${suffix}${ext}`;
}

export interface BackupOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * Copy one file aside. `kind` names what is being backed up, for a readable
 * directory listing.
 *
 * The destination is opened with `COPYFILE_EXCL` — it fails rather than
 * silently overwrites an existing file at that name — and on `EEXIST` this
 * retries once under a new, still-fresh suffix rather than throwing: the name
 * is meant to be unique on its own, so a collision is the rare case worth one
 * more try, not a reason to give up the backup.
 */
export function backupFile(source: string, kind: string, options: BackupOptions = {}): string {
  const now = options.now?.() ?? new Date();
  const dir = runDir(backupsRoot(options.env), now);
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(source);
  for (let retry = 0; ; retry += 1) {
    const dest = path.join(dir, freshName(kind, now, ext, retry));
    try {
      copyFileSync(source, dest, fsConstants.COPYFILE_EXCL);
      return dest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && retry < 5) continue;
      throw error;
    }
  }
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
  const dest = path.join(runDir(backupsRoot(options.env), now), freshName(kind, now, '', 0));
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name === 'LOCK') continue;
    const from = path.join(source, name);
    if (statSync(from).isFile()) copyFileSync(from, path.join(dest, name));
  }
  return dest;
}
