import { readFileSync, statSync } from 'node:fs';
import { layoutFor, samePath, sessionPath } from '../domain/paths.js';
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

    const card = readCard(originCard(store, fostering));
    // No card, nothing to be confused by: the original was itself deleted, and
    // there is no stale row left to explain.
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

/**
 * Where the original's card lives, which is not always the store being worked in.
 *
 * A copy fostered from another installation has its original over there, and
 * looking for it here found nothing and said nothing — silence in exactly the
 * two-profile arrangement that confuses most. The ledger records the origin store
 * now; for entries written before it did, the copy carries the same fact.
 */
function originCard(store: StoreLayout, fostering: ActiveFostering): string {
  const from = fostering.originStore ?? readCard(fostering.copyPath)?._foster?.originStore;
  const owner = from ? layoutFor(from) : store;
  return sessionPath(owner, fostering.origin, fostering.originSessionId);
}

function readCard(file: string): CodeSessionData | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
  } catch {
    return undefined;
  }
}

/**
 * What to say about conversations that carried on, wherever it is being said.
 *
 * Shared rather than written twice: the menu is where most people undo a
 * fostering, and the reassurance existing only in the command would leave the
 * fright exactly where it happens.
 */
export function continuedNote(count: number): string {
  const one = count === 1;
  return [
    `${count} of these carried on after being fostered. Nothing is lost: ${one ? 'it is' : 'they are'} the`,
    `same conversation, and opening ${one ? 'it' : 'them'} in the original account brings everything back.`,
    'Only the date and title on the row are the old ones, until you open it.',
  ].join('\n');
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
 * honours would only look like protection. So this is a warning.
 *
 * It used to be said only for two installations, on the reasoning that one
 * installation reads a single account and so cannot have the conversation open
 * twice. That reasoning was wrong, and `LIVE_BRANCHES` below is the case it
 * missed: a conversation does not need a second *sidebar* to be open twice, only
 * a second *writer*, and a running Code session is one.
 */
export const TWO_SIDEBARS = [
  'Both installations are running, and a copy is the same conversation as its original.',
  'Open it in one of them at a time: two apps writing one conversation at once leave it',
  'branched rather than continued.',
].join('\n');

/**
 * The same hazard, in the form that needs no second installation at all.
 *
 * A conversation being written right now by a live `claude` process cannot be
 * continued by anything else: the app, asked to open a card for it, branches
 * instead — it copies the history into a new transcript with a new id and
 * repoints that card at the branch. From then on the card and the original
 * describe different conversations, and the one that keeps growing is the one
 * with the writer.
 *
 * This is what makes the ordinary account switch dangerous. Foster a session you
 * are working in, sign into the other account, open the copy: the copy branches,
 * your work continues in the account you left, and the new account holds a
 * snapshot that stops at the moment you opened it. Nothing is lost — both
 * transcripts are on disk — but only one of them is still being written.
 *
 * Observed on a real store: a copy made at 06:30 for a conversation live since
 * 04:21 was opened at 09:55 and became a branch that ended at 10:16, while the
 * original ran on past 10:32.
 */
export function liveBranchNote(writers: LiveWriter[]): string {
  const one = writers.length === 1;
  const lines = [
    `${writers.length} of ${one ? 'these is' : 'these are'} being written right now by a running claude process.`,
    `Finish there before opening the ${one ? 'copy' : 'copies'}: a conversation with a live writer`,
    'cannot be continued from a second card, so the app branches it instead — the copy',
    'follows the branch and your work carries on in the original.',
  ];

  // Named rather than merely counted. "Finish there" is not advice anyone can act
  // on without knowing where *there* is, and the registry has the answer: which
  // process, and the directory it was started in, which is what makes a window
  // recognisable among a dozen.
  for (const writer of writers) {
    const self = writer.isSelf ? ' — this one, running foster' : '';
    lines.push(`  pid ${writer.pid}  ${writer.cwd ?? '(unknown directory)'}${self}`);
  }
  lines.push('`foster live --stop <id>` ends one, when finishing is not what you want.');
  return lines.join('\n');
}

/** A process holding a conversation open, as the warning needs to describe it. */
export interface LiveWriter {
  pid: number;
  cwd?: string;
  /** True for the session foster itself is running inside. */
  isSelf?: boolean;
}

export function twoLiveSidebars(source: StoreLayout, target: StoreLayout): boolean {
  if (samePath(source.root, target.root)) return false;
  return lockfileHeld(source) && lockfileHeld(target);
}
