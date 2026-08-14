import type { AccountRef, StoreLayout } from '../domain/types.js';
import { scanAccount, type KnownCopies } from '../store/scanner.js';
import { weighBranches } from './branches.js';
import type { Lineage } from './lineage.js';

/**
 * What one account's sidebar already shows.
 *
 * Fostering asks "is this work here?". Cleanup asks "which extra foster rows,
 * never all of them?". Both questions are about the same cards. One index,
 * two reads — not two walks that can drift.
 */

export interface SidebarCard {
  sessionId: string;
  isCopy: boolean;
  cliSessionId: string;
  archived: boolean;
}

export interface Sidebar {
  /** Why this conversation (or a branch of it) is already showing, if it is. */
  reason(cliSessionId: string | undefined): string | undefined;
  /** A card this run has committed to bringing, so the next one sees it. */
  markPlanned(cliSessionId: string): void;
  /**
   * Extra foster rows, never the survivor. Keyed by the copy's session id.
   * Exact when something else in the group holds the same conversation; a
   * branch when the group is held together by the root alone.
   */
  extras(): Map<string, 'copy' | 'branch'>;
  /** Conversations with more than one card, none of them foster's. */
  appMade(): number;
  /**
   * How a conversation being offered compares with the branch of it this account
   * already shows. Undefined when the account shows no other branch of that work,
   * which is every ordinary case.
   */
  standing(cliSessionId: string | undefined): BranchStanding | undefined;
}

/**
 * The two halves of a fork, counted against each other.
 *
 * Refusing the second row is right, and saying nothing else about it was not: the
 * account keeps whichever half reached it first, and nothing in the sweep ever
 * mentions that the half it turned away is the one the work continued in. One
 * store had an account showing 1468 records while 2981 waited outside it.
 */
export interface BranchStanding {
  /** The branch this account shows — the heaviest of them, if it shows several. */
  here: string;
  /** Records the offered branch holds that no branch here does. */
  theirOnly: number;
  /** Records the branch here holds that the offered one does not. */
  hereOnly: number;
  /** True when the offered branch is the one that carried on. */
  ahead: boolean;
}

const BRANCH_HERE = 'this account already has a branch of that conversation';

export function sidebarOf(
  store: StoreLayout,
  account: AccountRef,
  copies: KnownCopies,
  kin: Lineage,
): Sidebar {
  const cards: SidebarCard[] = [];

  for (const session of scanAccount(store, account, copies)) {
    const id = session.data.cliSessionId;
    if (!id) continue;
    cards.push({
      sessionId: session.data.sessionId,
      isCopy: session.isCopy,
      cliSessionId: id,
      archived: Boolean(session.data.isArchived),
    });
  }

  const add = (card: SidebarCard): void => {
    cards.push(card);
  };

  const workOf = (cliSessionId: string): string => kin.rootOf(cliSessionId) ?? cliSessionId;

  const how = (card: SidebarCard): string => {
    if (card.isCopy) return 'this account already has a copy of that conversation';
    if (card.archived) return 'this account already has that conversation, archived';
    return 'this account already has that conversation';
  };

  return {
    reason(cliSessionId) {
      if (cliSessionId === undefined) return undefined;
      const exact = cards.filter((card) => card.cliSessionId === cliSessionId);
      if (exact.length > 0) return how(exact[exact.length - 1]!);
      const work = kin.rootOf(cliSessionId);
      if (work === undefined) return undefined;
      const group = cards.filter((card) => workOf(card.cliSessionId) === work);
      if (group.length === 0) return undefined;
      return group[0]!.archived ? `${BRANCH_HERE}, archived` : BRANCH_HERE;
    },

    markPlanned(cliSessionId) {
      add({
        sessionId: `planned:${cliSessionId}`,
        isCopy: true,
        cliSessionId,
        archived: false,
      });
    },

    standing(cliSessionId) {
      if (cliSessionId === undefined) return undefined;
      const work = kin.rootOf(cliSessionId);
      if (work === undefined) return undefined;

      const theirs = new Set(
        cards
          .filter((card) => workOf(card.cliSessionId) === work)
          .map((card) => card.cliSessionId)
          .filter((id) => id !== cliSessionId),
      );
      if (theirs.size === 0) return undefined;

      // Sorted heaviest first, so the first entry that is not the offered branch
      // is the strongest thing this account shows for that work.
      const weights = weighBranches([cliSessionId, ...theirs], kin);
      const offered = weights.find((weight) => weight.cliSessionId === cliSessionId);
      const best = weights.find((weight) => weight.cliSessionId !== cliSessionId);
      if (offered === undefined || best === undefined) return undefined;

      return {
        here: best.cliSessionId,
        theirOnly: offered.only,
        hereOnly: best.only,
        ahead: weights[0] === offered,
      };
    },

    extras() {
      const groups = new Map<string, SidebarCard[]>();
      for (const card of cards) {
        const key = workOf(card.cliSessionId);
        groups.set(key, [...(groups.get(key) ?? []), card]);
      }

      const surplus = new Map<string, 'copy' | 'branch'>();
      for (const rows of groups.values()) {
        if (rows.length < 2) continue;
        const keep = survivor(rows, kin);
        for (const row of rows) {
          if (row === keep || !row.isCopy) continue;
          const exact = rows.some(
            (other) => other !== row && other.cliSessionId === row.cliSessionId,
          );
          surplus.set(row.sessionId, exact ? 'copy' : 'branch');
        }
      }
      return surplus;
    },

    appMade() {
      const byConversation = new Map<string, SidebarCard[]>();
      for (const card of cards) {
        byConversation.set(card.cliSessionId, [
          ...(byConversation.get(card.cliSessionId) ?? []),
          card,
        ]);
      }
      let count = 0;
      for (const rows of byConversation.values()) {
        if (rows.length > 1 && rows.every((row) => !row.isCopy)) count++;
      }
      return count;
    },
  };
}

/**
 * The one row of a group to keep.
 *
 * A card the app made wins outright, for the reason it always has: foster
 * removes what foster wrote.
 *
 * Among copies, the choice used to be the newest file `mtime`, which was wrong
 * in a way that hid itself. The app rewrites bookkeeping into a transcript every
 * time its card is opened, so the stale half of a fork gets a fresh timestamp
 * from being *looked at* — and the cleanup would then keep the row somebody had
 * clicked and drop the one that had been running all morning. Ranking by the
 * records a branch holds alone cannot be moved by reading it.
 */
function survivor(rows: SidebarCard[], kin: Lineage): SidebarCard {
  const native = rows.find((row) => !row.isCopy);
  if (native) return native;

  // One conversation, several cards: every row opens the same transcript, so any
  // of them will do and none is more advanced than another. Asked first because
  // this is the common shape by far, and weighing reads whole transcripts.
  const conversations = new Set(rows.map((row) => row.cliSessionId));
  if (conversations.size < 2) return rows[0]!;

  const rank = new Map(
    weighBranches([...conversations], kin).map((weight, index) => [weight.cliSessionId, index]),
  );
  const placeOf = (row: SidebarCard): number =>
    rank.get(row.cliSessionId) ?? Number.MAX_SAFE_INTEGER;
  return rows.reduce((best, row) => (placeOf(row) < placeOf(best) ? row : best));
}

export { BRANCH_HERE };
