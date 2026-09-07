import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { DatedCard } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import { transcriptRoots, type ConversationScan } from '../store/transcripts.js';
import { scanStore } from '../store/scanner.js';
import { errorMessage } from '../util/fs.js';
import { writeFileAtomic } from '../util/fsatomic.js';
import { lineageAt } from './lineage.js';

/**
 * Rewrite a card's `lastActivityAt` to match its transcript, and nothing else.
 *
 * #47: the app only stamps this field when it is itself hosting the
 * conversation, so work done through the CLI — in a `cwd` the card was never
 * opened from, say — advances the transcript while the card's own date sits
 * frozen at the moment it was created. The row then sinks in Recents and reads
 * as work that never arrived, which is the sweep's whole reputation on the
 * line for a gap foster did not cause.
 *
 * `continued.ts` already reads both sides of this for the narrower case of a
 * ledger-known fostering, but only ever to print a warning. `retitle.ts`
 * already rewrites one field of a card in place, native cards included, app
 * open, with an atomic write and a ledger event. This is that machinery a
 * third time, for a third field — see the module doc comment there for why
 * none of this needs a process guard: the write is idempotent, so a card the
 * app saves back from memory before the next restart is simply a card the
 * next plan finds again.
 *
 * The one property `retitleCards` did not need and this does: `lastActivityAt`
 * drives sidebar ORDER, so a wrong value here does not just read oddly, it
 * moves a row the user is looking for. That is why the writer here (`dateCards`)
 * takes an explicit target value rather than computing one from a transcript
 * itself — the same split `retitleCards`/`branchCards.ts` keep for titles — and
 * why the *planning* half (`planDates`) is the one place the "never backwards"
 * rule has to hold: it only ever proposes advancing a card whose transcript is
 * ahead of it, and reports the rest as left alone rather than silently dropped.
 */

export interface DateRequest {
  /** The card to rewrite. */
  path: string;
  /** The account directory it sits in, for the record. */
  target: AccountRef;
  /** True when the app made this card rather than foster. */
  native: boolean;
  /** The `lastActivityAt` it should wear. */
  lastActivityAt: number;
}

export interface DateOutcome {
  path: string;
  /** The card's own id, read from the file. Empty when it could not be read. */
  sessionId: string;
  /** What it wore before, when the file could be read and already had one. */
  from?: number;
  to: number;
  status: 'dated' | 'skipped' | 'failed';
  detail?: string;
}

export interface DateOptions {
  ledger: Ledger;
  dryRun?: boolean;
}

/**
 * Write `lastActivityAt`, one request at a time — the atomic write, the
 * "skip when it already says so", the ledger event and the dry-run all
 * mirroring `retitleCards`.
 *
 * Deliberately takes the value to write rather than deriving it: a caller that
 * wants "never backwards" enforced (`planDates`, below) gets that from how it
 * builds the request, not from anything checked here — the same way
 * `retitleCards` has no opinion about which titles are allowed, only about
 * writing the one it is given. That is what lets `undoDateRequests` reuse this
 * unchanged to move a date backwards on purpose.
 */
export function dateCards(requests: DateRequest[], options: DateOptions): DateOutcome[] {
  const { ledger, dryRun = false } = options;
  const outcomes: DateOutcome[] = [];

  for (const request of requests) {
    const data = readSessionFile(request.path);
    if (!data) {
      outcomes.push({
        path: request.path,
        sessionId: '',
        to: request.lastActivityAt,
        status: 'failed',
        detail: 'the card could not be read',
      });
      continue;
    }

    const from = data.lastActivityAt;

    // Nothing to do is a skip rather than a write, exactly as in `retitleCards`:
    // rewriting with the same value would still append an event saying the
    // card changed, and the fold would then hold an advance that never
    // happened — and a second run of the same plan lands here every time,
    // which is what makes it a no-op rather than a repeated write.
    if (from === request.lastActivityAt) {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.lastActivityAt,
        status: 'skipped',
        detail: 'already says so',
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.lastActivityAt,
        status: 'dated',
      });
      continue;
    }

    try {
      const written = { ...data, lastActivityAt: request.lastActivityAt };

      // The write first, and only a completed write recorded — the order
      // every other writer here keeps, and for the same reason: a ledger
      // entry for a write that never landed would leave `--undo` restoring a
      // date the file never actually wore.
      writeFileAtomic(request.path, JSON.stringify(written));
      ledger.append({
        kind: 'card_dated',
        sessionId: data.sessionId,
        target: request.target,
        path: request.path,
        ...(from === undefined ? {} : { from }),
        to: request.lastActivityAt,
        native: request.native,
      });
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.lastActivityAt,
        status: 'dated',
      });
    } catch (error) {
      const reason = errorMessage(error);
      ledger.append({ kind: 'failed', operation: 'date', reason });
      outcomes.push({
        path: request.path,
        sessionId: data.sessionId,
        from,
        to: request.lastActivityAt,
        status: 'failed',
        detail: reason,
      });
    }
  }

  return outcomes;
}

/**
 * Put a card's `lastActivityAt` back to what the app had.
 *
 * Built from the ledger alone, the same way `undoRetitleRequests` is: `from`
 * is the value a `card_dated` fold carries forward across repeated advances,
 * so this needs no scan and works for an account nobody is signed into. A
 * card that had no `lastActivityAt` before the first advance has nothing
 * truthful to put back and is left out rather than guessed at.
 */
export function undoDateRequests(cards: DatedCard[]): DateRequest[] {
  const requests: DateRequest[] = [];
  for (const card of cards) {
    if (card.from === undefined) continue;
    requests.push({
      path: card.path,
      target: card.target,
      native: card.native,
      lastActivityAt: card.from,
    });
  }
  return requests;
}

/** One card being considered for an advance, before its transcript is read. */
export interface DateCandidate {
  path: string;
  sessionId: string;
  title: string;
  target: AccountRef;
  native: boolean;
  /** The card's own `lastActivityAt`, when it has one. */
  lastActivityAt?: number;
  /** The conversation whose transcript decides whether this card moves. */
  cliSessionId: string;
}

export interface DatePlanItem {
  path: string;
  sessionId: string;
  title: string;
  target: AccountRef;
  native: boolean;
  /** The card's own `lastActivityAt`, when it has one. */
  from?: number;
  /** The transcript's last answer, when the conversation has one on disk. */
  transcriptAt?: number;
  /**
   * `advance`: the transcript is ahead, and this is worth writing.
   * `already-ahead`: the card is at or ahead of its own transcript — left
   * alone on purpose, see the module doc comment.
   * `no-transcript`: nothing on disk answers "when was the last answer",
   * so there is nothing to compare the card against.
   */
  status: 'advance' | 'already-ahead' | 'no-transcript';
}

/**
 * Decide, for each candidate, whether its transcript is ahead of its card —
 * without writing anything.
 *
 * This is the one place the "never move a date backwards" rule lives: a
 * candidate becomes `advance` only when `transcriptAt` is strictly greater
 * than the card's own `lastActivityAt` (or the card has none at all yet).
 * Everything else — same date, or a card already ahead of what its own
 * transcript says — is reported as `already-ahead` rather than silently
 * dropped, which is what lets the command say so for every card it looked at
 * rather than only the ones it touched.
 */
export function planDates(
  candidates: DateCandidate[],
  scanOf: (cliSessionId: string) => ConversationScan | undefined,
): DatePlanItem[] {
  return candidates.map((candidate) => {
    const scan = scanOf(candidate.cliSessionId);
    const transcriptAt = scan?.lastAssistantAt;
    const from = candidate.lastActivityAt;

    const base = {
      path: candidate.path,
      sessionId: candidate.sessionId,
      title: candidate.title,
      target: candidate.target,
      native: candidate.native,
      ...(from === undefined ? {} : { from }),
    };

    if (transcriptAt === undefined) {
      return { ...base, status: 'no-transcript' as const };
    }

    if (from !== undefined && from >= transcriptAt) {
      return { ...base, transcriptAt, status: 'already-ahead' as const };
    }

    return { ...base, transcriptAt, status: 'advance' as const };
  });
}

/** The plan items worth writing, turned into what `dateCards` needs. */
export function requestsFromPlan(items: DatePlanItem[]): DateRequest[] {
  return items
    .filter((item): item is DatePlanItem & { transcriptAt: number } => item.status === 'advance')
    .map((item) => ({
      path: item.path,
      target: item.target,
      native: item.native,
      lastActivityAt: item.transcriptAt,
    }));
}

/**
 * Every card in the store worth checking, paired with the transcript reader
 * that answers `planDates`'s question — the wiring `foster dates` uses.
 *
 * A card with no `cliSessionId` opens nothing, so there is no transcript to
 * compare it against; it is left out here rather than reported as
 * `no-transcript` by `planDates`, which is for a card that names a
 * conversation nothing on disk can find.
 */
export function candidatesFromStore(
  store: StoreLayout,
  env: NodeJS.ProcessEnv = process.env,
): { candidates: DateCandidate[]; scanOf: (cliSessionId: string) => ConversationScan | undefined } {
  const kin = lineageAt(transcriptRoots(env));
  const candidates: DateCandidate[] = [];

  for (const found of scanStore(store)) {
    const cliSessionId = found.data.cliSessionId;
    if (!cliSessionId) continue;
    candidates.push({
      path: found.path,
      sessionId: found.data.sessionId,
      title: found.data.title ?? found.data.sessionId,
      target: found.account,
      native: !found.isCopy,
      lastActivityAt: found.data.lastActivityAt,
      cliSessionId,
    });
  }

  return { candidates, scanOf: (cliSessionId) => kin.scanOf(cliSessionId) };
}
