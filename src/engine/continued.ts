import { readFileSync, statSync } from 'node:fs';
import { samePath, sessionPath } from '../domain/paths.js';
import type { CodeSessionData, StoreLayout } from '../domain/types.js';
import type { ActiveFostering } from '../ledger/types.js';
import { indexTranscripts, transcriptRoots } from '../store/transcripts.js';
import { lockfileHeld } from './lockfile.js';

/**
 * Conversations that carried on after they were fostered.
 *
 * A copy and the session it came from point at the same conversation, so work
 * done in the copy is not in the copy: it is in the transcript, which both
 * accounts reach. What does *not* travel is the card in the original account.
 * The app only writes the sessions of the account it is holding, so the
 * original's title, date and turn count stay frozen at the moment of the foster.
 *
 * Returning the copy therefore looks alarming and is not: the row reappears in
 * the original account wearing an old date, as if the work had been rolled back.
 * Saying so out loud is the whole point of this module.
 *
 * The comparison is deliberately a file time against a recorded time, not a count
 * of turns. Counting would mean reading transcripts that reach hundreds of
 * megabytes and reimplementing the app's idea of a turn; `mtime` answers the same
 * question for a `stat`.
 */
export interface ContinuedFostering {
  fostering: ActiveFostering;
  /** Last write to the conversation. */
  transcriptAt: number;
  /** What the original account's card still says. */
  cardAt: number;
}

/**
 * A minute of slack. The card is stamped when the app saves the session and the
 * transcript when the CLI writes a line, so the two are never exactly equal even
 * for a conversation nobody has touched since.
 */
const SLACK_MS = 60_000;

export function continuedSince(
  store: StoreLayout,
  fosterings: ActiveFostering[],
  env: NodeJS.ProcessEnv = process.env,
): ContinuedFostering[] {
  if (fosterings.length === 0) return [];

  const transcripts = indexTranscripts(transcriptRoots(env));
  const out: ContinuedFostering[] = [];

  for (const fostering of fosterings) {
    const cliSessionId = fostering.cliSessionId ?? cliSessionIdOfCopy(fostering.copyPath);
    if (!cliSessionId) continue;

    const file = transcripts.get(cliSessionId);
    if (!file) continue;

    const card = readCard(sessionPath(store, fostering.origin, fostering.originSessionId));
    // No card, nothing to be confused by: the original is not in this store, or
    // was itself deleted, and either way there is no stale row to explain.
    if (card?.lastActivityAt === undefined) continue;

    let transcriptAt: number;
    try {
      transcriptAt = statSync(file).mtimeMs;
    } catch {
      continue;
    }

    if (transcriptAt > card.lastActivityAt + SLACK_MS) {
      out.push({ fostering, transcriptAt, cardAt: card.lastActivityAt });
    }
  }

  return out;
}

/** Older ledger entries predate `cliSessionId`, but the copy still carries it. */
function cliSessionIdOfCopy(copyPath: string): string | undefined {
  return readCard(copyPath)?.cliSessionId;
}

function readCard(file: string): CodeSessionData | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
  } catch {
    return undefined;
  }
}

/**
 * The one hazard a copy inherits from sharing its conversation.
 *
 * A copy and the session it came from point at the same transcript, which is why
 * work done in one is there in the other. With both installations running, that
 * conversation has a row in two live sidebars, and opening it in both at once
 * puts two processes on one file: nothing is lost, but the record grows a second
 * branch instead of continuing, and reads as scrambled afterwards.
 *
 * There is nothing to enforce here. The dangerous moment is opening the
 * conversation inside the app, which foster is not part of, and a lock nothing
 * honours would only look like protection. So this is a warning, and it is said
 * only when it applies: within one installation the sidebar reads a single
 * account, so the same conversation cannot be open twice.
 */
export const TWO_SIDEBARS = [
  'Both installations are running, and a copy is the same conversation as its original.',
  'Open it in one of them at a time: two apps writing one conversation at once leave it',
  'branched rather than continued.',
].join('\n');

export function twoLiveSidebars(source: StoreLayout, target: StoreLayout): boolean {
  if (samePath(source.root, target.root)) return false;
  return lockfileHeld(source) && lockfileHeld(target);
}
