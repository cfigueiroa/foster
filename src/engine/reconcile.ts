import { existsSync } from 'node:fs';
import path from 'node:path';
import { tombstoneFileName } from '../domain/naming.js';
import { layoutFor, storeRootOfCopy } from '../domain/paths.js';
import type { ActiveFostering } from '../ledger/types.js';
import { isDirectory, readTimestampFile } from '../util/fs.js';

/**
 * What became of a copy the ledger still counts as active.
 *
 * The ledger is the record of what foster did, not a claim about what is on disk
 * now: a copy can be deleted in the app, which foster never hears about. Left
 * unexamined that turns into a dead end — fostering the same session again is
 * skipped as "already fostered" while nothing is there, and the tool looks
 * broken.
 *
 * Three answers matter and they are genuinely different:
 *
 *  - **deleted in the app.** The app leaves a `deleted_<id>` marker with the time,
 *    so this is not an inference: the user threw that copy away on purpose. Making
 *    a bulk run resurrect it would undo a decision they made deliberately.
 *  - **gone.** No marker, and the directory that should hold it lists without it.
 *    Nobody deleted it through the app: a crash between the unlink and the ledger
 *    append during a return, or a file removed by hand. Recreating it is what was
 *    asked for.
 *  - **unreachable.** The directory does not list at all. Copies can live in
 *    another installation — a profile on a removable drive, a folder that is not
 *    mounted — and "the file is not there" then means "not right now". Concluding
 *    anything would produce a second copy the moment the drive came back.
 */
export type CopyState =
  | { kind: 'present' }
  | { kind: 'deleted-in-app'; deletedAt?: number }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

export function inspectCopy(fostering: ActiveFostering): CopyState {
  if (existsSync(fostering.copyPath)) return { kind: 'present' };

  // The directory two levels of UUID deep, not the installation root: a removable
  // drive can come back under the same letter holding something else entirely,
  // and a root that exists proves nothing about the subtree. Asking whether this
  // exact account directory lists also covers the Windows case where existsSync
  // answers false for a permission error rather than for absence.
  const dir = path.dirname(fostering.copyPath);
  if (!isDirectory(dir)) {
    // The account directory can disappear on its own — signing out of that
    // account takes the whole tree with it. That is not "unreachable": if the
    // installation's sessions directory is there, this store is mounted and the
    // copy really has gone.
    const sessions = layoutFor(storeRootOfCopy(fostering.copyPath)).codeSessionsDir;
    return isDirectory(sessions) ? { kind: 'gone' } : { kind: 'unreachable' };
  }

  const marker = path.join(dir, tombstoneFileName(fostering.copySessionId));
  if (!existsSync(marker)) return { kind: 'gone' };

  const deletedAt = readTimestampFile(marker);
  return deletedAt === undefined
    ? { kind: 'deleted-in-app' }
    : { kind: 'deleted-in-app', deletedAt };
}
