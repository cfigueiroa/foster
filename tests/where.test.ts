import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountRef, CodeSessionData, StoreLayout } from '../src/domain/types.js';
import { fosterSessions } from '../src/engine/executor.js';
import { lineageAt } from '../src/engine/lineage.js';
import {
  buildWhereReport,
  matchesQuery,
  resolveWhereQuery,
  type WhereEntry,
} from '../src/engine/where.js';
import { Ledger } from '../src/ledger/log.js';
import { project } from '../src/ledger/project.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster where` replaces a three-measurement recipe run by hand: which
 * accounts hold a card, how many files the conversation occupies, and which
 * row is the one to continue in. These fixtures cover both ways a
 * conversation can be shown more than once — the same id from two working
 * directories, and a fork into two ids — since `buildWhereReport` ranks both
 * with one measure rather than choosing a path up front.
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000000d1';
const ROOT = '00000000-0000-4000-8000-0000000000e0';

function rec(uuid: string, type: 'user' | 'assistant', timestamp: string) {
  return { uuid, type, timestamp };
}

function transcript(
  configDir: string,
  projectDir: string,
  cliSessionId: string,
  records: unknown[],
): void {
  const dir = path.join(configDir, 'projects', projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${cliSessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n'),
    'utf8',
  );
}

function projectsDirOf(configDir: string): string[] {
  return [path.join(configDir, 'projects')];
}

/** Writes a card to disk and returns the `WhereEntry` for it in one step. */
function card(
  store: StoreLayout,
  account: AccountRef,
  data: CodeSessionData,
  overrides: { isCopy?: boolean } = {},
): WhereEntry {
  const filePath = writeSession(store, account, data);
  return {
    store,
    account,
    session: {
      path: filePath,
      account,
      data,
      isCopy: overrides.isCopy ?? false,
      isStranded: false,
      reasons: [],
    },
  };
}

describe('matchesQuery', () => {
  const discovered = (data: CodeSessionData): WhereEntry['session'] => ({
    path: '/dev/null',
    account: NEW_ACCOUNT,
    data,
    isCopy: false,
    isStranded: false,
    reasons: [],
  });

  it('matches a cliSessionId prefix', () => {
    const s = discovered(
      session({ sessionId: 'local_00000000-0000-4000-8000-00000000abcd', title: 'Work' }),
    );
    expect(matchesQuery(s, '00000000-0000-4000-8000-00000000ab')).toBe(true);
    expect(matchesQuery(s, 'zz')).toBe(false);
  });

  it('matches a bare session id prefix, with or without local_', () => {
    const s = discovered(session({ sessionId: 'local_00000000-0000-4000-8000-00000000abcd' }));
    expect(matchesQuery(s, 'local_00000000-0000-4000-8000-00000000ab')).toBe(true);
    expect(matchesQuery(s, '00000000-0000-4000-8000-00000000ab')).toBe(true);
  });

  it('matches a title fragment, case-insensitively', () => {
    const s = discovered(session({ title: 'Fixing the Widget Frobnicator' }));
    expect(matchesQuery(s, 'widget frob')).toBe(true);
    expect(matchesQuery(s, 'gizmo')).toBe(false);
  });

  it('never matches an empty query', () => {
    expect(matchesQuery(discovered(session({ title: 'Work' })), '  ')).toBe(false);
  });
});

describe('buildWhereReport — one conversation, two files', () => {
  function fixture() {
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-where-'));

    // The repository's file carries the later answer.
    transcript(configDir, 'C--work-project', CONVERSATION, [
      { type: 'custom-title', customTitle: 'Work' },
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e2', 'assistant', '2026-09-02T11:00:00.000Z'),
    ]);
    // The worktree's file carries a record of its own, from earlier.
    transcript(configDir, 'C--work-project--claude-worktrees-w', CONVERSATION, [
      { type: 'custom-title', customTitle: 'Work' },
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e1', 'assistant', '2026-09-01T20:01:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e3', 'assistant', '2026-09-01T21:00:00.000Z'),
    ]);

    const entries = [
      card(
        store,
        NEW_ACCOUNT,
        session({
          sessionId: '00000000-0000-4000-8000-0000000000d2',
          cliSessionId: CONVERSATION,
          cwd: 'C:\\work\\project',
          title: 'Work',
        }),
      ),
      card(
        store,
        OLD_ACCOUNT,
        session({
          sessionId: '00000000-0000-4000-8000-0000000000d3',
          cliSessionId: CONVERSATION,
          cwd: 'C:\\work\\project\\.claude\\worktrees\\w',
          title: 'Work',
        }),
      ),
    ];

    const kin = lineageAt(projectsDirOf(configDir));
    return { store, kin, entries };
  }

  it('elects the row whose file holds the later answer', () => {
    const { kin, entries } = fixture();
    const report = buildWhereReport(CONVERSATION, entries, kin, project([]));

    expect(report.family).toEqual([CONVERSATION]);
    expect(report.files).toHaveLength(2);
    expect(report.totalRecords).toBe(4); // ROOT, e1 shared, e2, e3 — 4 distinct uuids

    const working = report.rows.find((row) => row.working);
    expect(working?.account).toEqual(NEW_ACCOUNT);
    expect(report.working?.account).toEqual(NEW_ACCOUNT);
    expect(working?.only).toBe(1); // e2 is the repo file's own record
  });

  it('reports which file each row opens and how much it reaches', () => {
    const { kin, entries } = fixture();
    const report = buildWhereReport(CONVERSATION, entries, kin, project([]));
    const tree = report.rows.find((row) => row.account.accountUuid === OLD_ACCOUNT.accountUuid);
    expect(tree?.file).toContain('claude-worktrees-w');
    expect(tree?.reaches).toBe(3);
  });
});

describe("buildWhereReport — matches the sweep's own election", () => {
  const CONVERSATION_2 = '00000000-0000-4000-8000-0000000000d9';
  const ROOT_2 = '00000000-0000-4000-8000-0000000000e9';
  const SHARED = '00000000-0000-4000-8000-0000000000ea';
  const REPO_ONLY = '00000000-0000-4000-8000-0000000000eb';
  const TREE_ONLY_1 = '00000000-0000-4000-8000-0000000000ec';
  const TREE_ONLY_2 = '00000000-0000-4000-8000-0000000000ed';

  function fixture() {
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-where-election-'));

    // The repository's file: the answer both files share, then one record of
    // its own the next morning — a click, not an answer, but it is the last
    // *message* on the file.
    transcript(configDir, 'C--work-project', CONVERSATION_2, [
      { type: 'custom-title', customTitle: 'Work' },
      rec(ROOT_2, 'user', '2026-09-01T20:00:00.000Z'),
      rec(SHARED, 'assistant', '2026-09-01T20:30:00.000Z'),
      rec(REPO_ONLY, 'user', '2026-09-02T09:00:00.000Z'),
    ]);
    // The worktree's file: two records of its own, both before the shared
    // answer, so its last *answer* ties the repository's.
    transcript(configDir, 'C--work-project--claude-worktrees-w', CONVERSATION_2, [
      { type: 'custom-title', customTitle: 'Work' },
      rec(ROOT_2, 'user', '2026-09-01T20:00:00.000Z'),
      rec(TREE_ONLY_1, 'user', '2026-09-01T20:10:00.000Z'),
      rec(TREE_ONLY_2, 'user', '2026-09-01T20:20:00.000Z'),
      rec(SHARED, 'assistant', '2026-09-01T20:30:00.000Z'),
    ]);

    const entries = [
      card(
        store,
        NEW_ACCOUNT,
        session({
          sessionId: '00000000-0000-4000-8000-0000000000d2',
          cliSessionId: CONVERSATION_2,
          cwd: 'C:\\work\\project',
          title: 'Work',
        }),
      ),
      card(
        store,
        OLD_ACCOUNT,
        session({
          sessionId: '00000000-0000-4000-8000-0000000000d3',
          cliSessionId: CONVERSATION_2,
          cwd: 'C:\\work\\project\\.claude\\worktrees\\w',
          title: 'Work',
        }),
      ),
    ];

    const kin = lineageAt(projectsDirOf(configDir));
    return { kin, entries };
  }

  it('elects the row with more of the conversation to itself, not merely the later message', () => {
    const { kin, entries } = fixture();
    const report = buildWhereReport(CONVERSATION_2, entries, kin, project([]));

    // Both files tie on the last *answer* (`SHARED`). The repository's file
    // has the later *message* (`REPO_ONLY`, a click) but only one record
    // nobody else holds; the worktree's file holds two. The sweep's own
    // election (`fileCards.ts`'s `byContinuation`) asks `only` before
    // `lastMessageAt` for exactly this reason — `where` must name the same
    // row the sweep would, not the row a click happens to be newest on.
    const working = report.rows.find((row) => row.working);
    expect(working?.account).toEqual(OLD_ACCOUNT);
    expect(report.working?.account).toEqual(OLD_ACCOUNT);
  });
});

describe('buildWhereReport — a fork', () => {
  function fixture() {
    const store = makeStore();
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-where-fork-'));
    const original = '00000000-0000-4000-8000-0000000000f1';
    const branch = '00000000-0000-4000-8000-0000000000f2';

    transcript(configDir, 'C--work-project', original, [
      { type: 'custom-title', customTitle: 'Work' },
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000f3', 'assistant', '2026-09-01T20:30:00.000Z'),
    ]);
    // The branch went on much later, and holds a record of its own.
    transcript(configDir, 'C--work-project', branch, [
      { type: 'custom-title', customTitle: 'Work' },
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000f4', 'assistant', '2026-09-03T09:00:00.000Z'),
    ]);

    const entries = [
      card(
        store,
        NEW_ACCOUNT,
        session({
          sessionId: '00000000-0000-4000-8000-0000000000d4',
          cliSessionId: original,
          title: 'Work',
        }),
      ),
      card(
        store,
        OLD_ACCOUNT,
        session({
          sessionId: '00000000-0000-4000-8000-0000000000d5',
          cliSessionId: branch,
          title: 'Work',
        }),
      ),
    ];

    const kin = lineageAt(projectsDirOf(configDir));
    return { store, kin, entries, original, branch };
  }

  it('groups both branches into one family and elects the one that carried on', () => {
    const { kin, entries, original, branch } = fixture();
    const report = buildWhereReport(original, entries, kin, project([]));

    expect(new Set(report.family)).toEqual(new Set([original, branch]));
    const working = report.rows.find((row) => row.working);
    expect(working?.cliSessionId).toBe(branch);
    expect(working?.account).toEqual(OLD_ACCOUNT);
  });
});

describe('resolveWhereQuery', () => {
  it('resolves a single match', () => {
    const store = makeStore();
    const id = '00000000-0000-4000-8000-0000000000a1';
    const entries = [card(store, NEW_ACCOUNT, session({ cliSessionId: id, title: 'Only one' }))];
    expect(resolveWhereQuery(entries, 'only one', lineageAt([]))).toEqual({ kind: 'id', id });
  });

  it('reports none for a query that matches nothing', () => {
    const store = makeStore();
    const entries = [
      card(
        store,
        NEW_ACCOUNT,
        session({ cliSessionId: '00000000-0000-4000-8000-0000000000a2', title: 'Work' }),
      ),
    ];
    expect(resolveWhereQuery(entries, 'nonexistent', lineageAt([]))).toEqual({ kind: 'none' });
  });

  it('is ambiguous across two unrelated conversations sharing a word', () => {
    const store = makeStore();
    const idA = '00000000-0000-4000-8000-0000000000a3';
    const idB = '00000000-0000-4000-8000-0000000000a4';
    const entries = [
      card(store, NEW_ACCOUNT, session({ cliSessionId: idA, title: 'Fix the login bug' })),
      card(store, OLD_ACCOUNT, session({ cliSessionId: idB, title: 'Fix the logout bug' })),
    ];
    const result = resolveWhereQuery(entries, 'fix the log', lineageAt([]));
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.groups).toHaveLength(2);
  });
});

describe('buildWhereReport — the ledger half', () => {
  it('names the fostering a copy came from, and copies made from a card', () => {
    const store = makeStore();
    const ledger = new Ledger(
      path.join(mkdtempSync(path.join(tmpdir(), 'foster-where-l-')), 'l.jsonl'),
    );
    const originId = '00000000-0000-4000-8000-0000000000b1';
    const originEntry = card(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000b2',
        cliSessionId: originId,
        title: 'Work',
      }),
    );

    const [outcome] = fosterSessions([originEntry.session], { store, ledger, target: NEW_ACCOUNT });
    expect(outcome?.status).toBe('fostered');
    const copySessionId = outcome!.copySessionId!;

    const entries = [
      originEntry,
      card(
        store,
        NEW_ACCOUNT,
        session({ sessionId: copySessionId, cliSessionId: originId, title: 'Work' }),
        { isCopy: true },
      ),
    ];

    const report = buildWhereReport(originId, entries, lineageAt([]), project(ledger.read()));
    const copyRow = report.rows.find((row) => row.sessionId === copySessionId);
    expect(copyRow?.fosteredFrom?.originSessionId).toBe(originEntry.session.data.sessionId);
    expect(copyRow?.fosteredFrom?.origin).toEqual(OLD_ACCOUNT);

    const originRow = report.rows.find(
      (row) => row.sessionId === originEntry.session.data.sessionId,
    );
    expect(originRow?.copiesMadeFromHere).toBe(1);
  });
});
