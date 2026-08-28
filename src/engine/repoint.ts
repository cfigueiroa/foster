import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import type { RepointedCard } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import { errorMessage } from '../util/fs.js';
import { writeFileAtomic } from '../util/fsatomic.js';
import { assertCardsWritable, type WriteGuard } from './safety.js';
import { comparablePath } from '../domain/paths.js';

/**
 * Move a card onto another conversation, and nothing else.
 *
 * This is the only write foster makes to a file it did not create, so what it
 * does not touch is as much the point as what it does. One field decides which
 * conversation a row opens; everything else on the card — its identity, its
 * title, its dates, whatever keys the app has added since — is carried through
 * verbatim, the same discipline `buildFosterCopy` follows for a copy.
 *
 * It is also the app's own move. A conversation that cannot be continued from a
 * second card is forked by the app, which writes a new transcript and repoints
 * the card at it (`continued.ts`). Foster is not inventing an operation here; it
 * is performing the one the app performs, in the direction the app never offers.
 */

export interface RepointRequest {
  /** The card to rewrite. */
  path: string;
  /** The account directory it sits in, for the record. */
  target: AccountRef;
  /** The conversation it should point at. */
  to: string;
  /** True when the app made this card rather than foster. */
  native: boolean;
  /**
   * When the conversation it is moving onto was last written to.
   *
   * Recents is ordered by the card's own `lastActivityAt`, so a card moved onto a
   * conversation that ran for another two days would otherwise sort by the date
   * it stopped — pointing at current work while filed under an old date, which is
   * the confusion this command exists to end. Assigned rather than raised: the
   * date on a row should describe the conversation the row opens, in whichever
   * direction that moves it, and an undo has to be able to put the old one back.
   */
  activityAt?: number;
}

export interface RepointOutcome {
  path: string;
  /** The card's own id, read from the file. Empty when it could not be read. */
  sessionId: string;
  title: string;
  status: 'repointed' | 'skipped' | 'failed';
  detail?: string;
  /** Where it pointed before, when the file could be read. */
  from?: string;
  to: string;
}

export interface RepointOptions {
  store: StoreLayout;
  ledger: Ledger;
  dryRun?: boolean;
  guard?: WriteGuard;
}

export function repointCards(
  requests: RepointRequest[],
  options: RepointOptions,
): RepointOutcome[] {
  const { store, ledger, dryRun = false, guard = assertCardsWritable } = options;
  const outcomes: RepointOutcome[] = [];

  // Cards the running app is holding, which this run has to leave alone. Empty on
  // a dry run, which writes nothing and so has nothing to be held back from.
  const holding = new Set<string>();

  if (!dryRun && requests.length > 0) {
    // What the ledger knows about each card, so the question can be asked of
    // *this* card rather than of the installation. A copy foster wrote after the
    // app started was never read by it.
    const fosteredAt = new Map<string, number>();
    for (const fostering of listActive(project(ledger.read()))) {
      fosteredAt.set(comparablePath(fostering.copyPath), fostering.fosteredAt);
    }
    const cards = requests.map((request) => {
      const at = fosteredAt.get(comparablePath(request.path));
      return {
        path: request.path,
        native: request.native,
        ...(at === undefined ? {} : { fosteredAt: at }),
      };
    });

    // One question, through the injectable seam. The guard refuses outright when
    // none of the batch can be written; what comes back otherwise is the split.
    const { held } = guard(store, cards);
    for (const card of held) holding.add(comparablePath(card.path));
  }

  for (const request of requests) {
    if (holding.has(comparablePath(request.path))) {
      const data = readSessionFile(request.path);
      outcomes.push({
        path: request.path,
        sessionId: data?.sessionId ?? '',
        title: data?.title ?? request.path,
        status: 'skipped',
        detail: 'Claude Desktop has this card loaded — close it and run this again',
        ...(data?.cliSessionId ? { from: data.cliSessionId } : {}),
        to: request.to,
      });
      continue;
    }

    const data = readSessionFile(request.path);
    if (!data) {
      outcomes.push({
        path: request.path,
        sessionId: '',
        title: request.path,
        status: 'failed',
        detail: 'the card could not be read',
        to: request.to,
      });
      continue;
    }

    const title = data.title ?? data.sessionId;
    const from = data.cliSessionId;

    // Nothing to do is a skip rather than a write. Rewriting a card with the same
    // bytes would still append a ledger event saying it moved, and `--undo` would
    // then have a move to reverse that never happened.
    if (from === request.to) {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        title,
        status: 'skipped',
        detail: 'already points there',
        from,
        to: request.to,
      });
      continue;
    }

    // A card with no pointer at all is not a row that opens anything, and the
    // ledger could not record where to put it back. Left alone rather than
    // adopted: this command moves cards, it does not repair them.
    if (from === undefined || from === '') {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        title,
        status: 'skipped',
        detail: 'points at no conversation',
        to: request.to,
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        title,
        status: 'repointed',
        from,
        to: request.to,
      });
      continue;
    }

    try {
      const moved = { ...data, cliSessionId: request.to };
      if (request.activityAt !== undefined) moved.lastActivityAt = request.activityAt;

      // The write happens first, and only a completed write is recorded — the
      // same order `fosterSessions` keeps, and for the same reason: a ledger
      // entry for a write that failed would have `--undo` restoring a pointer
      // that was never replaced.
      writeFileAtomic(request.path, JSON.stringify(moved));
      ledger.append({
        kind: 'card_repointed',
        sessionId: data.sessionId,
        target: request.target,
        path: request.path,
        from,
        to: request.to,
        native: request.native,
        // The date the row wore before, so putting it back restores its place in
        // Recents and not merely its pointer.
        ...(data.lastActivityAt === undefined ? {} : { fromActivityAt: data.lastActivityAt }),
      });
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        title,
        status: 'repointed',
        from,
        to: request.to,
      });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'repoint', reason });
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        title,
        status: 'failed',
        detail: reason,
        from,
        to: request.to,
      });
    }
  }

  return outcomes;
}

/**
 * Put cards back where the app had them.
 *
 * Built from the ledger alone — the pointer, the date and the path were all
 * recorded when the card moved — so an undo needs no scan, and works for an
 * account nobody is signed into.
 */
export function undoRequests(cards: RepointedCard[]): RepointRequest[] {
  return cards.map((card) => ({
    path: card.path,
    target: card.target,
    to: card.from,
    native: card.native,
    ...(card.fromActivityAt === undefined ? {} : { activityAt: card.fromActivityAt }),
  }));
}
