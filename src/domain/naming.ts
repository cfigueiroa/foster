/**
 * Single source of truth for how Claude Desktop names session files.
 *
 * These conventions were previously repeated across the minting, scanning,
 * tombstone and display paths. Keeping them here means a change to the scheme
 * cannot leave one half of the tool writing files the other half ignores.
 */

/** The app prefixes every Code session id, and therefore every session file. */
export const SESSION_ID_PREFIX = 'local_';

/** Deleting a session in the app leaves `deleted_<bare id>` beside the sessions. */
export const TOMBSTONE_PREFIX = 'deleted_';

/** Session ids inside tombstone filenames are stored without the app's prefix. */
export function bareSessionId(id: string): string {
  return id.startsWith(SESSION_ID_PREFIX) ? id.slice(SESSION_ID_PREFIX.length) : id;
}

export function sessionFileName(sessionId: string): string {
  return `${sessionId}.json`;
}

/** True for the filenames the app treats as Code sessions. */
export function isSessionFileName(name: string): boolean {
  return name.startsWith(SESSION_ID_PREFIX) && name.endsWith('.json');
}

export function tombstoneFileName(id: string): string {
  return `${TOMBSTONE_PREFIX}${bareSessionId(id)}`;
}

export function isTombstoneFileName(name: string): boolean {
  return name.startsWith(TOMBSTONE_PREFIX);
}
