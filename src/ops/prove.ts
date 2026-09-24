import { blockingReasons } from '../domain/filter.js';
import type { AccountRef, DiscoveredSession, Unfosterable } from '../domain/types.js';
import type { Lineage } from '../engine/lineage.js';
import { NEVER_COMES } from './sweep.js';

/**
 * Independent proof that a sweep actually closed the gap it reported — the
 * audit `.claude/commands/fosteia.md` used to run by hand, after three
 * incidents (06/09, 14/09, 15/09/2026; #114 lost 2116 records once) where a
 * sweep that said "nothing is left" had not, in fact, brought everything.
 *
 * Deliberately not built from the sweep's own bookkeeping — `Outcome.beyond`,
 * `Sidebar.unreached`, the passes' own plans. Two of the three incidents above
 * were bugs *in* that bookkeeping (`fullerOf` choosing by raw total rather
 * than by what the destination lacked, #41; a second round's own writes not
 * being seen by the first round's plan, #114), so checking with the same
 * arithmetic would have missed the same bugs the same way. This instead reads
 * every card the store holds for a conversation, reads every file its id
 * occupies end to end (`Lineage.scanOf` — the same set-difference primitive,
 * but asked fresh, of the id alone, with no sweep state in between), and
 * compares that union against what the target account's own cards reach.
 *
 * Scoped to one `cliSessionId` at a time on purpose, the same way
 * `fileCards.ts` is: a fork is a *different* id sharing a root, and whether
 * every branch got a row is the sweep's branch pass's own question, already
 * reported in `SweepReport.branches`. This measures the other thing the
 * branch pass does not: one id split across two working directories, and
 * whether the target's cards for it, together, reach every record either file
 * holds.
 */

export interface ProveGap {
  cliSessionId: string;
  title?: string;
  totalRecords: number;
  reachedByTarget: number;
  missing: number;
}

/** A conversation counted apart from the gaps: nothing outside the target could ever have brought it. */
export interface ProveNeverFosterable {
  cliSessionId: string;
  title?: string;
  /** The reason counted, chosen the way `sweep`'s own `countNeverComes` chooses one. */
  reason: Unfosterable;
}

export interface ProveReport {
  /** Conversations examined — every id at least one card in the store names. */
  conversations: number;
  gaps: ProveGap[];
  neverFosterable: ProveNeverFosterable[];
  /** True when `gaps` is empty. */
  complete: boolean;
}

function sameCard(a: DiscoveredSession, target: AccountRef): boolean {
  return (
    a.account.accountUuid === target.accountUuid &&
    a.account.organizationUuid === target.organizationUuid
  );
}

/**
 * `storeCards` is every card in the store, every account — target's own
 * included, read fresh so a real `--yes` run is measured against what it
 * actually wrote, and a dry run against what is on disk right now (see the
 * CLI's own note on what a dry run can and cannot simulate).
 */
export function provePlan(
  storeCards: readonly DiscoveredSession[],
  target: AccountRef,
  kin: Lineage,
): ProveReport {
  const byId = new Map<string, DiscoveredSession[]>();
  for (const card of storeCards) {
    const id = card.data.cliSessionId;
    if (!id) continue;
    const key = id.toLowerCase();
    const group = byId.get(key);
    if (group) group.push(card);
    else byId.set(key, [card]);
  }

  const gaps: ProveGap[] = [];
  const neverFosterable: ProveNeverFosterable[] = [];

  for (const [, cards] of byId) {
    // `Lineage`'s transcript index is keyed by the exact filename on disk
    // (`indexAllTranscripts`), an exact-match lookup with no case folding —
    // unlike the grouping key above. An original-case id, taken from an
    // actual card the same way `fileCards.ts`'s `groupByConversation` does,
    // is what `scanOf`/`reachOf` need; the lowercased key would silently
    // fail to find the transcript for any id that is not already all-lower.
    const id = cards[0]!.data.cliSessionId!;
    const scan = kin.scanOf(id);
    if (scan === undefined || scan.uuids.size === 0) continue;
    const total = scan.uuids.size;

    const targetCards = cards.filter((card) => sameCard(card, target));
    const reached = new Set<string>();
    for (const card of targetCards) {
      const reach = kin.reachOf(id, card.data.cwd) ?? scan;
      for (const uuid of reach.uuids) reached.add(uuid);
    }
    const missing = total - reached.size;
    if (missing <= 0) continue;

    // Cards elsewhere that could, in principle, have been fostered here — the
    // ones the gap is asking "why wasn't this brought?" of. A card the target
    // itself already holds is not a source for that question, and neither is
    // a conversation whose only cards anywhere are the target's own: that gap
    // is a third file or a stranded record, not a bringing failure, and is
    // reported as a gap on that basis rather than guessed into either bucket.
    const sources = cards.filter((card) => !sameCard(card, target));
    if (sources.length > 0) {
      const blocked = sources.map((card) => blockingReasons(card, { includeArchived: true }));
      const allBlocked = blocked.every((reasons) => NEVER_COMES.some((r) => reasons.includes(r)));
      if (allBlocked) {
        const reason = NEVER_COMES.find((r) => blocked.some((reasons) => reasons.includes(r)))!;
        neverFosterable.push({
          cliSessionId: id,
          ...(cards[0]?.data.title === undefined ? {} : { title: cards[0].data.title }),
          reason,
        });
        continue;
      }
    }

    gaps.push({
      cliSessionId: id,
      ...(cards[0]?.data.title === undefined ? {} : { title: cards[0].data.title }),
      totalRecords: total,
      reachedByTarget: reached.size,
      missing,
    });
  }

  return { conversations: byId.size, gaps, neverFosterable, complete: gaps.length === 0 };
}
