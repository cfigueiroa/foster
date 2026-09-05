import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.js';
import { SESSION_ID_PREFIX } from './naming.js';
import { samePath } from './paths.js';
import type { AccountRef, CodeSessionData, Unfosterable } from './types.js';

/**
 * The app's own worktree layout, which is `<repo>/.claude/worktrees/<name>`.
 * Matching the shape is not the same as guessing: a directory that does not end
 * this way is left exactly as it came.
 */
const WORKTREE_TAIL = /[/\\]\.claude[/\\]worktrees[/\\][^/\\]+[/\\]?$/;

/** The repository a worktree was cut from, or the directory itself when it is not one. */
function repositoryOf(dir: string): string {
  const trimmed = dir.replace(WORKTREE_TAIL, '');
  return trimmed === '' ? dir : trimmed;
}

/**
 * Prefix put in front of a copy's title. Empty by default: no marker at all.
 *
 * It was `↪ ` until the reasoning behind it stopped holding. A copy saying so in
 * the sidebar is worth something while fostering is the exception; it is worth
 * nothing once fostering is how the sidebar gets filled. Measured on a swept
 * store: of 764 rows in the account in use, 704 were copies. The marker sat on
 * 92% of the list, so it separated nothing, and the 60 native rows — the ones a
 * reader would actually want picked out — were the unmarked ones.
 *
 * It was not honest either, because the title is the app's to rewrite. A copy the
 * app renames comes back without the prefix, and a session the app forks from a
 * copy inherits it while being no copy at all. On that same store the titles
 * disagreed with the ledger in five places, in both directions, with nobody
 * having edited anything by hand.
 *
 * Nothing decides anything by this. `return` selects from the ledger, and the one
 * title filter reads `originalTitle`, which never carried a prefix — so the
 * prefix is a display choice, and the display that cannot be wrong is foster's
 * own list, which draws its arrow from the ledger. `--prefix` brings a marker
 * back for anyone who wants one.
 */
export const DEFAULT_PREFIX = '';

/**
 * Shown to someone who opens "Change the title prefix" and now finds the field
 * empty. It is the marker copies used to carry, offered as an example of what
 * goes in the box — never applied unless it is typed.
 */
export const EXAMPLE_PREFIX = '↪ ';

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
    // The transcript records where the conversation ran, which is a worktree
    // whenever the app gave it one — and a restored card that opens there would
    // land inside a directory another card holds, with no repository to fall
    // back to, since both fields would name the worktree. So the repository is
    // what goes in: the worktree the conversation used is gone or spoken for by
    // the time a deletion is being undone, and the app cuts a fresh one when the
    // conversation next needs to edit.
    ...(facts.cwd === undefined
      ? {}
      : { cwd: repositoryOf(facts.cwd), originCwd: repositoryOf(facts.cwd) }),
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
  /**
   * What the copy's archived flag should be, whatever the source's is. Left out,
   * the copy keeps the source's — the ordinary case, and the one the sweep's
   * "archived stays archived" rests on. The branch pass sets it: a row for the
   * branch that stopped goes to the archived view however its source is filed.
   */
  archived?: boolean;
}

/**
 * Produce the session object to write into the target account's directory.
 *
 * Unknown keys are carried over untouched — the app normalises the file itself on
 * first open. Five things change: a fresh identity, the fostering marker, the
 * prefixed title, the removal of any stale error inherited from the origin
 * account (which the sidebar would otherwise render as a warning badge), and the
 * worktree the source holds, which is dropped along with the `cwd` inside it for
 * the reason spelled out below.
 */
export function buildFosterCopy(
  source: CodeSessionData,
  options: BuildCopyOptions,
): CodeSessionData {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const copy: CodeSessionData = { ...source };

  delete copy.error;
  delete copy.errorAt;

  // A lease on a worktree does not travel with a copy.
  //
  // A card names the worktree it holds (`worktreePath`/`worktreeName`) while the
  // lease itself lives in the app's own store of worktrees, keyed by the session
  // id that took it out. A copy mints a fresh id, so what it would inherit is the
  // claim without the lease: two cards naming one directory, and — since a branch
  // can only be checked out in one worktree — a git refusal for whichever of them
  // the app reaches second. That session lands in the main repository instead and
  // loses whatever it had not committed. Measured on a real store, 1100 cards
  // named a worktree; of the 853 whose card was still live, 88% named a
  // directory that no longer existed.
  //
  // Naming the fields is not enough to recognise the state, which is why the
  // test is on the directory as well: a card whose `cwd` is not its `originCwd`
  // is sitting in a worktree whether or not it says so. On that same store 3898
  // cards had a `cwd` under `.claude/worktrees/`, and 2798 of them named no
  // worktree at all — 2469 pointing at a directory that was already gone. Every
  // card whose `cwd` differed from its `originCwd` was in a worktree, so the
  // wider test brought in no other kind of directory. `worktreeLazy` is a
  // worktree the app has promised but not yet cut, and it travels no better.
  //
  // `originCwd` is the repository the worktree came from, and the copy opens
  // there instead. A source without one keeps the directory it had — there is
  // nowhere else to send it.
  const inWorktree =
    copy.worktreePath !== undefined ||
    copy.worktreeName !== undefined ||
    copy.worktreeLazy !== undefined ||
    (typeof copy.cwd === 'string' &&
      typeof copy.originCwd === 'string' &&
      copy.originCwd !== '' &&
      !samePath(copy.cwd, copy.originCwd));
  if (inWorktree) {
    delete copy.worktreePath;
    delete copy.worktreeName;
    delete copy.worktreeLazy;
    if (typeof copy.originCwd === 'string' && copy.originCwd !== '') copy.cwd = copy.originCwd;
  }

  // What made the original invisible outside its own account, dropped so the copy
  // is an ordinary conversation.
  //
  // Unconditional, because a copy is never the task. The schedule lives in the
  // account that owns it and keeps running there; carrying the id across would
  // name a task this account does not have, and the app would file the row where
  // it files scheduled tasks — which is to say, not under Recents. The
  // conversation is the part worth having, and without the id it is just a
  // conversation. `lastFocusedAt` is set for the same reason restore sets it: a
  // card without one counts as never opened, which is the other way to be
  // correct and invisible.
  if (copy.scheduledTaskId !== undefined) {
    delete copy.scheduledTaskId;
    copy.lastFocusedAt = source.lastFocusedAt ?? options.now ?? Date.now();
  }

  if (options.archived !== undefined) copy.isArchived = options.archived;

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

/**
 * Key used to make fostering idempotent: one active copy per origin session, per
 * target account, **per conversation**.
 *
 * The conversation is part of the identity because a card is not one. Opening a
 * conversation that is live elsewhere makes the app branch it: it writes a new
 * transcript and repoints the card at the branch. That happens to origin cards
 * too, and then the ledger — keyed on the card alone — answered "already
 * fostered" for a conversation it had never copied, and no sweep would bring it
 * again. Measured on a real store: 38 of 8312 active fosterings had an origin
 * card holding a conversation other than the one recorded for it.
 *
 * Left out when the conversation is unknown, which keeps the key events written
 * before it was recorded still fold to what they always did.
 */
export function fosteringKey(
  originSessionId: string,
  target: AccountRef,
  cliSessionId?: string,
): string {
  // Case folded, as this identifier is everywhere else it is compared.
  const work = cliSessionId ? `#${cliSessionId.toLowerCase()}` : '';
  return `${originSessionId}${work}@${target.accountUuid}/${target.organizationUuid}`;
}
