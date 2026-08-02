import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.js';
import { SESSION_ID_PREFIX } from './naming.js';
import type { AccountRef, CodeSessionData, Unfosterable } from './types.js';

/** Marks a session in the sidebar as living under an account that is not its origin. */
export const DEFAULT_PREFIX = '↪ ';

/** What a copy is called when the session it came from never got a title. */
export const UNTITLED = '(untitled)';

/**
 * Every copy gets an identifier the server has never issued. That is what makes
 * fostering safe: deleting the copy in the app can never reach the original
 * session, and no global index can collide on the id.
 */
export function mintSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID()}`;
}

/**
 * Idempotent: applying a prefix twice must not produce "↪ ↪ title".
 *
 * A title that genuinely begins with the prefix is left exactly as it is. The
 * previous version stripped every leading occurrence before re-adding one, which
 * quietly rewrote real titles — fostering "old-notes" with `--prefix "old-"`
 * produced "old-notes" again, with no marker, and recorded "notes" as the
 * original. Treating an already-prefixed title as done costs nothing and cannot
 * corrupt anything.
 */
export function applyPrefix(title: string | undefined, prefix: string): string {
  const base = title ?? '';
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

/**
 * Reasons a session on disk should not be offered for fostering.
 *
 * Scheduled-task sessions and sessions that were never opened do not appear under
 * the sidebar's "Recents", so copying them would produce a file that silently
 * never shows up.
 */
export function unfosterableReasons(data: CodeSessionData, knownCopy = false): Unfosterable[] {
  const reasons: Unfosterable[] = [];
  if (data.scheduledTaskId) reasons.push('scheduled-task');
  if (data.lastFocusedAt === undefined) reasons.push('never-opened');
  if (data.isArchived) reasons.push('archived');
  // The marker is not the only evidence, and it is not durable: the app writes a
  // session back through a fixed list of fields, so a copy it has loaded and
  // saved comes back without `_foster`. The caller passes what the ledger knows.
  if (data._foster || knownCopy) reasons.push('already-a-copy');
  return reasons;
}

/**
 * Rebuild the session a deletion threw away, from the conversation it left.
 *
 * Deleting removes the pointer and keeps the transcript, so everything worth
 * having is still on disk — just not in a form the app will list. This
 * reconstructs the pointer: the identity is the conversation's own id, which is
 * the convention the app itself uses when it imports one, and the title, working
 * directory and dates come from the transcript rather than being invented.
 *
 * `lastFocusedAt` matters more than it looks. A session without it counts as
 * never opened and never appears under Recents, so a restore that left it unset
 * would write a file that is correct and invisible.
 */
export function buildRestoredSession(facts: {
  cliSessionId: string;
  cwd?: string;
  title?: string;
  createdAt?: number;
  lastActivityAt?: number;
}): CodeSessionData {
  const at = facts.lastActivityAt ?? facts.createdAt ?? Date.now();
  return {
    sessionId: `${SESSION_ID_PREFIX}${facts.cliSessionId}`,
    cliSessionId: facts.cliSessionId,
    ...(facts.cwd === undefined ? {} : { cwd: facts.cwd, originCwd: facts.cwd }),
    // An untitled restore is still worth having; it just says what it is. Left
    // unset, the app labels it "General coding session", which is indistinguishable
    // from every other untitled one — worse than blank for finding it again.
    title: facts.title ?? '(recovered conversation)',
    // Where the title genuinely came from: the app's own ai-title record in the
    // transcript. Real sessions carry 'auto' for that and 'user' for a manual
    // rename, and claiming the latter would misdescribe who chose it.
    titleSource: 'auto',
    createdAt: facts.createdAt ?? at,
    lastActivityAt: at,
    lastFocusedAt: at,
    isArchived: false,
  };
}

export interface BuildCopyOptions {
  origin: AccountRef;
  /**
   * The store the session came from, recorded only when it is not the store the
   * copy is being written into. Two installations can hold the same account
   * identifier, so without this a cross-profile copy would describe an origin
   * that cannot be located.
   */
  originStore?: string;
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
  // A session with no title would otherwise become a copy titled with nothing but
  // the marker — "↪ " — which says it is a copy and nothing else. Saying it had
  // no title is more use than a bare prefix, and the app's own fallback label is
  // indistinguishable from every other untitled session.
  copy.title = applyPrefix(source.title?.trim() ? source.title : UNTITLED, prefix);
  copy._foster = {
    originAccountUuid: options.origin.accountUuid,
    originOrganizationUuid: options.origin.organizationUuid,
    originSessionId: source.sessionId,
    ...(options.originStore ? { originStore: options.originStore } : {}),
    fosteredAt: options.now ?? Date.now(),
    toolVersion: VERSION,
  };

  return copy;
}

/** Key used to make fostering idempotent: one active copy per origin session per target account. */
export function fosteringKey(originSessionId: string, target: AccountRef): string {
  return `${originSessionId}@${target.accountUuid}/${target.organizationUuid}`;
}
