import { mkdirSync } from 'node:fs';
import { buildFosterCopy, DEFAULT_PREFIX, fosteringKey, stripPrefix } from '../domain/fostering.js';
import { accountDir, sessionPath } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { isFostered, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { errorMessage } from '../util/fs.js';
import { removeSafely, writeFileAtomic } from './fsatomic.js';
import { assertAppClosed } from './safety.js';

/**
 * Refuses to proceed while Claude Desktop is running. Injectable so tests can
 * drive a synthetic store without being blocked by a real app on the machine —
 * production callers always get the real gate by default.
 */
export type Guard = (store: StoreLayout) => void;

export interface FosterOptions {
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
  prefix?: string;
  /** When true, compute the plan without writing anything. */
  dryRun?: boolean;
  guard?: Guard;
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
  const { store, ledger, target, dryRun = false, guard = assertAppClosed } = options;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const state = project(ledger.read());
  const outcomes: Outcome[] = [];
  // The projection is a snapshot, so keys minted during this batch are tracked
  // here too: the same origin session can appear twice in one run when it exists
  // under two account directories, and without this both would be copied while
  // the ledger fold kept only the last one — orphaning the first file.
  const mintedInBatch = new Set<string>();

  if (dryRun || sessions.length === 0) {
    // Nothing is written, so neither the gate nor the directory is needed.
  } else {
    guard(store);
    mkdirSync(accountDir(store, target), { recursive: true });
  }

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
        originalTitle: stripPrefix(session.data.title ?? '', prefix),
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
  guard?: Guard;
}

/**
 * Undo fosterings by deleting the copies.
 *
 * foster removes the file directly rather than asking the user to delete it in
 * the app: deleting in the UI leaves tombstones for both the session id and the
 * shared cliSessionId, which is avoidable noise in the account directory.
 */
export function returnFosterings(fosterings: ActiveFostering[], options: ReturnOptions): Outcome[] {
  const { store, ledger, dryRun = false, guard = assertAppClosed } = options;
  const outcomes: Outcome[] = [];

  if (!dryRun && fosterings.length > 0) guard(store);

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
