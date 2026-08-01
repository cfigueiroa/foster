import {
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Write via a temporary file and rename into place.
 *
 * The app parses these files at startup; a partially written one would be read as
 * corrupt. rename is atomic within a directory, so the file is either absent or
 * complete — never half there.
 */
export function writeFileAtomic(target: string, contents: string): void {
  const tmp = path.join(path.dirname(target), `.foster-tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, contents, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

/**
 * Remove a path without ever following a reparse point.
 *
 * A junction or symlink must be unlinked as a link. Deleting one recursively
 * would walk into the target and destroy the real directory it points at, which
 * is the difference between undoing a change and losing data. lstat (not stat)
 * is what makes the check see the link itself rather than what it points to.
 */
export function removeSafely(target: string): boolean {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return false;
  }

  if (stats.isSymbolicLink() || stats.isDirectory()) {
    // rmdir on a link removes the link entry; on a real directory it only
    // succeeds when empty, so it can never wipe populated content by accident.
    try {
      rmdirSync(target);
      return true;
    } catch {
      unlinkSync(target);
      return true;
    }
  }

  unlinkSync(target);
  return true;
}

/** True when the path is a reparse point (junction or symlink) rather than a real file. */
export function isLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}
