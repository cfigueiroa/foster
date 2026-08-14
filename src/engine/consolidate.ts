import { ambiguousIds, requireUniquePrefix } from '../domain/prefix.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { scanStore } from '../store/scanner.js';
import { forksOf, type Fork } from './branches.js';
import { lineage, lineageAt, type Lineage } from './lineage.js';
import type { RepointRequest } from './repoint.js';

/**
 * One row per piece of work, on the half that carried on.
 *
 * A fork leaves each account holding a card for whichever half it happened to
 * watch, and every account fostered from the others ends up with both. The
 * sidebar then shows a piece of work two, three, four times, with nothing to
 * tell the rows apart but a date — and the row that looks most recent is often
 * the one that stopped.
 *
 * This plans the tidy-up: keep one card per account per piece of work, pointed
 * at the branch that holds the most that no sibling holds.
 *
 * What it will not do is pretend the halves can be added together. Choosing a
 * branch hides what the others hold alone, from the sidebar and only from the
 * sidebar — the transcripts stay on disk and `foster transcript` still reads
 * them. When both halves are substantial that trade is not worth making
 * silently, so the fork is reported with its numbers and left exactly as it is.
 * Merging transcripts would be the alternative, and rewriting the record of a
 * conversation is not something this tool does.
 */

export interface ConsolidationEntry {
  account: AccountRef;
  fork: Fork;
  /** The work's title, as the card being kept spells it. */
  title: string;
  /**
   * - `consolidate` — there is something to do.
   * - `diverged` — both halves are substantial; reported, not touched.
   * - `app-made` — the surplus rows are all the app's, so there is nothing here
   *   foster may move or remove. Reported, and kept out of the count of what a
   *   run would change: folding it into `consolidate` made the summary promise
   *   "3 rows would be consolidated (0 moved, 0 removed)", which is an action
   *   that does not exist.
   * - `settled` — one card, already on the tip. Counted, not printed.
   */
  status: 'consolidate' | 'diverged' | 'app-made' | 'settled';
  /**
   * Records this account would stop showing — held alone by the branches it has a
   * row on, minus the one being kept. Not `fork.lost`, which is the same sum over
   * every branch anywhere and overstates the trade for an account that never held
   * them all.
   */
  hides: number;
  /** The card being kept, when it has to move. */
  repoint?: RepointRequest & { title: string; from: string; sessionId: string };
  /** Surplus rows foster wrote, which it may remove. */
  remove: ActiveFostering[];
  /**
   * Surplus rows the app wrote, which it may not.
   *
   * Reported rather than removed, the same line `duplicates.ts` draws: deleting
   * somebody else's file on the strength of a heuristic is exactly the kind of
   * help nobody asked for. Rare in practice — it needs one account to have opened
   * both halves itself.
   */
  keptApart: { sessionId: string; cliSessionId: string; title: string }[];
}

export interface ConsolidateOptions {
  store: StoreLayout;
  ledger: Ledger;
  /**
   * How many records the losing halves may hold alone before the fork is left
   * alone instead. Measured across a real store, the forks worth collapsing sat
   * between 3 and 158 while the one genuine two-way fork held 2352, so the gap
   * this has to land in is wide.
   */
  maxLost?: number;
  /** Account uuid prefix; without it, every account in the store. */
  to?: string;
  /** Conversation or card id prefixes: only forks that involve one of them. */
  sessionIds?: string[];
  env?: NodeJS.ProcessEnv;
  /** Transcript `projects/` directories. Wins over `env` when both are given. */
  projectsDirs?: string[];
}

export const DEFAULT_MAX_LOST = 200;

export function planConsolidation(options: ConsolidateOptions): ConsolidationEntry[] {
  const { store, ledger } = options;
  const maxLost = options.maxLost ?? DEFAULT_MAX_LOST;
  const events = ledger.read();
  const kin: Lineage = options.projectsDirs
    ? lineageAt(options.projectsDirs)
    : lineage(options.env);

  const cards = scanStore(store, copySessionIds(events));
  // Resolved to one whole account before anything is planned, the way every other
  // flag taking an abbreviated id is. A bare `startsWith` had both failure modes
  // this refuses: a prefix matching two accounts repointed and removed cards in
  // one the user never named, and a typo matching none produced an empty plan,
  // which reads as "nothing is forked here" — a clean bill of health for a store
  // that was never looked at.
  const to =
    options.to === undefined
      ? undefined
      : requireUniquePrefix(cards, options.to, (card) => card.account.accountUuid, {
          none: `No account here holds sessions matching --to "${options.to}".`,
          ambiguous: (ids) => ambiguousIds('--to', options.to!, 'account', ids),
        })[0]!.account.accountUuid;

  const forks = forksOf(cards.map((card) => card.data.cliSessionId).filter(isPresent), kin);

  // Keyed on the card's own id: a surplus row is found by scanning, and removing
  // it needs the ledger entry that recorded it.
  const fosterings = new Map<string, ActiveFostering>();
  for (const fostering of listActive(project(events))) {
    fosterings.set(fostering.copySessionId, fostering);
  }

  const entries: ConsolidationEntry[] = [];
  for (const [, group] of groupByAccountAndWork(cards, forks, to)) {
    const entry = planOne(group, fosterings, maxLost);
    if (entry && wanted(entry, options.sessionIds)) entries.push(entry);
  }

  return entries;
}

interface WorkGroup {
  account: AccountRef;
  fork: Fork;
  rows: DiscoveredSession[];
}

function groupByAccountAndWork(
  cards: DiscoveredSession[],
  forks: ReturnType<typeof forksOf>,
  /** A whole account uuid, already resolved from whatever the caller abbreviated. */
  accountUuid: string | undefined,
): Map<string, WorkGroup> {
  const groups = new Map<string, WorkGroup>();

  for (const card of cards) {
    if (accountUuid !== undefined && card.account.accountUuid !== accountUuid) continue;
    const fork = forks.of(card.data.cliSessionId);
    if (!fork) continue;

    const key = `${card.account.accountUuid}/${card.account.organizationUuid}@${fork.root}`;
    const group = groups.get(key);
    if (group) group.rows.push(card);
    else groups.set(key, { account: card.account, fork, rows: [card] });
  }

  return groups;
}

function planOne(
  group: WorkGroup,
  fosterings: Map<string, ActiveFostering>,
  maxLost: number,
): ConsolidationEntry | undefined {
  const { account, fork, rows } = group;
  const tip = fork.branches[0]!;
  const keeper = chooseKeeper(rows, fork);
  const title = keeper.data.title ?? keeper.data.sessionId;

  // What collapsing *this* account's rows would take off its sidebar: the records
  // held alone by the branches it actually shows. `fork.lost` is the same sum over
  // every branch in the store, which for a three-way fork charges an account for
  // hiding a half it never had a row for.
  const shown = new Set(rows.map((row) => row.data.cliSessionId));
  let hides = 0;
  for (const branch of fork.branches) {
    if (branch.cliSessionId === tip.cliSessionId) continue;
    if (shown.has(branch.cliSessionId)) hides += branch.only;
  }

  const base = { account, fork, title, hides, remove: [], keptApart: [] } as const;

  const remove: ActiveFostering[] = [];
  const keptApart: ConsolidationEntry['keptApart'] = [];
  for (const row of rows) {
    if (row === keeper) continue;
    const fostering = fosterings.get(row.data.sessionId);
    if (row.isCopy && fostering) remove.push(fostering);
    else {
      keptApart.push({
        sessionId: row.data.sessionId,
        cliSessionId: row.data.cliSessionId ?? '',
        title: row.data.title ?? row.data.sessionId,
      });
    }
  }

  const from = keeper.data.cliSessionId;
  const moves = from !== tip.cliSessionId;

  // Asked before the divergence test, not after. An account already showing one
  // card on the tip has nothing to consolidate whatever the other halves weigh,
  // and reporting it as left alone invited the user to raise a threshold that
  // would change nothing for it.
  if (!moves && remove.length === 0 && keptApart.length === 0) {
    return { ...base, status: 'settled', remove: [], keptApart: [] };
  }

  if (fork.lost > maxLost) {
    return { ...base, status: 'diverged', remove: [], keptApart: [] };
  }

  // Every surplus row here is the app's own. Foster removes what foster wrote, so
  // there is nothing to do but say the pair is there and whose it is.
  if (!moves && remove.length === 0) {
    return { ...base, status: 'app-made', remove: [], keptApart };
  }

  return {
    ...base,
    status: 'consolidate',
    ...(moves && from
      ? {
          repoint: {
            path: keeper.path,
            target: account,
            to: tip.cliSessionId,
            native: !keeper.isCopy,
            title,
            from,
            sessionId: keeper.data.sessionId,
            ...(tip.lastMessageAt === undefined ? {} : { activityAt: tip.lastMessageAt }),
          },
        }
      : {}),
    remove,
    keptApart,
  };
}

/**
 * Which of an account's rows for one piece of work survives.
 *
 * A card the app made is preferred over a copy, as everywhere else — foster
 * removes what foster wrote. Between two cards of the same kind, the one already
 * closest to the tip, so the tidy-up moves as little as it can. Repointing a card
 * that was about to be deleted would be a write for nothing.
 */
function chooseKeeper(rows: DiscoveredSession[], fork: Fork): DiscoveredSession {
  const rank = new Map(fork.branches.map((branch, index) => [branch.cliSessionId, index]));
  const placeOf = (row: DiscoveredSession): number =>
    rank.get(row.data.cliSessionId ?? '') ?? Number.MAX_SAFE_INTEGER;

  return rows.reduce((best, row) => {
    if (best.isCopy !== row.isCopy) return best.isCopy ? row : best;
    return placeOf(row) < placeOf(best) ? row : best;
  });
}

function wanted(entry: ConsolidationEntry, sessionIds: string[] | undefined): boolean {
  if (!sessionIds?.length) return true;
  return sessionIds.some(
    (prefix) =>
      entry.fork.branches.some((branch) => branch.cliSessionId.startsWith(prefix)) ||
      entry.fork.root.startsWith(prefix) ||
      entry.repoint?.sessionId.startsWith(prefix) === true ||
      entry.remove.some((fostering) => fostering.copySessionId.startsWith(prefix)),
  );
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}
