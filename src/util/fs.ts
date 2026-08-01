import { readdirSync, statSync } from 'node:fs';

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

/** Normalises a thrown value into the message recorded in the ledger and shown to the user. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
