import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.js';
import type { AccountRef, CodeSessionData, Unfosterable } from './types.js';

/** Marks a session in the sidebar as living under an account that is not its origin. */
export const DEFAULT_PREFIX = '↪ ';

const SESSION_ID_PREFIX = 'local_';

/**
 * Every copy gets an identifier the server has never issued. That is what makes
 * fostering safe: deleting the copy in the app can never reach the original
 * session, and no global index can collide on the id.
 */
export function mintSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID()}`;
}

export function applyPrefix(title: string | undefined, prefix: string): string {
  const base = stripPrefix(title ?? '', prefix);
  return `${prefix}${base}`;
}

/** Idempotent: applying a prefix twice must not produce "↪ ↪ title". */
export function stripPrefix(title: string, prefix: string): string {
  let out = title;
  while (prefix.length > 0 && out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

/**
 * Reasons a session on disk should not be offered for fostering.
 *
 * Scheduled-task sessions and sessions that were never opened do not appear under
 * the sidebar's "Recents", so copying them would produce a file that silently
 * never shows up.
 */
export function unfosterableReasons(data: CodeSessionData): Unfosterable[] {
  const reasons: Unfosterable[] = [];
  if (data.scheduledTaskId) reasons.push('scheduled-task');
  if (data.lastFocusedAt === undefined) reasons.push('never-opened');
  if (data.isArchived) reasons.push('archived');
  if (data._foster) reasons.push('already-a-copy');
  return reasons;
}

export interface BuildCopyOptions {
  origin: AccountRef;
  prefix?: string;
  now?: number;
  sessionId?: string;
}

/**
 * Produce the session object to write into the target account's directory.
 *
 * Unknown keys are carried over untouched — the app normalises the file itself on
 * first open. Only four things change: a fresh identity, the fostering marker, the
 * prefixed title, and the removal of any stale error inherited from the origin
 * account (which the sidebar would otherwise render as a warning badge).
 */
export function buildFosterCopy(
  source: CodeSessionData,
  options: BuildCopyOptions,
): CodeSessionData {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const copy: CodeSessionData = { ...source };

  delete copy.error;
  delete copy.errorAt;

  copy.sessionId = options.sessionId ?? mintSessionId();
  copy.title = applyPrefix(source.title, prefix);
  copy._foster = {
    originAccountUuid: options.origin.accountUuid,
    originOrganizationUuid: options.origin.organizationUuid,
    originSessionId: source.sessionId,
    fosteredAt: options.now ?? Date.now(),
    toolVersion: VERSION,
  };

  return copy;
}

/** Key used to make fostering idempotent: one active copy per origin session per target account. */
export function fosteringKey(originSessionId: string, target: AccountRef): string {
  return `${originSessionId}@${target.accountUuid}/${target.organizationUuid}`;
}
