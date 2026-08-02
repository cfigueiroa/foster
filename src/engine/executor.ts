import { mkdirSync } from 'node:fs';
import { buildFosterCopy, DEFAULT_PREFIX, fosteringKey } from '../domain/fostering.js';
import { accountDir, sessionPath } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { isFostered, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { errorMessage } from '../util/fs.js';
import { removeSafely, writeFileAtomic } from './fsatomic.js';
import { assertRemovable, type RemovalGuard } from './safety.js';

export interface FosterOptions {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  prefix?: string;
  /** When true, compute the plan without writing anything. */
  dryRun?: boolean;
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
  const { store, ledger, target, dryRun = false } = options;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const state = project(ledger.read());
  const outcomes: Outcome[] = [];
  // The projection is a snapshot, so keys minted during this batch are tracked
  // here too: the same origin session can appear twice in one run when it exists
  // under two account directories, and without this both would be copied while
  // the ledger fold kept only the last one — orphaning the first file.
  const mintedInBatch = new Set<string>();

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
    if (isFostered(state, originId, target) || mintedInBatch.has(key)) {
      outcomes.push({
        originSessionId: originId,
        title,
        status: 'skipped',
        detail: 'already fostered',
      });
      continue;
    }

    const copy = buildFosterCopy(session.data, { origin: session.account, prefix });
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
        prefix,
      });
      mintedInBatch.add(key);
      outcomes.push({ originSessionId: originId, title, status: 'fostered', copyPath });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'foster', originSessionId: originId, reason });
      outcomes.push({ originSessionId: originId, title, status: 'failed', detail: reason });
    }
  }

  return outcomes;
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
