import { readFileSync } from 'node:fs';
import type { AccountRef, CodeSessionData, StoreLayout } from '../domain/types.js';
import type { ActiveFostering } from '../ledger/types.js';
import { scanAccount, type KnownCopies } from '../store/scanner.js';
import { lineage, type Lineage } from './lineage.js';

/**
 * Two rows in one sidebar for one conversation.
 *
 * A conversation belongs to no account: it is a transcript on disk that any
 * account can hold a card for. So an account can have its own card for a
 * conversation *and* receive a fostered copy of another account's card for the
 * same one — same work, two rows, different dates, no hint in the sidebar that
 * they are the same thing.
 *
 * The same row appears for a *branch* too, and by the same route: the app forks a
 * conversation that has a live writer, the fork gets an id nothing has seen, and
 * the two halves of one piece of work are fostered from two accounts as if they
 * were unrelated. `lineage.ts` is how they are recognised.
 *
 * Fostering now refuses to add the second row. This is for the ones already
 * there, and it draws a line that matters: foster removes only what foster wrote.
 * A conversation with two cards the app itself made is reported and left alone —
 * deleting somebody else's file on the strength of a heuristic is exactly the
 * kind of help nobody asked for.
 */
export interface DuplicateReport {
  /** Copies that duplicate a conversation their account already had. */
  copies: ActiveFostering[];
  /**
   * Copies whose account already had a *branch* of the conversation.
   *
   * Kept apart from `copies` because removing one is a different decision. Two
   * cards for one conversation open the same transcript, so either row will do
   * and dropping one loses nothing to see. Two branches do not: each holds
   * records the other never got, and picking one hides the other's — from the
   * sidebar, not from the disk, which is the only reason this can be offered at
   * all.
   */
  branches: ActiveFostering[];
  /** Conversations with more than one card, none of them foster's. */
  appMade: number;
}

export function findDuplicates(
  store: StoreLayout,
  fosterings: ActiveFostering[],
  env: NodeJS.ProcessEnv = process.env,
): DuplicateReport {
  const report: DuplicateReport = { copies: [], branches: [], appMade: 0 };
  const kin = lineage(env);
  const accounts = new Map<string, ActiveFostering[]>();
  // Which rows are foster's own is settled here rather than by the marker on the
  // file: the app drops unknown fields when it saves a session, so a copy that
  // has been opened looks native. Counting those as the app's would blame it for
  // pairs foster made, and offer no way to remove them.
  const known: KnownCopies = new Set(fosterings.map((f) => f.copySessionId));

  for (const fostering of fosterings) {
    const key = `${fostering.target.accountUuid}/${fostering.target.organizationUuid}`;
    accounts.set(key, [...(accounts.get(key) ?? []), fostering]);
  }

  for (const group of accounts.values()) {
    const target = group[0]!.target;
    const surplus = surplusIn(cardsIn(store, target, known), kin);

    for (const fostering of group) {
      // Asked of the ledger entry rather than of the scan, and kept from when
      // this was keyed on the conversation: an entry whose copy cannot even be
      // located is not one to offer for removal.
      if (conversationOf(fostering) === undefined) continue;

      const kind = surplus.get(fostering.copySessionId);
      if (kind === 'copy') report.copies.push(fostering);
      else if (kind === 'branch') report.branches.push(fostering);
    }
  }

  // Counted across the account directories in play, once each.
  for (const key of accounts.keys()) {
    const [accountUuid, organizationUuid] = key.split('/');
    const byConversation = new Map<string, Card[]>();
    for (const card of cardsIn(
      store,
      { accountUuid: accountUuid!, organizationUuid: organizationUuid! },
      known,
    )) {
      byConversation.set(card.cliSessionId, [
        ...(byConversation.get(card.cliSessionId) ?? []),
        card,
      ]);
    }
    for (const rows of byConversation.values()) {
      if (rows.length > 1 && rows.every((row) => !row.isCopy)) report.appMade++;
    }
  }

  return report;
}

interface Card {
  sessionId: string;
  isCopy: boolean;
  cliSessionId: string;
}

/**
 * Which rows are the extra ones, and never all of them.
 *
 * The question is asked per piece of work rather than per card, because the
 * answer has to leave something behind. Reporting "this row duplicates another"
 * of every row in a group is true of each and useless together: `return
 * --duplicates` would act on the lot and the work would vanish from the sidebar
 * entirely — which is exactly what the first version of the branch report did,
 * where both halves are usually copies fostered from two different accounts.
 *
 * So one row survives every group:
 *
 * - a card foster did not write, if there is one. It is not foster's to remove,
 *   and it is the row that was here first.
 * - otherwise the copy whose conversation was written last. Between two branches
 *   that is the one that kept going after the fork; between two copies of one
 *   conversation it is a coin toss that costs nothing, since both open the same
 *   transcript.
 *
 * Work is keyed by root, so a conversation and its branch are one group. A
 * transcript that cannot be read falls back to its own id, which puts it in a
 * group by itself — unanswerable is never treated as "the same".
 */
function surplusIn(cards: Card[], kin: Lineage): Map<string, 'copy' | 'branch'> {
  const groups = new Map<string, Card[]>();
  for (const card of cards) {
    const key = kin.rootOf(card.cliSessionId) ?? card.cliSessionId;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }

  const surplus = new Map<string, 'copy' | 'branch'>();
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;

    const keep = survivor(rows, kin);
    for (const row of rows) {
      if (row === keep || !row.isCopy) continue;
      // Exact when something else in the group holds the very same conversation;
      // a branch when the group is held together by the root alone.
      const exact = rows.some((other) => other !== row && other.cliSessionId === row.cliSessionId);
      surplus.set(row.sessionId, exact ? 'copy' : 'branch');
    }
  }

  return surplus;
}

function survivor(rows: Card[], kin: Lineage): Card {
  const native = rows.find((row) => !row.isCopy);
  if (native) return native;
  return rows.reduce((best, row) =>
    (kin.lastWriteOf(row.cliSessionId) ?? 0) > (kin.lastWriteOf(best.cliSessionId) ?? 0)
      ? row
      : best,
  );
}

function cardsIn(store: StoreLayout, account: AccountRef, copies: KnownCopies): Card[] {
  const cards: Card[] = [];

  for (const session of scanAccount(store, account, copies)) {
    const id = session.data.cliSessionId;
    if (!id) continue;
    cards.push({ sessionId: session.data.sessionId, isCopy: session.isCopy, cliSessionId: id });
  }

  return cards;
}

/** From the ledger where it was recorded, and from the copy where it was not. */
function conversationOf(fostering: ActiveFostering): string | undefined {
  if (fostering.cliSessionId) return fostering.cliSessionId;
  try {
    return (JSON.parse(readFileSync(fostering.copyPath, 'utf8')) as CodeSessionData).cliSessionId;
  } catch {
    return undefined;
  }
}
