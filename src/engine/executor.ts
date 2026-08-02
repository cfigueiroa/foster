import { mkdirSync } from 'node:fs';
import { buildFosterCopy, DEFAULT_PREFIX, fosteringKey } from '../domain/fostering.js';
import { accountDir, sessionPath } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { errorMessage } from '../util/fs.js';
import { scanAccount, type KnownCopies } from '../store/scanner.js';
import { removeSafely, writeFileAtomic } from './fsatomic.js';
import { inspectCopy } from './reconcile.js';
import { assertRemovable, type RemovalGuard } from './safety.js';

export interface FosterOptions {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  /**
   * Where the sessions were read from, when that is not `store`. Recorded on the
   * copy so a cross-profile origin stays locatable.
   */
  sourceStore?: string;
  prefix?: string;
  /** When true, compute the plan without writing anything. */
  dryRun?: boolean;
  /**
   * True when the caller named these sessions one by one rather than sweeping a
   * whole account. Only an explicit choice brings back a copy the user deleted in
   * the app: a bulk run that resurrected it would undo their decision.
   */
  explicit?: boolean;
}

export type OutcomeStatus = 'fostered' | 'skipped' | 'failed' | 'returned';

export interface Outcome {
  originSessionId: string;
  title: string;
  status: OutcomeStatus;
  /** Present for skipped and failed entries. */
  detail?: string;
  copyPath?: string;
}

/**
 * Foster a batch of sessions into the target account.
 *
 * Each session is independent: a failure part-way through a few hundred does not
 * roll back what already succeeded, and the caller gets a per-session report.
 * Re-running is a no-op for anything already fostered, which is why the check is
 * keyed on the origin session rather than on a file (every copy gets a new id).
 */
export function fosterSessions(sessions: DiscoveredSession[], options: FosterOptions): Outcome[] {
  const { store, ledger, target, dryRun = false, explicit = false } = options;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const state = project(ledger.read());
  const outcomes: Outcome[] = [];
  // The projection is a snapshot, so keys minted during this batch are tracked
  // here too: the same origin session can appear twice in one run when it exists
  // under two account directories, and without this both would be copied while
  // the ledger fold kept only the last one — orphaning the first file.
  const mintedInBatch = new Set<string>();
  // What the destination already shows, keyed by conversation rather than by
  // session id. A conversation belongs to no account — it is one transcript that
  // any account can hold a card for — so the destination can perfectly well have
  // its own card for the very conversation being fostered, made when the same
  // work was resumed under this account. The fostering key cannot see that: the
  // origin is the *other* account's card, and it has never been fostered before.
  // The result is two rows for one conversation, differing only in which account
  // watched which part of it. Both are live, both are openable, and the sidebar
  // gives no hint they are the same.
  const conversationsHere = conversationsIn(store, target, copySessionIds(ledger.read()));

  // No gate here on purpose. Every copy gets a session id the app has never seen,
  // so a running app neither reads nor writes the file: it is invisible to the
  // app until the app next initialises, and cannot collide with anything the app
  // holds. See safety.ts for why removal is the asymmetric case.
  if (!dryRun && sessions.length > 0) mkdirSync(accountDir(store, target), { recursive: true });

  for (const session of sessions) {
    const title = session.data.title ?? '(untitled)';
    const originId = session.data.sessionId;

    if (session.reasons.length > 0) {
      outcomes.push({
        originSessionId: originId,
        title,
        status: 'skipped',
        detail: session.reasons.join(', '),
      });
      continue;
    }

    const key = fosteringKey(originId, target);
    if (mintedInBatch.has(key)) {
      outcomes.push({
        originSessionId: originId,
        title,
        status: 'skipped',
        detail: 'already fostered',
      });
      continue;
    }

    const active = state.active.get(key);
    if (active) {
      const skip = resolveExisting(active, { explicit, dryRun, ledger });
      if (skip) {
        outcomes.push({ originSessionId: originId, title, ...skip });
        continue;
      }
      // Reconciled: the ledger no longer counts it as active, so fall through and
      // make the copy the caller asked for.
      state.active.delete(key);
    }

    // Asked after the ledger, which knows about foster's own copies, and about
    // the destination rather than about anything foster has done: a conversation
    // already showing here would gain a second row for the same work.
    const cliSessionId = session.data.cliSessionId;
    if (cliSessionId && conversationsHere.has(cliSessionId) && !explicit) {
      outcomes.push({
        originSessionId: originId,
        title,
        status: 'skipped',
        detail: conversationsHere.get(cliSessionId)!,
      });
      continue;
    }

    const copy = buildFosterCopy(session.data, {
      origin: session.account,
      ...(options.sourceStore && options.sourceStore !== store.root
        ? { originStore: options.sourceStore }
        : {}),
      prefix,
    });
    const copyPath = sessionPath(store, target, copy.sessionId);

    if (dryRun) {
      outcomes.push({ originSessionId: originId, title, status: 'fostered', copyPath });
      continue;
    }

    try {
      // The write happens first, and only a completed write is recorded.
      //
      // Logging intent up-front would be nicer for forensics, but a failed write
      // would then leave a "fostered" event that the fold still counts as active
      // (a "failed" event does not cancel it), so the session would be skipped as
      // already fostered on every later run, with no file on disk. The reverse
      // order is self-healing instead: a crash between write and append leaves a
      // copy that carries its own _foster marker, which the scanner recognises.
      writeFileAtomic(copyPath, JSON.stringify(copy));
      ledger.append({
        kind: 'fostered',
        originSessionId: originId,
        origin: session.account,
        target,
        copySessionId: copy.sessionId,
        copyPath,
        // Recorded verbatim, and left out entirely when the session has no title.
        // Writing '' instead defeated every `originalTitle ?? fallback` downstream,
        // because an empty string is not nullish — status and return printed a
        // blank where they meant to print the session id.
        ...(session.data.title ? { originalTitle: session.data.title } : {}),
        // The conversation, which outlives both files and is where the work
        // actually is. Without it, telling the user that a returned copy had
        // carried on would mean reading a file that has just been deleted.
        ...(session.data.cliSessionId ? { cliSessionId: session.data.cliSessionId } : {}),
        ...(options.sourceStore && options.sourceStore !== store.root
          ? { originStore: options.sourceStore }
          : {}),
        prefix,
      });
      mintedInBatch.add(key);
      // Tracked as a conversation too: a sweep across two source accounts that
      // both hold a card for one conversation would otherwise pass this check
      // twice and produce the pair itself, in a single run.
      if (copy.cliSessionId) {
        conversationsHere.set(copy.cliSessionId, 'this account already has that conversation');
      }
      outcomes.push({ originSessionId: originId, title, status: 'fostered', copyPath });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'foster', originSessionId: originId, reason });
      outcomes.push({ originSessionId: originId, title, status: 'failed', detail: reason });
    }
  }

  return outcomes;
}

/**
 * The conversations the destination already shows, and how each got there.
 *
 * Archived counts as present: the row exists, and the answer to wanting it back
 * is to unarchive rather than to add a second one. A tombstone does not — a
 * deleted card is not a row, and bringing that conversation back is exactly what
 * fostering (or `restore`) is for.
 */
function conversationsIn(
  store: StoreLayout,
  target: AccountRef,
  copies: KnownCopies,
): Map<string, string> {
  const here = new Map<string, string>();

  for (const session of scanAccount(store, target, copies)) {
    const id = session.data.cliSessionId;
    if (!id) continue;
    const how = session.isCopy
      ? 'this account already has a copy of that conversation'
      : session.data.isArchived
        ? 'this account already has that conversation, archived'
        : 'this account already has that conversation';
    here.set(id, how);
  }

  return here;
}

/**
 * What to do about a session the ledger already has an active copy for.
 *
 * Returns the outcome fields when the session should be skipped, or nothing when
 * the ledger has been reconciled and the copy should be made again.
 *
 * The distinction that matters is *why* the copy is not there. A copy deleted in
 * the app was thrown away on purpose, and a bulk run that quietly recreated it
 * would undo a decision the user made deliberately — so that one is only redone
 * when the session was named explicitly. A copy that simply is not there any more
 * was never refused: recreating it is the whole point of the command.
 */
function resolveExisting(
  active: ActiveFostering,
  context: { explicit: boolean; dryRun: boolean; ledger: Ledger },
): Pick<Outcome, 'status' | 'detail' | 'copyPath'> | undefined {
  const state = inspectCopy(active);

  if (state.kind === 'present') {
    return { status: 'skipped', detail: 'already fostered', copyPath: active.copyPath };
  }

  if (state.kind === 'unreachable') {
    // Its installation is not mounted, so absence proves nothing. Deciding it had
    // gone would put a second copy there the moment the drive came back.
    return {
      status: 'skipped',
      detail: 'already fostered, into an installation that is not reachable to check',
      copyPath: active.copyPath,
    };
  }

  if (state.kind === 'deleted-in-app' && !context.explicit) {
    const when = state.deletedAt
      ? ` on ${new Date(state.deletedAt).toISOString().slice(0, 10)}`
      : '';
    return {
      status: 'skipped',
      detail: `deleted in the app${when} — name it with --session to foster it again`,
    };
  }

  // Recorded rather than assumed: the ledger keeps saying what happened, and a
  // 'returned' event foster did not perform is marked as the reconciliation it is.
  if (!context.dryRun) {
    context.ledger.append({
      kind: 'returned',
      originSessionId: active.originSessionId,
      target: active.target,
      copySessionId: active.copySessionId,
      reconciled: true,
    });
  }
  return undefined;
}

export interface ReturnOptions {
  store: StoreLayout;
  ledger: Ledger;
  dryRun?: boolean;
  /**
   * Refuses to delete copies a running app is holding in memory. Injectable so
   * tests can drive a synthetic store without a real app on the machine deciding
   * whether they pass; production callers always get the real gate.
   */
  guard?: RemovalGuard;
}

/**
 * Undo fosterings by deleting the copies.
 *
 * foster removes the file directly rather than asking the user to delete it in
 * the app: deleting in the UI leaves tombstones for both the session id and the
 * shared cliSessionId, which is avoidable noise in the account directory.
 */
export function returnFosterings(fosterings: ActiveFostering[], options: ReturnOptions): Outcome[] {
  const { store, ledger, dryRun = false, guard = assertRemovable } = options;
  const outcomes: Outcome[] = [];

  if (!dryRun && fosterings.length > 0) guard(store, fosterings);

  for (const fostering of fosterings) {
    const title = fostering.originalTitle ?? fostering.originSessionId;

    if (dryRun) {
      outcomes.push({
        originSessionId: fostering.originSessionId,
        title,
        status: 'returned',
        copyPath: fostering.copyPath,
      });
      continue;
    }

    // Absence is only success when the directory that should hold it says so.
    // Without this, a profile on an unmounted drive read as "already gone": the
    // ledger recorded a return that never happened, the file came back with the
    // drive, and the copy was left in the sidebar with nothing tracking it.
    if (inspectCopy(fostering).kind === 'unreachable') {
      outcomes.push({
        originSessionId: fostering.originSessionId,
        title,
        status: 'skipped',
        detail: 'its installation is not reachable — nothing was removed or recorded',
        copyPath: fostering.copyPath,
      });
      continue;
    }

    try {
      // Absence is success: the user may already have deleted the copy in the app.
      removeSafely(fostering.copyPath);
      ledger.append({
        kind: 'returned',
        originSessionId: fostering.originSessionId,
        target: fostering.target,
        copySessionId: fostering.copySessionId,
      });
      outcomes.push({
        originSessionId: fostering.originSessionId,
        title,
        status: 'returned',
        copyPath: fostering.copyPath,
      });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({
        kind: 'failed',
        operation: 'return',
        originSessionId: fostering.originSessionId,
        reason,
      });
      outcomes.push({
        originSessionId: fostering.originSessionId,
        title,
        status: 'failed',
        detail: reason,
      });
    }
  }

  return outcomes;
}

export function summariseOutcomes(outcomes: Outcome[]): Record<OutcomeStatus, number> {
  const counts: Record<OutcomeStatus, number> = {
    fostered: 0,
    skipped: 0,
    failed: 0,
    returned: 0,
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}
