import { lstatSync, readlinkSync, statSync, symlinkSync } from 'node:fs';
import { samePath } from '../domain/paths.js';
import { isDirectory } from '../util/fs.js';
import { removeSafely } from './fsatomic.js';

/**
 * Repointing a directory link at a different client.
 *
 * The second way to change which account something runs as, and the one that
 * changes it for *something* rather than for the machine. A swap of the
 * credential file changes the account every new `claude` picks up; a link lets
 * one consumer — a daemon, a scheduled job, a fleet — follow a directory of its
 * own, while the user's own terminals carry on wherever they were.
 *
 * The arrangement is: each account gets its own config directory, logged into
 * once; a link points at whichever is active; the consumer runs with
 * `CLAUDE_CONFIG_DIR` set to the link. Switching is repointing the link. Nothing
 * is logged out, no credential moves, and no restart is needed, because the path
 * is resolved afresh every time a file is opened.
 *
 * That last property is also the trap, and it is worth stating because it is
 * counter-intuitive: resolving on every open means a process that opened the
 * link *before* the flip writes through it *after* the flip, into the new
 * target. A link does not isolate a running process from a switch — only a
 * separate directory that the process's own environment names does that. So the
 * flip is safe when the consumer is quiet and racy when it is not, and this
 * module's job is to say which of those it is looking at rather than to pretend
 * the question does not arise.
 */

export interface PointerState {
  link: string;
  /** What it points at now, when it is a link at all. */
  target?: string;
  /** What kind of thing sits at the link path. */
  kind: 'junction' | 'directory' | 'missing' | 'file';
}

export interface PointerPlan {
  state: PointerState;
  to: string;
  blockers: string[];
}

/** What is at a link path right now, without following it. */
export function inspectPointer(link: string): PointerState {
  let stats;
  try {
    stats = lstatSync(link);
  } catch {
    return { link, kind: 'missing' };
  }

  if (stats.isSymbolicLink()) {
    // A link is not automatically a directory link. `isSymbolicLink` is equally
    // true of a symlink to a file, and calling that one a junction would let it
    // past the refusal below and straight into `removeSafely` — deleting a link
    // the user made. So the link is followed once to see what it actually
    // reaches. A dangling link resolves to nothing and stays a junction: there
    // is no target to judge, and refusing to repoint a broken link would refuse
    // exactly the case repointing fixes.
    let resolved;
    try {
      resolved = statSync(link);
    } catch {
      resolved = undefined;
    }
    if (resolved && !resolved.isDirectory()) return { link, kind: 'file' };

    let target: string | undefined;
    try {
      // Windows hands back the verbatim form for a junction; the prefix is an
      // implementation detail of the reparse point, not part of the path anyone
      // typed, and leaving it in makes every comparison downstream fail.
      target = readlinkSync(link).replace(/^\\\\\?\\/, '');
    } catch {
      target = undefined;
    }
    return { link, kind: 'junction', ...(target ? { target } : {}) };
  }

  return { link, kind: stats.isDirectory() ? 'directory' : 'file' };
}

/**
 * What a repoint would do.
 *
 * The refusal that matters is the third one. A real directory sitting at the
 * link path is not a link that has gone wrong — it is somebody's data, and the
 * flip would begin by deleting it. `removeSafely` is careful enough to unlink a
 * junction without touching its target, but nothing makes deleting a populated
 * directory safe, so this stops before it starts and says what it found.
 */
export function planPointer(link: string, to: string): PointerPlan {
  const state = inspectPointer(link);
  const blockers: string[] = [];

  if (!isDirectory(to)) {
    blockers.push(`${to} is not a directory`);
  }
  if (state.kind === 'file') {
    blockers.push(`${link} is a file, not a link`);
  }
  if (state.kind === 'directory') {
    blockers.push(
      `${link} is a real directory, not a link. Repointing would delete it; ` +
        'move it aside yourself if that is what you meant.',
    );
  }
  if (state.target && samePath(state.target, to)) {
    blockers.push(`${link} already points at ${to}`);
  }

  return { state, to, blockers };
}

/**
 * Repoint the link.
 *
 * There is a window here that cannot be closed: Windows has no atomic replace
 * for a reparse point, so the old link is removed and the new one created, and
 * for a few milliseconds the path does not exist. A `claude` starting in that
 * window fails to find its config directory and says so, which is a loud
 * failure and a recoverable one — the alternative designs all trade that for a
 * silent wrong answer, which is worse.
 *
 * What must not happen is the window staying open for ever. If creating the new
 * link fails — the target gone since the plan, a path over the length limit, a
 * policy that denies reparse points — then the old link has already been
 * removed and there is nothing at that path at all, which breaks every consumer
 * pointed at it until somebody recreates it by hand. So the previous target is
 * held and put back, and the message says whether that worked: a failed flip
 * should cost nothing, and when it cannot be made to cost nothing, it should at
 * least be loud about what it left behind.
 */
export function applyPointer(
  plan: PointerPlan,
  // Injected for the same reason `liveSessions` takes its liveness check: the
  // restore path only runs when link creation fails, and Windows will not fail
  // on demand — a junction is created without validating its target, so no
  // fixture makes the real call throw.
  createLink: (target: string, link: string) => void = (target, link) =>
    symlinkSync(target, link, 'junction'),
): { ok: boolean; message: string } {
  if (plan.blockers.length > 0) return { ok: false, message: plan.blockers[0]! };

  const previous = plan.state.kind === 'junction' ? plan.state.target : undefined;
  if (plan.state.kind === 'junction') removeSafely(plan.state.link);

  try {
    createLink(plan.to, plan.state.link);
  } catch (error) {
    const failure = `could not create the junction: ${(error as Error).message}`;
    if (!previous) return { ok: false, message: failure };

    try {
      createLink(previous, plan.state.link);
      return { ok: false, message: `${failure}. ${plan.state.link} still points at ${previous}.` };
    } catch {
      return {
        ok: false,
        message:
          `${failure}. Worse, the previous link could not be restored either, so ` +
          `${plan.state.link} does not exist right now — recreate it pointing at ${previous}.`,
      };
    }
  }

  const after = inspectPointer(plan.state.link);
  if (after.kind !== 'junction' || !after.target) {
    return { ok: false, message: `${plan.state.link} is not a junction after writing it` };
  }
  if (!samePath(after.target, plan.to)) {
    return { ok: false, message: `${plan.state.link} landed on ${after.target}, not ${plan.to}` };
  }

  return { ok: true, message: `${plan.state.link} now points at ${plan.to}` };
}
