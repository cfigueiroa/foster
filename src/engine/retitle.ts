import type { AccountRef } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { readSessionFile } from '../store/sessionFile.js';
import { errorMessage } from '../util/fs.js';
import { writeFileAtomic } from '../util/fsatomic.js';

/**
 * Rewrite what a card is called, and whether it is filed away — nothing else.
 *
 * The sweep gives every branch of a fork a row, and this is how the rows that
 * did not carry on come to say so: the title gains a mark, the card moves to the
 * archived view. Which conversation the row opens is never touched here; that is
 * `repoint.ts`, and a different kind of write.
 *
 * Different enough that this one takes no process guard. `safety.ts` asks whether
 * the running app will write the card back from memory, and refuses every native
 * card while the app is up — right for a pointer, where a lost write is silent
 * and `--undo` would then reverse a move the app had already reversed. A lost
 * title costs a mark the next sweep puts back: the plan is computed from what is
 * on disk, so it is idempotent by construction, and a sweep ends with the restart
 * that makes the app read the disk again, after which the app's memory holds
 * what was written here. Refusing would leave exactly the card this exists for —
 * the stale native row in the signed-in account — saying the wrong thing.
 *
 * What stands in for the guard: the write is atomic, so the app can never read
 * a torn file; every other key is carried through verbatim, the discipline
 * `repointCards` keeps; nothing is written when nothing would change; and the
 * write is recorded before and after, so the log can put it back.
 */

export interface RetitleRequest {
  /** The card to rewrite. */
  path: string;
  /** The account directory it sits in, for the record. */
  target: AccountRef;
  /** True when the app made this card rather than foster. */
  native: boolean;
  /** The title it should wear. */
  title: string;
  /** The archived flag it should carry; left out to leave the flag alone. */
  archived?: boolean;
  /** Why: marked as the branch that stopped, or restored as the one that carried on. */
  as: 'stale' | 'tip';
}

export interface RetitleOutcome {
  path: string;
  /** The card's own id, read from the file. Empty when it could not be read. */
  sessionId: string;
  /** What it was called before, when the file could be read. */
  from: string;
  to: string;
  /** The archived flag before and after, when the write changed it. */
  archived?: { from: boolean; to: boolean };
  status: 'retitled' | 'skipped' | 'failed';
  detail?: string;
  as: 'stale' | 'tip';
}

export interface RetitleOptions {
  ledger: Ledger;
  dryRun?: boolean;
}

export function retitleCards(
  requests: RetitleRequest[],
  options: RetitleOptions,
): RetitleOutcome[] {
  const { ledger, dryRun = false } = options;
  const outcomes: RetitleOutcome[] = [];

  for (const request of requests) {
    const data = readSessionFile(request.path);
    if (!data) {
      outcomes.push({
        path: request.path,
        sessionId: '',
        from: '',
        to: request.title,
        status: 'failed',
        detail: 'the card could not be read',
        as: request.as,
      });
      continue;
    }

    const from = data.title ?? '';
    const wasArchived = Boolean(data.isArchived);
    const flagChanges = request.archived !== undefined && request.archived !== wasArchived;
    const archived = flagChanges ? { from: wasArchived, to: request.archived! } : undefined;

    // Nothing to do is a skip rather than a write. A rewrite with the same
    // bytes would still append an event saying the card changed, and the fold
    // would then hold a change that never happened.
    if (from === request.title && !flagChanges) {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.title,
        status: 'skipped',
        detail: 'already says so',
        as: request.as,
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.title,
        ...(archived ? { archived } : {}),
        status: 'retitled',
        as: request.as,
      });
      continue;
    }

    try {
      // `titleSource` is left as it is: the app's own values say who chose the
      // title, and a mark in front of it does not change who that was.
      const written = { ...data, title: request.title };
      if (flagChanges) written.isArchived = request.archived;

      // The write first, and only a completed write recorded — the order every
      // other writer here keeps, and for the same reason.
      writeFileAtomic(request.path, JSON.stringify(written));
      ledger.append({
        kind: 'card_retitled',
        sessionId: data.sessionId,
        target: request.target,
        path: request.path,
        from,
        to: request.title,
        ...(archived ? { fromArchived: archived.from, toArchived: archived.to } : {}),
        native: request.native,
        as: request.as,
      });
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.title,
        ...(archived ? { archived } : {}),
        status: 'retitled',
        as: request.as,
      });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'retitle', reason });
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.title,
        status: 'failed',
        detail: reason,
        as: request.as,
      });
    }
  }

  return outcomes;
}
