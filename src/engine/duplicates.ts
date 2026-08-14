import type { StoreLayout } from '../domain/types.js';
import type { ActiveFostering } from '../ledger/types.js';
import { readCliSessionId } from '../store/sessionFile.js';
import { lineage, type Lineage } from './lineage.js';
import { sidebarOf } from './sidebar.js';

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
 * were unrelated.
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
  source?: NodeJS.ProcessEnv | Lineage,
): DuplicateReport {
  const report: DuplicateReport = { copies: [], branches: [], appMade: 0 };
  const kin = resolveLineage(source);
  const accounts = new Map<string, ActiveFostering[]>();
  // Which rows are foster's own is settled here rather than by the marker on the
  // file: the app drops unknown fields when it saves a session, so a copy that
  // has been opened looks native. Counting those as the app's would blame it for
  // pairs foster made, and offer no way to remove them.
  const known = new Set(fosterings.map((f) => f.copySessionId));

  for (const fostering of fosterings) {
    const key = `${fostering.target.accountUuid}/${fostering.target.organizationUuid}`;
    accounts.set(key, [...(accounts.get(key) ?? []), fostering]);
  }

  for (const group of accounts.values()) {
    const target = group[0]!.target;
    const bar = sidebarOf(store, target, known, kin);
    const surplus = bar.extras();

    for (const fostering of group) {
      // Asked of the ledger entry rather than of the scan, and kept from when
      // this was keyed on the conversation: an entry whose copy cannot even be
      // located is not one to offer for removal.
      if (conversationOf(fostering) === undefined) continue;

      const kind = surplus.get(fostering.copySessionId);
      if (kind === 'copy') report.copies.push(fostering);
      else if (kind === 'branch') report.branches.push(fostering);
    }

    report.appMade += bar.appMade();
  }

  return report;
}

function resolveLineage(source?: NodeJS.ProcessEnv | Lineage): Lineage {
  if (source && typeof (source as Lineage).rootOf === 'function') return source as Lineage;
  return lineage(source as NodeJS.ProcessEnv | undefined);
}

/** From the ledger where it was recorded, and from the copy where it was not. */
function conversationOf(fostering: ActiveFostering): string | undefined {
  if (fostering.cliSessionId) return fostering.cliSessionId;
  return readCliSessionId(fostering.copyPath);
}
