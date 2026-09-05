import type { ConversationScan } from '../store/transcripts.js';
import type { Lineage } from './lineage.js';

/**
 * Which half of a forked conversation is the one that carried on.
 *
 * `lineage.ts` answers whether two transcripts are the same work. This answers
 * the question that follows, and the only one that lets a fork be tidied up: of
 * the halves, which is the one to show — and what showing it stops showing.
 *
 * The measure is **records a branch holds that no sibling holds**. Two other
 * measures suggest themselves and both are wrong here, measured on a real store:
 *
 *  - **File `mtime`.** The app rewrites its own bookkeeping — `custom-title`,
 *    `mode`, `last-prompt` — every time a card is opened, so a transcript nobody
 *    has added a word to gets a fresh timestamp. One fork had its stale half
 *    stamped a day *after* the half that was still running, purely because
 *    somebody clicked the stale row. A rule that ranks by mtime can be flipped by
 *    looking at the wrong answer, which is the worst property a tie-break can
 *    have.
 *  - **The common prefix.** A branch is a copy of the history, so walking both
 *    files in step until they differ looks exact. It is not: the app does not
 *    write the copy in the original's order. On one fork the ordered prefix ran
 *    169 records while the two files had 1255 in common — an answer wrong by a
 *    factor of seven, in the direction of overstating what a branch holds alone.
 *
 * Set difference has neither failure. Ids survive the copy, order does not
 * matter, and bookkeeping records carry no `uuid` at all, so they cannot vote.
 */

export interface BranchWeight {
  cliSessionId: string;
  /** Records the transcript holds. */
  total: number;
  /**
   * Records no sibling holds — everything this branch would take with it if the
   * sidebar stopped showing it. The ranking, and the number worth printing.
   */
  only: number;
  /** Records it has in common with a sibling: the history they were both given. */
  shared: number;
  /** The last record carrying a timestamp — the last thing said, not the last write. */
  lastMessageAt?: number;
  /**
   * The last answer written on this branch — where the work was left. Not a
   * ranking input; it is what a stale row is stamped with, and
   * `transcripts.ts` explains why the last record would stamp it wrong.
   */
  lastAssistantAt?: number;
}

export interface Fork {
  /** The first record both branches carry, which is what identifies the work. */
  root: string;
  /** Heaviest first: `branches[0]` is the tip. */
  branches: BranchWeight[];
  /**
   * Records held by every branch except the tip.
   *
   * The honest price of one row. Small means one side is the work and the other
   * is where it was interrupted; large on both sides means the fork is two pieces
   * of work that happen to share an ancestor, and collapsing it would hide one.
   */
  lost: number;
}

/**
 * Rank branches of one conversation, heaviest first.
 *
 * Branches whose transcript is not on disk are left out rather than ranked last:
 * a file that cannot be read says nothing about how far its branch got, and
 * ranking it at zero would quietly promote whichever sibling happens to be
 * readable.
 */
export function weighBranches(cliSessionIds: string[], kin: Lineage): BranchWeight[] {
  const scans = new Map<string, ConversationScan>();
  for (const cliSessionId of cliSessionIds) {
    if (scans.has(cliSessionId)) continue;
    const scan = kin.scanOf(cliSessionId);
    if (scan === undefined) continue;
    scans.set(cliSessionId, scan);
  }

  // How many branches carry each record. One holder means the record is that
  // branch's alone; more means it is history they share.
  const holders = new Map<string, number>();
  for (const scan of scans.values()) {
    for (const uuid of scan.uuids) holders.set(uuid, (holders.get(uuid) ?? 0) + 1);
  }

  const weights: BranchWeight[] = [];
  for (const [cliSessionId, scan] of scans) {
    let only = 0;
    for (const uuid of scan.uuids) if (holders.get(uuid) === 1) only += 1;
    weights.push({
      cliSessionId,
      total: scan.uuids.size,
      only,
      shared: scan.uuids.size - only,
      ...(scan.lastMessageAt === undefined ? {} : { lastMessageAt: scan.lastMessageAt }),
      ...(scan.lastAssistantAt === undefined ? {} : { lastAssistantAt: scan.lastAssistantAt }),
    });
  }

  return weights.sort(byAdvancement);
}

/**
 * Exclusive records first, then the last thing said, then sheer size.
 *
 * The tie-breaks matter for the case the first measure cannot separate: two
 * branches that parted and only one of which was written to again both hold the
 * same history, and the one that carried on is the one with a later last message.
 * The id is last so the order never depends on which branch was read first.
 */
function byAdvancement(a: BranchWeight, b: BranchWeight): number {
  if (a.only !== b.only) return b.only - a.only;
  const said = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
  if (said !== 0) return said;
  if (a.total !== b.total) return b.total - a.total;
  return a.cliSessionId.localeCompare(b.cliSessionId);
}

/**
 * Did this branch go on after the tip did?
 *
 * The question `byAdvancement` cannot answer, and the one a reader is actually
 * asking of a second row. The tip is the branch holding most work of its own,
 * which is not the same as the branch that spoke last: when both halves carry
 * records nobody else has, the fatter one wins the ranking while the other may
 * be where the work was left an hour ago.
 *
 * A branch counts as diverged only when it holds records of its own *and* its
 * last **answer** is later than the tip's. Both halves are load-bearing:
 *
 *  - a branch holding nothing the tip does not hold has nothing to go back
 *    for, however recently the app touched it;
 *  - the last *message* would be the wrong clock. Opening a stale row appends
 *    a user record to its transcript, so a branch nobody has worked in since
 *    can carry the newer message purely because somebody clicked it — the same
 *    trap `stoppedAtOf` avoids, and the reason `mtime` was rejected above. An
 *    answer is written only when the work actually went on.
 */
export function divergedFrom(branch: BranchWeight, tip: BranchWeight): boolean {
  if (branch.cliSessionId === tip.cliSessionId) return false;
  if (branch.only === 0) return false;
  const went = branch.lastAssistantAt ?? 0;
  return went > (tip.lastAssistantAt ?? tip.lastMessageAt ?? 0);
}

export interface Forks {
  /** The fork this conversation belongs to, or nothing when it is not in one. */
  of(cliSessionId: string | undefined): Fork | undefined;
  /** Every fork among the conversations this was built from. */
  all(): Fork[];
}

/**
 * Group conversations into forks and weigh each one, lazily.
 *
 * The membership is exactly the ids handed in — in practice, the conversations
 * the store holds a card for. A branch nobody has a card for anywhere is
 * therefore invisible here, which is the right bound for the callers: they act on
 * cards, and a branch with no card is not a row to keep or drop. Finding those
 * would mean reading the head of every transcript on the disk rather than of the
 * few hundred that are carded.
 *
 * Weighing is deferred and remembered. Grouping is cheap — it reuses the roots
 * `Lineage` already caches — while weighing reads whole transcripts, and most
 * conversations are in no fork at all.
 */
export function forksOf(cliSessionIds: Iterable<string>, kin: Lineage): Forks {
  const byRoot = new Map<string, Set<string>>();
  for (const cliSessionId of cliSessionIds) {
    const root = kin.rootOf(cliSessionId);
    if (root === undefined) continue;
    const members = byRoot.get(root);
    if (members) members.add(cliSessionId);
    else byRoot.set(root, new Set([cliSessionId]));
  }

  const weighed = new Map<string, Fork | undefined>();
  const forkAt = (root: string): Fork | undefined => {
    // `has` rather than a truthy check: a root that turned out not to be a fork
    // is remembered as such, so it is not weighed again for every card on it.
    if (weighed.has(root)) return weighed.get(root);
    const members = byRoot.get(root);
    const fork = members && members.size > 1 ? build(root, [...members], kin) : undefined;
    weighed.set(root, fork);
    return fork;
  };

  return {
    of(cliSessionId) {
      const root = kin.rootOf(cliSessionId);
      return root === undefined ? undefined : forkAt(root);
    },
    all() {
      const forks: Fork[] = [];
      for (const root of byRoot.keys()) {
        const fork = forkAt(root);
        if (fork) forks.push(fork);
      }
      return forks;
    },
  };
}

function build(root: string, members: string[], kin: Lineage): Fork | undefined {
  const branches = weighBranches(members, kin);
  // One readable transcript is not a fork to choose between. Two ids that both
  // resolved to the same root but only one of which is on disk leaves nothing to
  // rank, and calling it a fork would offer a choice with one option.
  if (branches.length < 2) return undefined;

  let lost = 0;
  for (const branch of branches.slice(1)) lost += branch.only;
  return { root, branches, lost };
}
