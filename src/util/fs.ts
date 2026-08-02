import { readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * Directory listing that treats an unreadable path as empty.
 *
 * Shared rather than duplicated per module: hardening it in one place (for
 * example, to distinguish a missing directory from a permissions failure on the
 * packaged store) must change the behaviour of every scan at once.
 */
export function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A file whose whole contents are one epoch-millisecond number, as the app's
 * deletion markers are. Anything else — missing, unreadable, not a number — is
 * "no time recorded" rather than an error: the marker's existence is the fact
 * that matters, and its timestamp is a courtesy.
 */
export function readTimestampFile(file: string): number | undefined {
  try {
    const at = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(at) && at > 0 ? at : undefined;
  } catch {
    return undefined;
  }
}

/** Normalises a thrown value into the message recorded in the ledger and shown to the user. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
