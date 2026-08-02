import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
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
 * corrupt. rename is atomic within a directory, and the contents are flushed
 * before it: without the fsync a crash can persist the rename while the data
 * blocks are still in cache, publishing a truncated file at the final path —
 * precisely the torn read this function exists to prevent.
 */
export function writeFileAtomic(target: string, contents: string): void {
  const tmp = path.join(path.dirname(target), `.foster-tmp-${process.pid}-${randomUUID()}`);
  const fd = openSync(tmp, 'wx');
  try {
    const buffer = Buffer.from(contents, 'utf8');
    // writeSync may report a short write; keep going until the buffer is drained.
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, target);
  } catch (error) {
    // Never leave temp litter behind in the live store.
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: the rename failure is the error worth reporting.
    }
    throw error;
  }
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
