import { readFileSync } from 'node:fs';
import type { AccountRef, CodeSessionData, StoreLayout } from '../domain/types.js';
import type { ActiveFostering } from '../ledger/types.js';
import { scanAccount } from '../store/scanner.js';

/**
 * Two rows in one sidebar for one conversation.
 *
 * A conversation belongs to no account: it is a transcript on disk that any
 * account can hold a card for. So an account can have its own card for a
 * conversation *and* receive a fostered copy of another account's card for the
 * same one — same work, two rows, different dates, no hint in the sidebar that
 * they are the same thing.
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
  /** Conversations with more than one card, none of them foster's. */
  appMade: number;
}

export function findDuplicates(store: StoreLayout, fosterings: ActiveFostering[]): DuplicateReport {
  const report: DuplicateReport = { copies: [], appMade: 0 };
  const accounts = new Map<string, ActiveFostering[]>();

  for (const fostering of fosterings) {
    const key = `${fostering.target.accountUuid}/${fostering.target.organizationUuid}`;
    accounts.set(key, [...(accounts.get(key) ?? []), fostering]);
  }

  for (const group of accounts.values()) {
    const target = group[0]!.target;
    const cards = cardsByConversation(store, target);

    for (const fostering of group) {
      const id = conversationOf(fostering);
      if (!id) continue;
      const rows = cards.get(id) ?? [];
      // Its own card does not count as a duplicate of itself.
      if (rows.some((row) => row.sessionId !== fostering.copySessionId)) {
        report.copies.push(fostering);
      }
    }
  }

  // Counted across the account directories in play, once each.
  for (const key of accounts.keys()) {
    const [accountUuid, organizationUuid] = key.split('/');
    const cards = cardsByConversation(store, {
      accountUuid: accountUuid!,
      organizationUuid: organizationUuid!,
    });
    for (const rows of cards.values()) {
      if (rows.length > 1 && rows.every((row) => !row.isCopy)) report.appMade++;
    }
  }

  return report;
}

interface Card {
  sessionId: string;
  isCopy: boolean;
}

function cardsByConversation(store: StoreLayout, account: AccountRef): Map<string, Card[]> {
  const cards = new Map<string, Card[]>();

  for (const session of scanAccount(store, account)) {
    const id = session.data.cliSessionId;
    if (!id) continue;
    const card: Card = { sessionId: session.data.sessionId, isCopy: session.isCopy };
    cards.set(id, [...(cards.get(id) ?? []), card]);
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
