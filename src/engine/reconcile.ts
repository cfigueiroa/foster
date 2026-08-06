import { existsSync, readFileSync } from 'node:fs';
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
 *  - **repurposed.** The file is there and no longer holds the conversation it was
 *    made for. Opening a copy of a conversation that is live elsewhere makes the
 *    app branch rather than continue it: it writes a new transcript and repoints
 *    the card at the branch. The copy is then a perfectly good card for a
 *    different conversation, and the one it was fostered for has no card here at
 *    all — while the ledger, which only knows a file was written, keeps answering
 *    "already fostered" and refuses to bring it again. Measured on a real store:
 *    a copy made at 06:30 for one conversation pointed at a branch born at 09:55.
 */
export type CopyState =
  | { kind: 'present' }
  | { kind: 'deleted-in-app'; deletedAt?: number }
  | { kind: 'gone' }
  | { kind: 'unreachable' }
  | { kind: 'repurposed'; nowHolds?: string };

export function inspectCopy(fostering: ActiveFostering): CopyState {
  if (existsSync(fostering.copyPath)) {
    // Present is not the same as still-the-same. The conversation the copy was
    // made for is the only thing that makes it the copy of anything; a card that
    // has moved on is evidence the fostering no longer stands, not that it does.
    const holds = conversationOf(fostering.copyPath);
    // Compared with case folded, as this identifier is everywhere else it is
    // compared. Reading a difference in capitalisation as a different
    // conversation would disown a copy that holds exactly the one it was made
    // for, and mint a second card for it — the duplicate `conversationsHere`
    // exists to prevent.
    if (
      fostering.cliSessionId &&
      holds &&
      holds.toLowerCase() !== fostering.cliSessionId.toLowerCase()
    ) {
      return { kind: 'repurposed', nowHolds: holds };
    }
    return { kind: 'present' };
  }

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

/**
 * The conversation a card on disk currently points at, or undefined when the file
 * cannot be read as one. Unreadable means "do not conclude anything": a card
 * mid-write, or one this cannot parse, must not be mistaken for a repurposed one.
 */
function conversationOf(copyPath: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(copyPath, 'utf8')) as { cliSessionId?: unknown };
    return typeof data.cliSessionId === 'string' ? data.cliSessionId : undefined;
  } catch {
    return undefined;
  }
}
