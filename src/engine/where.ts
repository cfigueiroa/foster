import { bareSessionId } from '../domain/naming.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import type { LedgerState } from '../ledger/project.js';
import type { RetitledCard } from '../ledger/types.js';
import { fileOpenedFrom, scanConversation, type ConversationScan } from '../store/transcripts.js';
import { weighScans, type ScanWeight } from './branches.js';
import { byContinuation } from './fileCards.js';
import type { Lineage } from './lineage.js';

/**
 * "Where is this conversation, and which row is the one to continue in?"
 *
 * The manual recipe this replaces was three separate measurements, run by hand
 * whenever a conversation "didn't come in the sweep": grep every account's
 * cards for the id or the title, read the transcript directory to see how many
 * files it occupies, and weigh those files against each other to guess which
 * row was still worth opening. All three questions have working answers
 * already — `Lineage`, `weighScans`, the ledger's own fold — this module only
 * puts them in front of one query instead of three ad-hoc reads.
 *
 * A conversation shown twice happens two different ways, and both are in
 * scope here, unlike `fileCards.ts` and `branchCards.ts`, which only ever see
 * one of them at a time because each runs inside a single account's sweep:
 *
 *  - the same `cliSessionId`, opened from two working directories, which
 *    leaves two *files* (`Lineage.reachOf`, `fileCards.ts`);
 *  - a fork, two different `cliSessionId`s sharing a root, each its own file
 *    (`Lineage.rootOf`, `branches.ts`, `branchCards.ts`).
 *
 * Both are decided by the same measure — records a row's file holds that no
 * sibling's does, weighed with `weighScans`, the shared engine both passes in
 * `src/engine/` already stand on — so this module ranks every row across the
 * whole family (every id sharing the conversation's root, every file any of
 * them opens) in one pass rather than choosing a file-election path or a
 * branch-election path up front.
 */

/** One card, wherever on the machine it was found. */
export interface WhereEntry {
  store: StoreLayout;
  /** The name it is registered under, when `foster profile register` gave it one. */
  storeName?: string;
  account: AccountRef;
  session: DiscoveredSession;
}

/** A query matches an id (bare or `local_`-prefixed, any unique prefix) or a title fragment. */
export function matchesQuery(session: DiscoveredSession, query: string): boolean {
  // `local_` is stripped from both sides, the same convention `selectByKey`
  // (`domain/filter.ts`) keeps for every other identifier flag: a query typed
  // with the app's own prefix matches exactly as well as the bare id does.
  const q = bareSessionId(query.trim()).toLowerCase();
  if (q === '') return false;
  const cli = bareSessionId(session.data.cliSessionId ?? '').toLowerCase();
  const sid = bareSessionId(session.data.sessionId).toLowerCase();
  if (cli.startsWith(q) || sid.startsWith(q)) return true;
  const title = (session.data.title ?? '').toLowerCase();
  return title.includes(q);
}

export type WhereQueryResult =
  | { kind: 'id'; id: string }
  | { kind: 'ambiguous'; groups: { root: string; cliSessionIds: string[] }[] }
  | { kind: 'none' };

/**
 * Which conversation a query names, among every card this run found.
 *
 * A query matching more than one card is not automatically ambiguous: two
 * matches sharing a root are one conversation — a fork, or the same id opened
 * from two working directories — so the ids are rooted before being counted.
 * Only cards whose `cliSessionId` is known take part; a title match on a card
 * with no transcript at all has no root to compare and is left out rather
 * than guessed into either bucket (rare in practice — a conversation worth
 * asking `where` about has been written to).
 */
export function resolveWhereQuery(
  entries: readonly WhereEntry[],
  query: string,
  kin: Lineage,
): WhereQueryResult {
  const matches = entries.filter(
    (entry) => matchesQuery(entry.session, query) && entry.session.data.cliSessionId,
  );
  if (matches.length === 0) return { kind: 'none' };

  const idsPresent = [...new Set(matches.map((entry) => entry.session.data.cliSessionId!))];
  const universeIds = entries
    .map((entry) => entry.session.data.cliSessionId)
    .filter((id): id is string => Boolean(id));
  kin.deepen([...new Set([...idsPresent, ...universeIds])]);

  const byRoot = new Map<string, string[]>();
  for (const id of idsPresent) {
    const root = kin.rootOf(id) ?? id;
    const group = byRoot.get(root);
    if (group) group.push(id);
    else byRoot.set(root, [id]);
  }

  if (byRoot.size > 1) {
    return {
      kind: 'ambiguous',
      groups: [...byRoot.entries()].map(([root, cliSessionIds]) => ({ root, cliSessionIds })),
    };
  }

  return { kind: 'id', id: idsPresent[0]! };
}

/** One row of the report: a card, what it opens, and what the ledger knows about it. */
export interface WhereRow {
  store: string;
  storeName?: string;
  account: AccountRef;
  sessionId: string;
  cliSessionId: string;
  title: string;
  cwd?: string;
  isCopy: boolean;
  archived: boolean;
  /** The file this row opens, when that can be told — see `Lineage.reachOf`. */
  file?: string;
  /** Records that file holds, when the file is known. */
  reaches?: number;
  /** Records that file holds and no sibling file does. */
  only?: number;
  /** The last answer on this row's file, epoch ms. */
  stoppedAt?: number;
  /** Set when a fostering in the ledger says this card is a copy foster made. */
  fosteredFrom?: {
    originSessionId: string;
    origin: AccountRef;
    originStore?: string;
    fosteredAt: number;
  };
  /** How many active fosterings the ledger says were made *from* this card. */
  copiesMadeFromHere: number;
  /** What the ledger's own fold knows about a mark on this card, if any. */
  mark?: RetitledCard;
  /** True for the row `byWorkingRow` below elects — the one to continue in. */
  working: boolean;
}

export interface WhereReport {
  /** The id the query resolved to. */
  cliSessionId: string;
  /** Every id in the same family — the query's id, plus any fork sibling sharing its root. */
  family: string[];
  /** The conversation's root, when a transcript answered it. */
  root?: string;
  /** Every file any id in the family occupies, most records first. */
  files: { path: string; records: number }[];
  /** Records held anywhere in the family — the union `reaches` is measured against. */
  totalRecords: number;
  rows: WhereRow[];
  /** The elected row, mirrored from `rows` for a caller that wants it without a scan. */
  working?: WhereRow;
}

/** One file's own scan, read once and shared by every row that opens it. */
function scansOf(files: readonly string[]): Map<string, ConversationScan> {
  const scans = new Map<string, ConversationScan>();
  for (const file of files) scans.set(file, scanConversation(file));
  return scans;
}

/** The one file a row opens, out of everything its own id's conversation occupies. */
function openedFile(files: readonly string[], cwd: string | undefined): string | undefined {
  if (files.length === 1) return files[0];
  return fileOpenedFrom(files, cwd);
}

/** Sorts first the account whose rows should win an otherwise-tied election. */
function accountRank(
  row: { account: AccountRef; archived: boolean },
  target: string | undefined,
): number {
  const isTarget = target !== undefined && row.account.accountUuid === target;
  if (isTarget) return row.archived ? 1 : 0;
  return row.archived ? 3 : 2;
}

/**
 * Where the work was left, across the whole family — the exact election
 * `fileCards.ts`'s `byContinuation` runs for the sweep, reused here rather
 * than reimplemented so the two can never rank two rows in a different
 * order for the same conversation. Undefined weight sorts last: a row whose
 * file cannot be told is not evidence of anything, only unmeasured — the
 * one case the shared comparator does not itself need to handle, since the
 * sweep only ever calls it on rows it has already filtered down to the
 * measurable ones.
 *
 * `byContinuation` decides between *files*, never between two rows that
 * open the very same one — for a single file, every metric it looks at
 * (`lastAssistantAt`, `only`, `lastMessageAt`, `total`) comes from that
 * file's one shared `ScanWeight`, so it degenerates to its own last resort,
 * the row id, which is arbitrary across accounts. Measured on a real store
 * (24/09/2026, milestone D1): naming the row to continue in that way named
 * a row in another account — one of them archived — in 2 of 4 checks,
 * although the signed-in (target) account had a row open on the very same
 * file. `accountRank` is the tiebreak this needs instead, tried only when
 * `byContinuation` would otherwise fall through to comparing ids on a tied
 * file: the target account's own visible row first, then its archived row
 * — the target's own card, however filed, still beats a jump to another
 * account — then another account's visible row, then the rest. `target` is
 * the signed-in account's uuid; left undefined (no signed-in account could
 * be read), every row ranks the same here and the id is still the last word.
 */
function byWorkingRow(
  a: {
    weight?: ScanWeight;
    sessionId: string;
    file?: string;
    account: AccountRef;
    archived: boolean;
  },
  b: {
    weight?: ScanWeight;
    sessionId: string;
    file?: string;
    account: AccountRef;
    archived: boolean;
  },
  target: string | undefined,
): number {
  if (a.weight === undefined && b.weight === undefined) {
    return a.sessionId.localeCompare(b.sessionId);
  }
  if (a.weight === undefined) return 1;
  if (b.weight === undefined) return -1;
  if (a.file !== undefined && a.file === b.file) {
    const rank = accountRank(a, target) - accountRank(b, target);
    return rank !== 0 ? rank : a.sessionId.localeCompare(b.sessionId);
  }
  return byContinuation(a.weight, b.weight, a.sessionId, b.sessionId);
}

/**
 * Every id sharing `id`'s root, among the ids this run has actually seen a
 * card for — the same bound `forksOf` documents for itself: a branch nobody
 * holds a card for anywhere is invisible here, which is the right bound for a
 * report about cards, not about every transcript on disk.
 */
export function familyOf(id: string, universe: Iterable<string>, kin: Lineage): string[] {
  const ids = [...new Set([id, ...universe])];
  kin.deepen(ids);
  const root = kin.rootOf(id);
  if (root === undefined) return [id];
  return ids.filter((other) => kin.rootOf(other) === root);
}

/**
 * Build the report for one conversation, given every card this run found for
 * its family — see `familyOf`. `state` is the ledger's own fold, read once by
 * the caller. `target`, when known, is the signed-in account's uuid — see
 * `byWorkingRow`'s own comment for what it changes.
 */
export function buildWhereReport(
  id: string,
  entries: readonly WhereEntry[],
  kin: Lineage,
  state: LedgerState,
  target?: string,
): WhereReport {
  const family = familyOf(
    id,
    entries.map((entry) => entry.session.data.cliSessionId).filter((x): x is string => Boolean(x)),
    kin,
  );
  const familySet = new Set(family.map((f) => f.toLowerCase()));

  const cards = entries.filter((entry) => {
    const cliId = entry.session.data.cliSessionId;
    return cliId !== undefined && familySet.has(cliId.toLowerCase());
  });

  // Every file any id in the family occupies — the population `weighScans`
  // ranks over, so a row on one id is weighed against a sibling's file too,
  // not only against the other file of its own id. `transcripts()` is keyed
  // exactly as the directory walk found it, which in practice is how the CLI
  // wrote the filename; ids are compared case-folded everywhere else in this
  // codebase, so the lookup is too.
  const transcriptIndex = kin.transcripts();
  const byLowerId = new Map<string, string>();
  for (const key of transcriptIndex.keys()) byLowerId.set(key.toLowerCase(), key);

  const filesByCliId = new Map<string, string[]>();
  const allFiles = new Set<string>();
  for (const cliId of family) {
    const actualKey = byLowerId.get(cliId.toLowerCase());
    const files = actualKey === undefined ? [] : (transcriptIndex.get(actualKey) ?? []);
    filesByCliId.set(cliId.toLowerCase(), files);
    for (const file of files) allFiles.add(file);
  }

  const scans = scansOf([...allFiles]);
  const weights = weighScans(scans);

  const totalUuids = new Set<string>();
  for (const scan of scans.values()) for (const uuid of scan.uuids) totalUuids.add(uuid);

  const active = [...state.active.values()];

  const rows: WhereRow[] = cards.map((entry) => {
    const cliId = entry.session.data.cliSessionId!;
    const files = filesByCliId.get(cliId.toLowerCase()) ?? [];
    const file = openedFile(files, entry.session.data.cwd);
    const weight = file ? weights.get(file) : undefined;

    const sessionId = entry.session.data.sessionId;
    const fostering = active.find((f) => f.copySessionId === sessionId);
    const copiesMadeFromHere = active.filter((f) => f.originSessionId === sessionId).length;
    const mark = state.retitled.get(sessionId);

    return {
      store: entry.store.root,
      ...(entry.storeName ? { storeName: entry.storeName } : {}),
      account: entry.account,
      sessionId,
      cliSessionId: cliId,
      title: entry.session.data.title ?? '(untitled)',
      ...(entry.session.data.cwd === undefined ? {} : { cwd: entry.session.data.cwd }),
      isCopy: entry.session.isCopy,
      archived: Boolean(entry.session.data.isArchived),
      ...(file === undefined ? {} : { file }),
      ...(weight === undefined ? {} : { reaches: weight.total, only: weight.only }),
      ...(weight?.lastAssistantAt === undefined ? {} : { stoppedAt: weight.lastAssistantAt }),
      ...(fostering === undefined
        ? {}
        : {
            fosteredFrom: {
              originSessionId: fostering.originSessionId,
              origin: fostering.origin,
              ...(fostering.originStore === undefined
                ? {}
                : { originStore: fostering.originStore }),
              fosteredAt: fostering.fosteredAt,
            },
          }),
      copiesMadeFromHere,
      ...(mark === undefined ? {} : { mark }),
      working: false,
    };
  });

  const ranked = [...rows].sort((a, b) =>
    byWorkingRow(
      {
        weight: a.file ? weights.get(a.file) : undefined,
        sessionId: a.sessionId,
        ...(a.file === undefined ? {} : { file: a.file }),
        account: a.account,
        archived: a.archived,
      },
      {
        weight: b.file ? weights.get(b.file) : undefined,
        sessionId: b.sessionId,
        ...(b.file === undefined ? {} : { file: b.file }),
        account: b.account,
        archived: b.archived,
      },
      target,
    ),
  );
  const winner = ranked[0];
  if (winner) winner.working = true;

  const files = [...scans.entries()]
    .map(([path, scan]) => ({ path, records: scan.uuids.size }))
    .sort((a, b) => b.records - a.records);

  return {
    cliSessionId: id,
    family,
    ...(kin.rootOf(id) === undefined ? {} : { root: kin.rootOf(id) }),
    files,
    totalRecords: totalUuids.size,
    rows,
    ...(winner ? { working: winner } : {}),
  };
}
