import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import { DEFAULT_OTHER_FILE_TEMPLATE, formatStamp } from '../src/domain/stale.js';
import type { CodeSessionData, StoreLayout } from '../src/domain/types.js';
import { Ledger } from '../src/ledger/log.js';
import { runSweep, type SweepOptions } from '../src/ops/sweep.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * One conversation, two files, two rows — and which of them the sidebar should
 * put forward. See `src/engine/fileCards.ts`: the pass exists because the sweep
 * brings both rows on purpose and they used to arrive wearing the same title,
 * leaving the reader to pick between them blind.
 *
 * Everything here goes through `runSweep` rather than the planner alone. The
 * pass reads the destination *after* the fostering pass has written to it, and
 * a test that planned against the cards the run started from would be testing a
 * situation production never sees.
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000000d1';
const REPO_CARD = '00000000-0000-4000-8000-0000000000d2';
const TREE_CARD = '00000000-0000-4000-8000-0000000000d3';
const BLIND_CARD = '00000000-0000-4000-8000-0000000000d4';
const TWIN_CARD = '00000000-0000-4000-8000-0000000000d5';
const ROOT = '00000000-0000-4000-8000-0000000000e0';
const SHARED = '00000000-0000-4000-8000-0000000000e1';
const REPO_ONLY = '00000000-0000-4000-8000-0000000000e2';
const TREE_ONLY = '00000000-0000-4000-8000-0000000000e3';

const FORK_SIBLING = '00000000-0000-4000-8000-0000000000d6';
const SIBLING_CARD = '00000000-0000-4000-8000-0000000000d7';
const SIBLING_ONLY = '00000000-0000-4000-8000-0000000000e4';

const REPO = 'C:\\work\\project';
const TREE = 'C:\\work\\project\\.claude\\worktrees\\w';
const TREE_PROJECT = 'C--work-project--claude-worktrees-w';

const TREE_LAST_ANSWER = '2026-09-02T09:00:00.000Z';
const REPO_LAST_ANSWER = '2026-09-02T11:00:00.000Z';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-files-')), 'l.jsonl'));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-files-cfg-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
  mkdirSync(accountDir(store, OLD_ACCOUNT), { recursive: true });
});

function sweep(extra: Partial<SweepOptions> = {}) {
  return runSweep({
    store,
    ledger,
    target: NEW_ACCOUNT,
    env,
    projectsDirs: [path.join(configDir, 'projects')],
    list: () => [],
    ...extra,
  });
}

function rec(uuid: string, type: 'user' | 'assistant', timestamp: string) {
  return { uuid, type, timestamp };
}

function transcript(
  records: Record<string, unknown>[],
  project = 'C--work-project',
  cliSessionId = CONVERSATION,
): void {
  const dir = path.join(configDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${cliSessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join('\n'),
    'utf8',
  );
}

/**
 * The repository's file carries the later answer; the worktree's carries a
 * record of its own, so neither row can be dismissed as holding nothing.
 */
function twoFiles(options: { treeAnswer?: string; repoAnswer?: string } = {}): void {
  const meta = { type: 'custom-title', customTitle: 'Macs' };
  transcript([
    meta,
    rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
    rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
    rec(REPO_ONLY, 'assistant', options.repoAnswer ?? REPO_LAST_ANSWER),
  ]);
  transcript(
    [
      meta,
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
      rec(TREE_ONLY, 'assistant', options.treeAnswer ?? TREE_LAST_ANSWER),
    ],
    TREE_PROJECT,
  );
}

/** The row this account already shows, and the card another account holds. */
function bothRows(overrides: Partial<CodeSessionData> = {}): void {
  writeSession(
    store,
    NEW_ACCOUNT,
    session({
      sessionId: TREE_CARD,
      cliSessionId: CONVERSATION,
      title: 'Macs',
      cwd: TREE,
      originCwd: TREE,
      ...overrides,
    }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({
      sessionId: REPO_CARD,
      cliSessionId: CONVERSATION,
      title: 'Macs',
      cwd: REPO,
      originCwd: REPO,
    }),
  );
}

/**
 * Both rows already here, which is the state this pass actually meets on a real
 * store: the second row arrived on an earlier sweep. Written straight into the
 * destination rather than fostered in, because a card that opens no file makes
 * `Sidebar.unreached` fall back to the whole conversation — deliberately, see
 * `sidebar.ts` — and the fostering pass then has nothing left to bring.
 */
function rowsHere(extra: Partial<CodeSessionData>[] = []): void {
  for (const data of [
    { sessionId: TREE_CARD, cwd: TREE, originCwd: TREE },
    { sessionId: REPO_CARD, cwd: REPO, originCwd: REPO },
    ...extra,
  ]) {
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ cliSessionId: CONVERSATION, title: 'Macs', ...data }),
    );
  }
}

function cards(): CodeSessionData[] {
  return scanAccount(store, NEW_ACCOUNT).map((entry) => entry.data);
}

function titled(prefix: string): CodeSessionData | undefined {
  return cards().find((data) => data.title?.startsWith(prefix));
}

const mark = (answer: string): string =>
  DEFAULT_OTHER_FILE_TEMPLATE.replace('{when}', formatStamp(Date.parse(answer)));

describe('a conversation this account shows more than once', () => {
  it('leaves the row whose last answer is the most recent alone, and marks the other', () => {
    twoFiles();
    bothRows();

    const report = sweep();

    // The copy the fostering pass brought opens the repository's file, which
    // holds the later answer: it is the row to continue in, mark-free.
    expect(report.files.plans).toHaveLength(1);
    const plan = report.files.plans[0]!;
    expect(plan.working.title).toBe('Macs');
    const working = cards().find((data) => data.sessionId === plan.working.sessionId)!;
    expect(working.cwd).toBe(REPO);
    expect(working.title).toBe('Macs');
    expect(working.isArchived).toBe(false);

    // The row that was already here opens the worktree's file, whose last
    // answer is two hours older. It says so, and it is filed away.
    const marked = cards().find((data) => data.sessionId === `local_${TREE_CARD}`)!;
    expect(marked.title).toBe(`${mark(TREE_LAST_ANSWER)}Macs`);
    expect(marked.isArchived).toBe(true);
  });

  it('marks the row the app made, not just foster\u2019s own copy', () => {
    // The same fixture with the answers the other way round: now the row this
    // account already had is the one to continue in, and the copy the sweep
    // just wrote is the one that gets the mark.
    twoFiles({ treeAnswer: REPO_LAST_ANSWER, repoAnswer: TREE_LAST_ANSWER });
    bothRows();

    sweep();

    const kept = cards().find((data) => data.sessionId === `local_${TREE_CARD}`)!;
    expect(kept.title).toBe('Macs');
    expect(kept.isArchived).toBe(false);
    expect(titled(mark(TREE_LAST_ANSWER))?.cwd).toBe(REPO);
  });

  it('never elects a row that opens no file at all', () => {
    twoFiles();
    // A row pointing somewhere this conversation was never written: the app
    // opens nothing from it. Measured on a real store, 4 of 12 pairs had one.
    rowsHere([
      {
        sessionId: BLIND_CARD,
        cwd: 'C:\\work\\elsewhere',
        originCwd: 'C:\\work\\elsewhere',
      },
    ]);

    const report = sweep();

    const plan = report.files.plans[0]!;
    expect(plan.working.sessionId).toBe(`local_${REPO_CARD}`);
    // The blind row is marked like any other row that is not the one to
    // continue in, and its mark carries the undated dash rather than a moment
    // invented for it.
    const blind = cards().find((data) => data.sessionId === `local_${BLIND_CARD}`)!;
    expect(blind.title).toBe(`${DEFAULT_OTHER_FILE_TEMPLATE.replace('{when}', '—')}Macs`);
    expect(blind.isArchived).toBe(true);
  });

  it('settles: a second run marks nothing and says nothing is left', () => {
    twoFiles();
    bothRows();

    const first = sweep();
    expect(first.files.retitled.filter((outcome) => outcome.status === 'retitled')).toHaveLength(1);
    expect(first.confirmation).toMatchObject({ secondFiles: 0, exhausted: true });

    const second = sweep();
    expect(second.files.retitled.filter((outcome) => outcome.status === 'retitled')).toHaveLength(
      0,
    );
    expect(second.confirmation).toMatchObject({ secondFiles: 0, exhausted: true });
  });

  it('recognises a mark an earlier run wrote in other words, and leaves it alone', () => {
    twoFiles();
    bothRows();

    sweep();
    const marked = titled(mark(TREE_LAST_ANSWER))!;

    // The same store swept again by someone who reads their sidebar in
    // Portuguese. The moment has not changed, so neither should the row (#35).
    const second = sweep({ otherFileTemplate: '(outro arquivo, parou {when}) ' });

    expect(second.files.retitled.filter((outcome) => outcome.status === 'retitled')).toHaveLength(
      0,
    );
    expect(titled(mark(TREE_LAST_ANSWER))?.sessionId).toBe(marked.sessionId);
  });

  it('survives the title pass in the same run, rather than fighting it', () => {
    twoFiles();
    bothRows();

    const report = sweep({ syncTitles: true });

    // #79's loop: the mark goes on, the title sync strips it, the next sweep
    // writes it again. The mark has to be standing when the run ends.
    expect(report.files.retitled.filter((outcome) => outcome.status === 'retitled')).toHaveLength(
      1,
    );
    expect(titled(mark(TREE_LAST_ANSWER))).toBeDefined();
    expect(sweep({ syncTitles: true }).confirmation).toMatchObject({
      secondFiles: 0,
      exhausted: true,
    });
  });

  it('leaves a conversation a live claude is writing exactly as it is', () => {
    twoFiles();
    bothRows();

    const report = sweep({ live: new Set([CONVERSATION.toLowerCase()]) });

    expect(report.files.retitled).toHaveLength(0);
    expect(report.files.plans[0]!.skipped).toHaveLength(1);
    expect(cards().every((data) => data.title === 'Macs')).toBe(true);
  });

  it('says nothing about two rows that open the same file', () => {
    twoFiles();
    // A second row on the very file the row to continue in opens: a duplicate,
    // which is a different problem and not this pass's to describe.
    rowsHere([{ sessionId: TWIN_CARD, cwd: REPO, originCwd: REPO }]);

    const report = sweep();

    const rows = report.files.plans[0]!.rows;
    const twin = rows.find((row) => row.sessionId === `local_${TWIN_CARD}`)!;
    expect(twin.working).toBe(false);
    expect(twin.action).toBe('none');
    expect(cards().find((data) => data.sessionId === `local_${TWIN_CARD}`)!.title).toBe('Macs');
  });

  it('elects the file with more of its own work over one merely clicked more recently', () => {
    // Both files share the same last *answer* — a tie on `lastAssistantAt` —
    // but the worktree's file was opened afterwards and picked up nothing but
    // a click, which moves `lastMessageAt` without being work. Before the fix
    // the tie fell back to `lastMessageAt`, so opening the marked row every
    // run flipped which one it elected; `only` (what a file holds that its
    // sibling does not) is asked first now, and the click does not move it.
    const meta = { type: 'custom-title', customTitle: 'Macs' };
    const tie = '2026-09-01T20:01:00.000Z';
    transcript([
      meta,
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec(SHARED, 'assistant', tie),
      rec(REPO_ONLY, 'user', '2026-09-01T20:02:00.000Z'),
      rec('00000000-0000-4000-8000-0000000000e5', 'user', '2026-09-01T20:03:00.000Z'),
    ]);
    transcript(
      [
        meta,
        rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
        rec(SHARED, 'assistant', tie),
        // The click: a much later message, no answer after it.
        rec(TREE_ONLY, 'user', '2026-09-01T23:00:00.000Z'),
      ],
      TREE_PROJECT,
    );
    bothRows();

    const report = sweep();

    const plan = report.files.plans[0]!;
    const working = cards().find((data) => data.sessionId === plan.working.sessionId)!;
    // The repository's file: fewer records overall, but two of its own against
    // the worktree's one, and it is where the work — not the click — was left.
    expect(working.cwd).toBe(REPO);
  });

  it('does not flip against the branch pass when a row is the tip and the older file', () => {
    // The row can lose both questions at once: it is the tip of a fork — so the
    // branch pass wants no mark on it — and the older of two files of its own
    // conversation, so this pass wants one. Each pass owning only its own marks
    // is what stops that becoming a mark written and stripped on every run;
    // measured on a real store, two rows flipped that way and the sweep never
    // said it was finished (#79's shape, from the other side).
    twoFiles();
    rowsHere();
    // A sibling branch of the same work: shares the history, stopped earlier, so
    // the two-file conversation is the tip.
    transcript(
      [
        { type: 'custom-title', customTitle: 'Macs' },
        rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
        rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
        rec(SIBLING_ONLY, 'assistant', '2026-09-01T21:00:00.000Z'),
      ],
      'C--work-project',
      FORK_SIBLING,
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: SIBLING_CARD,
        cliSessionId: FORK_SIBLING,
        title: 'Macs',
        cwd: REPO,
        originCwd: REPO,
      }),
    );

    const first = sweep();
    expect(first.files.retitled.filter((outcome) => outcome.status === 'retitled')).toHaveLength(1);
    const marked = titled(mark(TREE_LAST_ANSWER))!;
    expect(marked.sessionId).toBe(`local_${TREE_CARD}`);

    // The run that used to undo it. The branch pass sees a tip wearing a mark
    // and leaves it alone, because the mark is not its own.
    const second = sweep();
    expect(
      second.branches.retitled.filter((outcome) => outcome.status === 'retitled'),
    ).toHaveLength(0);
    expect(second.files.retitled.filter((outcome) => outcome.status === 'retitled')).toHaveLength(
      0,
    );
    expect(second.confirmation).toMatchObject({ branches: 0, secondFiles: 0, exhausted: true });
    expect(titled(mark(TREE_LAST_ANSWER))?.sessionId).toBe(`local_${TREE_CARD}`);
  });
});
