import type { AccountRef, StoreLayout } from '../domain/types.js';
import { scanAccount, type KnownCopies } from '../store/scanner.js';
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

function survivor(rows: SidebarCard[], kin: Lineage): SidebarCard {
  const native = rows.find((row) => !row.isCopy);
  if (native) return native;
  return rows.reduce((best, row) =>
    (kin.lastWriteOf(row.cliSessionId) ?? 0) > (kin.lastWriteOf(best.cliSessionId) ?? 0)
      ? row
      : best,
  );
}

export { BRANCH_HERE };
