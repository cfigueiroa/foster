import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import { formatStamp } from '../src/domain/stale.js';
import type { CodeSessionData, StoreLayout } from '../src/domain/types.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import { Ledger } from '../src/ledger/log.js';
import { listRetitled, project } from '../src/ledger/project.js';
import { restartPlan, runSweep, type SweepOptions } from '../src/ops/sweep.js';
import { scanAccount, SESSION_FILE_MAX_BYTES } from '../src/store/scanner.js';
import { sweepEverything, WRITES_DISABLED } from '../src/agent/tools.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * The sweep is the three-command sequence people actually wanted, so what these
 * pin down is the part a hand-run sequence kept getting wrong: archived sessions
 * are in, deleted ones come back, the run says whether it is finished, the gap it
 * cannot close is counted, and it never restarts an app it is running inside.
 */

const ARCHIVED = '00000000-0000-4000-8000-0000000000a1';
const ORDINARY = '00000000-0000-4000-8000-0000000000a2';
const DELETED_CLI = '00000000-0000-4000-8000-0000000000c1';
const DELETED_SESSION = '00000000-0000-4000-8000-0000000000c2';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-sweep-')), 'l.jsonl'));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-sweep-cfg-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  // The destination has to exist as a directory to be resolvable as a target.
  mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
  mkdirSync(accountDir(store, OLD_ACCOUNT), { recursive: true });
});

function sweep(dryRun = false, extra: Partial<SweepOptions> = {}) {
  return runSweep({
    store,
    ledger,
    target: NEW_ACCOUNT,
    dryRun,
    env,
    configDirs: [],
    // The transcript seam keeps unit tests out of the real ~/.claude, so the
    // tree this test wrote is named outright.
    projectsDirs: [path.join(configDir, 'projects')],
    ...extra,
  });
}

function copies(): CodeSessionData[] {
  return scanAccount(store, NEW_ACCOUNT)
    .filter((entry) => entry.isCopy)
    .map((entry) => entry.data);
}

/** A card in the destination, read back from disk. */
function card(id: string): CodeSessionData {
  const found = scanAccount(store, NEW_ACCOUNT).find(
    (entry) => entry.data.sessionId === `local_${id}`,
  );
  if (!found) throw new Error(`no card local_${id}`);
  return found.data;
}

/** The markers the app leaves behind on a deletion: one per id, holding the time. */
function tombstone(ids: string[], at = 1_700_000_500_000): void {
  for (const id of ids) {
    writeFileSync(path.join(accountDir(store, OLD_ACCOUNT), `deleted_${id}`), String(at), 'utf8');
  }
}

function transcript(cliSessionId: string, records: Record<string, unknown>[]): void {
  const dir = path.join(configDir, 'projects', 'C--work-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${cliSessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join('\n'),
    'utf8',
  );
}

describe('runSweep', () => {
  it('brings archived sessions across, and the copies stay archived', () => {
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: ARCHIVED, title: 'Tucked away', isArchived: true }),
    );
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORDINARY, title: 'In Recents' }));

    const report = sweep();

    expect(report.fostered.counts.fostered).toBe(2);
    // The number is its own field because the archived view is where they land
    // and Recents is where people look for them.
    expect(report.archived).toBe(1);

    const tucked = copies().find((data) => data.title?.includes('Tucked away'));
    expect(tucked).toBeDefined();
    expect(tucked!.isArchived).toBe(true);
  });

  it('brings back a conversation the app deleted', () => {
    tombstone([DELETED_SESSION, DELETED_CLI]);
    transcript(DELETED_CLI, [
      { type: 'ai-title', aiTitle: 'Refactor the parser', sessionId: DELETED_CLI },
      { type: 'user', cwd: '/work/project', timestamp: '2023-11-15T10:00:00.000Z' },
    ]);

    const report = sweep();

    expect(report.restored.counts.fostered).toBe(1);
    expect(copies().map((data) => data.cliSessionId)).toContain(DELETED_CLI);
  });

  it('confirms it is finished, so nobody has to re-run it to find out', () => {
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORDINARY, title: 'In Recents' }));
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: ARCHIVED, title: 'Tucked away', isArchived: true }),
    );
    tombstone([DELETED_SESSION, DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);

    const report = sweep();

    // Not "the scan found nothing": the origin sessions are still on disk and a
    // second scan still lists them. What has to be zero is what a second run
    // would write.
    expect(report.confirmation).toEqual({
      fosterable: 0,
      branches: 0,
      restorable: 0,
      exhausted: true,
    });
  });

  it('has nothing to confirm on a dry run, and says so by leaving it out', () => {
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORDINARY }));

    const report = sweep(true);

    expect(report.fostered.counts.fostered).toBe(1);
    expect(report.confirmation).toBeUndefined();
    expect(copies()).toHaveLength(0);
  });

  it('counts what will never come, by the reason it cannot', () => {
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d1', scheduledTaskId: 'task-1' }),
    );
    const neverOpened = session({ sessionId: '00000000-0000-4000-8000-0000000000d2' });
    delete neverOpened.lastFocusedAt;
    writeSession(store, OLD_ACCOUNT, neverOpened);
    writeSession(store, OLD_ACCOUNT, {
      ...session({ sessionId: '00000000-0000-4000-8000-0000000000d3' }),
      padding: 'x'.repeat(SESSION_FILE_MAX_BYTES),
    });
    // One that does come, so the count is about the gap rather than about the run.
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORDINARY }));

    const report = sweep();

    expect(report.fostered.counts.fostered).toBe(1);
    expect(report.neverComes.total).toBe(3);
    expect(report.neverComes.byReason).toMatchObject({
      'scheduled-task': 1,
      'never-opened': 1,
      'too-large': 1,
    });
    // Archived is not a gap: bringing those across is the point of the sweep.
    expect(report.neverComes.byReason.archived).toBeUndefined();
  });

  it('does not count an archived session as something that will never come', () => {
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ARCHIVED, isArchived: true }));

    expect(sweep().neverComes.total).toBe(0);
  });

  it('counts a session once even when more than one reason applies to it', () => {
    // A scheduled task that was never opened is the ordinary shape of one, and
    // counting both marks made the breakdown contradict its own total.
    const scheduled = session({
      sessionId: '00000000-0000-4000-8000-0000000000d4',
      scheduledTaskId: 'task-2',
    });
    delete scheduled.lastFocusedAt;
    writeSession(store, OLD_ACCOUNT, scheduled);

    const { neverComes } = sweep();
    const parts = Object.values(neverComes.byReason).reduce((sum, n) => sum + n, 0);

    expect(neverComes.total).toBe(1);
    expect(parts).toBe(neverComes.total);
    expect(neverComes.byReason).toMatchObject({ 'scheduled-task': 1 });
    expect(neverComes.byReason['never-opened']).toBeUndefined();
  });

  it('names what will never come, under the same reason it counted', () => {
    // The gap that made this necessary: a run said "2 never opened" and neither
    // title appeared anywhere, so the only way to find out which two was to read
    // the store by hand.
    const neverOpened = session({
      sessionId: '00000000-0000-4000-8000-0000000000d5',
      title: 'Guard for every versioned plist',
    });
    delete neverOpened.lastFocusedAt;
    writeSession(store, OLD_ACCOUNT, neverOpened);
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d6',
        scheduledTaskId: 'task-3',
        title: 'Nightly watchdog',
      }),
    );

    const { neverComes } = sweep();

    expect(neverComes.sessions).toHaveLength(neverComes.total);
    expect(neverComes.sessions).toContainEqual({
      title: 'Guard for every versioned plist',
      reason: 'never-opened',
    });
    expect(neverComes.sessions).toContainEqual({
      title: 'Nightly watchdog',
      reason: 'scheduled-task',
    });
    // The list and the breakdown are the same sessions counted twice, so they
    // cannot be allowed to disagree.
    const fromList: Record<string, number> = {};
    for (const one of neverComes.sessions) fromList[one.reason] = (fromList[one.reason] ?? 0) + 1;
    expect(fromList).toEqual(neverComes.byReason);
  });
});

/**
 * One conversation, forked: the row here is the branch that stopped, the branch
 * that carried on sits in another account. The sweep used to refuse the second
 * and report that nothing was left; now every branch gets a row, and the rows
 * say which one to open.
 */
const ROOT = '00000000-0000-4000-8000-0000000000b0';
const TRUNK = '00000000-0000-4000-8000-0000000000b1';
const TIP = '00000000-0000-4000-8000-0000000000b2';
const TRUNK_CARD = '00000000-0000-4000-8000-0000000000b3';
const TIP_CARD = '00000000-0000-4000-8000-0000000000b4';
const OTHER_CARD = '00000000-0000-4000-8000-0000000000b5';
const SHARED = '00000000-0000-4000-8000-0000000000b6';
const TRUNK_ANSWER = '00000000-0000-4000-8000-0000000000b7';
const TRUNK_CLICK = '00000000-0000-4000-8000-0000000000b8';
const TIP_ONLY = [
  '00000000-0000-4000-8000-0000000000b9',
  '00000000-0000-4000-8000-0000000000ba',
  '00000000-0000-4000-8000-0000000000bb',
];
const COPY_ID = '00000000-0000-4000-8000-0000000000bc';
const SECOND_CARD = '00000000-0000-4000-8000-0000000000bd';

/** The last answer on the branch that stopped, and the click that resumed it a day later. */
const LAST_ANSWER = '2026-09-01T21:10:00.000Z';
const LATER_CLICK = '2026-09-02T11:24:00.000Z';
const STAMP = formatStamp(Date.parse(LAST_ANSWER));

/** An answer on the trunk written after the tip's own last answer. */
const WENT_ON = '2026-09-02T12:00:00.000Z';
const WENT_ON_STAMP = formatStamp(Date.parse(WENT_ON));

function rec(uuid: string, type: 'user' | 'assistant', timestamp: string) {
  return { uuid, type, timestamp };
}

/**
 * The trunk holds the shared history, one answer of its own, and the user
 * record a click on the stale row appended a day later. The tip holds the same
 * history and three records of its own — the branch that carried on.
 */
function fork(): void {
  const meta = { type: 'custom-title', customTitle: 'Macs' };
  transcript(TRUNK, [
    meta,
    rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
    rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
    rec(TRUNK_ANSWER, 'assistant', LAST_ANSWER),
    rec(TRUNK_CLICK, 'user', LATER_CLICK),
  ]);
  transcript(TIP, [
    meta,
    rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
    rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
    rec(TIP_ONLY[0]!, 'user', '2026-09-02T10:00:00.000Z'),
    rec(TIP_ONLY[1]!, 'assistant', '2026-09-02T10:05:00.000Z'),
    rec(TIP_ONLY[2]!, 'assistant', '2026-09-02T11:14:00.000Z'),
  ]);
}

describe('one row per branch', () => {
  it('gives the branch that carried on a clean row, and marks the row here stale', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const report = sweep();

    // A fork member is never the ordinary pass's to copy: it would arrive with
    // a clean title and need rewriting.
    expect(report.fostered.counts.fostered).toBe(0);
    expect(report.branches.forks).toHaveLength(1);
    expect(report.branches.counts.fostered).toBe(1);

    const tip = copies().find((data) => data.cliSessionId === TIP);
    expect(tip).toMatchObject({ title: 'Macs', isArchived: false });

    // Stamped with the last answer, not with the click that resumed it: the
    // click is the newer record, and stamping it would call the stale row the
    // newest thing here.
    expect(card(TRUNK_CARD)).toMatchObject({
      title: `(stale, stopped ${STAMP}) Macs`,
      isArchived: true,
    });

    const events = ledger.read();
    expect(events.find((event) => event.kind === 'fostered')).toMatchObject({
      prefix: '',
      originalTitle: 'Macs',
    });
    expect(events.find((event) => event.kind === 'card_retitled')).toMatchObject({
      from: 'Macs',
      to: `(stale, stopped ${STAMP}) Macs`,
      fromArchived: false,
      toArchived: true,
      native: true,
      as: 'stale',
    });
  });

  it('brings the branch that stopped as a marked, archived row, from its most recent card', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: TRUNK_CARD,
        cliSessionId: TRUNK,
        title: 'Macs',
        lastActivityAt: 1_700_000_100_000,
      }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: OTHER_CARD,
        cliSessionId: TRUNK,
        title: 'Macs again',
        lastActivityAt: 1_700_000_900_000,
      }),
    );

    const report = sweep();

    // One row for the branch, not one per card that holds it.
    expect(report.branches.counts.fostered).toBe(1);
    expect(copies()).toHaveLength(1);
    expect(copies()[0]).toMatchObject({
      cliSessionId: TRUNK,
      title: `(stale, stopped ${STAMP}) Macs again`,
      isArchived: true,
    });
    expect(report.branches.archived).toBe(1);
    expect(report.archived).toBe(1);

    const fostered = ledger.read().find((event) => event.kind === 'fostered');
    expect(fostered).toMatchObject({
      originSessionId: `local_${OTHER_CARD}`,
      originalTitle: 'Macs again',
      prefix: `(stale, stopped ${STAMP}) `,
      archived: true,
    });
    // The row here is the branch that carried on, and is left exactly as it is.
    expect(card(TIP_CARD).title).toBe('Macs');
    expect(ledger.read().filter((event) => event.kind === 'card_retitled')).toHaveLength(0);
  });

  it('takes the mark off a row whose branch carried on, and lifts a flag foster set', () => {
    fork();
    const marked = '(stale, stopped 01/09 18:10) Macs';
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: marked, isArchived: true }),
    );
    ledger.append({
      kind: 'card_retitled',
      sessionId: `local_${TIP_CARD}`,
      target: NEW_ACCOUNT,
      path: file,
      from: 'Macs',
      to: marked,
      fromArchived: false,
      toArchived: true,
      native: true,
      as: 'stale',
    });
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );

    sweep();

    expect(card(TIP_CARD)).toMatchObject({ title: 'Macs', isArchived: false });
    expect(ledger.read().at(-1)).toMatchObject({
      kind: 'card_retitled',
      as: 'tip',
      to: 'Macs',
      toArchived: false,
    });
    // Back to what the app had, so the fold no longer lists it.
    expect(listRetitled(project(ledger.read()))).toHaveLength(0);
  });

  it('leaves a flag the user set alone, even on the branch that carried on', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs', isArchived: true }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );

    sweep();

    expect(card(TIP_CARD)).toMatchObject({ title: 'Macs', isArchived: true });
  });

  it('does not bring back a copy of a branch the user deleted in the app', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );
    const copyPath = path.join(accountDir(store, NEW_ACCOUNT), `local_${COPY_ID}.json`);
    ledger.append({
      kind: 'fostered',
      originSessionId: `local_${TIP_CARD}`,
      origin: OLD_ACCOUNT,
      target: NEW_ACCOUNT,
      copySessionId: `local_${COPY_ID}`,
      copyPath,
      cliSessionId: TIP,
      prefix: '',
    });
    writeFileSync(
      path.join(accountDir(store, NEW_ACCOUNT), `deleted_${COPY_ID}`),
      '1700000500000',
      'utf8',
    );

    const report = sweep();

    expect(report.branches.counts.fostered).toBe(0);
    expect(report.branches.outcomes[0]).toMatchObject({ status: 'skipped' });
    expect(report.branches.outcomes[0]!.detail).toMatch(/deleted in the app/);
    expect(copies()).toHaveLength(0);
  });

  it('settles: a second run adds nothing, marks nothing, and says so', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const first = sweep();
    expect(first.confirmation).toEqual({
      fosterable: 0,
      branches: 0,
      restorable: 0,
      exhausted: true,
    });

    const second = sweep();
    expect(second.branches.counts.fostered).toBe(0);
    expect(second.branches.retitled.filter((o) => o.status === 'retitled')).toHaveLength(0);
    expect(ledger.read().filter((event) => event.kind === 'card_retitled')).toHaveLength(1);
  });

  it('plans the same rows on a dry run, and writes none of them', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const report = sweep(true);

    expect(report.branches.counts.fostered).toBe(1);
    expect(report.branches.retitled).toHaveLength(1);
    expect(report.branches.retitled[0]).toMatchObject({ status: 'retitled', as: 'stale' });
    expect(copies()).toHaveLength(0);
    expect(card(TRUNK_CARD)).toMatchObject({ title: 'Macs', isArchived: false });
    expect(ledger.read()).toHaveLength(0);
  });

  it('gives a deleted branch that carried on its row back, through the branch pass', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    // The tip has no card anywhere: the app deleted it and left the transcript.
    tombstone([TIP]);

    const report = sweep();

    expect(report.restored.counts.fostered).toBe(0);
    expect(report.branches.counts.fostered).toBe(1);
    expect(copies().find((data) => data.cliSessionId === TIP)).toMatchObject({
      title: '(recovered conversation)',
      isArchived: false,
    });
    expect(card(TRUNK_CARD).title).toBe(`(stale, stopped ${STAMP}) Macs`);
  });

  it('marks every row the app made for a stale branch, and removes none of them', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: SECOND_CARD, cliSessionId: TRUNK, title: 'Macs (again)' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const report = sweep();

    expect(report.branches.retitled.filter((o) => o.status === 'retitled')).toHaveLength(2);
    expect(card(TRUNK_CARD).title).toBe(`(stale, stopped ${STAMP}) Macs`);
    expect(card(SECOND_CARD).title).toBe(`(stale, stopped ${STAMP}) Macs (again)`);
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(3);
  });

  it('brings the branch that carried on even while something is writing it, and says so', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const report = sweep(false, { live: new Set([TIP.toLowerCase()]) });

    expect(report.branches.counts.fostered).toBe(1);
    expect(report.liveWriters).toEqual([TIP]);
  });

  it('leaves a stale row alone while something is still writing its branch', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const report = sweep(false, { live: new Set([TRUNK.toLowerCase()]) });

    expect(card(TRUNK_CARD).title).toBe('Macs');
    expect(report.branches.forks[0]!.skipped).toHaveLength(1);
    expect(report.branches.forks[0]!.skipped[0]!.detail).toMatch(/live claude/);
  });

  it('marks in whatever words the caller chose', () => {
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    sweep(false, { staleTemplate: '(defasada, parou {when}) ' });

    expect(card(TRUNK_CARD).title).toBe(`(defasada, parou ${STAMP}) Macs`);
  });
});

/**
 * The one hazard the sweep has to ask about before acting: a Code session opened
 * from the app's sidebar is a child of the app, so restarting it kills the
 * caller mid-run. `quitDesktop` already refuses; the sweep asks first so it can
 * end with the command to run somewhere else instead of a thrown error after
 * writing everything.
 */
describe('restartPlan', () => {
  // Under \Packages\Claude..., like the app's own MSIX package directory: proof
  // enough on its own that a row is the app (isDesktopProcess now requires it).
  const DESKTOP =
    'C:\\home\\AppData\\Local\\Packages\\Claude_0.0.0.0_x64__test\\LocalCache\\Roaming\\Claude\\app\\Claude.exe';
  const CLI = 'C:\\home\\AppData\\Roaming\\Claude\\claude-code\\1.0.0\\claude.exe';

  function table(root: string, entries: Partial<ProcessRow>[]): ProcessRow[] {
    return entries.map((entry, index) => ({
      pid: 500 + index,
      parentPid: 9,
      name: 'claude.exe',
      path: DESKTOP,
      commandLine: `"${DESKTOP}" --user-data-dir="${root}"`,
      ...entry,
    }));
  }

  it('refuses when foster is running inside the app it would restart', () => {
    const rows = table(store.root, [
      { pid: 500 },
      { pid: 501, parentPid: 500, path: CLI },
      { pid: process.pid, parentPid: 501, name: 'node.exe', path: 'C:\\node.exe' },
    ]);

    const plan = restartPlan(store, env, () => rows);

    expect(plan.possible).toBe(false);
    expect(plan.running).toBe(true);
    expect(plan.reason).toMatch(/running inside Claude Desktop/);
    // The point of asking: the run ends with something to paste elsewhere.
    expect(plan.command).toBe('foster app restart');
  });

  it('allows it when the app did not start this process', () => {
    const rows = table(store.root, [
      { pid: 500 },
      { pid: process.pid, parentPid: 41_000, name: 'node.exe', path: 'C:\\node.exe' },
    ]);

    expect(restartPlan(store, env, () => rows)).toMatchObject({ possible: true, running: true });
  });

  it('allows it when the app is not running at all', () => {
    expect(restartPlan(store, env, () => [])).toMatchObject({ possible: true, running: false });
  });

  it('hands over the command rather than restart on an uncertain table', () => {
    // A partial table (tasklist) with a claude.exe on it is neither a clean
    // "running" nor a clean "not running" — restarting on that evidence risks
    // starting a second instance on top of one that may already be up.
    const rows: ProcessRow[] = [
      { pid: 4242, parentPid: 0, name: 'claude.exe', path: '', commandLine: '', partial: true },
    ];

    const plan = restartPlan(store, env, () => rows);
    expect(plan.possible).toBe(false);
    expect(plan.reason).toMatch(/tasklist/);
    expect(plan.command).toBe('foster app restart');
  });
});

/**
 * The agent could not answer "bring everything, deleted ones included" at all:
 * `restore` was never one of its tools. What matters as much is that the new one
 * sits behind the same switch as every other mutation.
 */
describe('sweep_everything', () => {
  it('is a dry run when the user did not start the agent with --yes', () => {
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORDINARY }));

    const result = sweepEverything({ store, ledger, allowWrites: false, env }, { apply: true }) as {
      dryRun: boolean;
      note?: string;
    };

    expect(result.dryRun).toBe(true);
    expect(result.note).toBe(WRITES_DISABLED);
    expect(copies()).toHaveLength(0);
  });

  it('writes when the user allowed it and the model asked to apply', () => {
    writeSession(store, OLD_ACCOUNT, session({ sessionId: ORDINARY }));

    const result = sweepEverything(
      { store, ledger, allowWrites: true, env, processes: () => [] },
      { apply: true },
    ) as {
      dryRun: boolean;
      counts: Record<string, number>;
      restart: { command: string };
    };

    expect(result.dryRun).toBe(false);
    expect(result.counts.fostered).toBe(1);
    expect(result.restart.command).toBe('foster app restart');
    expect(copies()).toHaveLength(1);
  });
});

/**
 * A branch every record of which the branch that carried on also holds — the
 * shape a copy has when it was opened once and never written to again.
 */
/**
 * A fork whose halves both hold work of their own, and the half that is not the
 * tip is the one that answered last.
 *
 * Measured on a real store: of 209 forked conversations, 111 looked like this.
 * Ranking by weight alone called the fresher half "stale, stopped ..." and
 * filed it in the archived view, sending the reader to the half they had left
 * hours earlier. The tip is still the half holding most work of its own — that
 * measure is not the bug; calling the other half stopped was.
 */
function wentOn(): void {
  const meta = { type: 'custom-title', customTitle: 'Macs' };
  transcript(TRUNK, [
    meta,
    rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
    rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
    rec(TRUNK_ANSWER, 'assistant', WENT_ON),
  ]);
  transcript(TIP, [
    meta,
    rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
    rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
    rec(TIP_ONLY[0]!, 'user', '2026-09-02T10:00:00.000Z'),
    rec(TIP_ONLY[1]!, 'assistant', '2026-09-02T10:05:00.000Z'),
    rec(TIP_ONLY[2]!, 'assistant', '2026-09-02T11:14:00.000Z'),
  ]);
}

describe('a branch that went on after the tip', () => {
  it('is not called stale, and is not filed away', () => {
    wentOn();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    const report = sweep();

    expect(card(TRUNK_CARD)).toMatchObject({
      title: `(other branch, went on ${WENT_ON_STAMP}) Macs`,
      isArchived: false,
    });
    expect(report.branches.retitled[0]).toMatchObject({ status: 'retitled', as: 'diverged' });
    const rows = report.branches.forks[0]!.rows;
    expect(rows.find((row) => row.cliSessionId === TRUNK)!.kind).toBe('diverged');
    expect(rows.find((row) => row.cliSessionId === TIP)!.kind).toBe('tip');
  });

  it('comes back out of the archived view when an earlier sweep filed it', () => {
    wentOn();
    const marked = '(stale, stopped 01/09 18:10) Macs';
    const file = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: marked, isArchived: true }),
    );
    ledger.append({
      kind: 'card_retitled',
      sessionId: `local_${TRUNK_CARD}`,
      target: NEW_ACCOUNT,
      path: file,
      from: 'Macs',
      to: marked,
      fromArchived: false,
      toArchived: true,
      native: true,
      as: 'stale',
    });
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    sweep();

    // The old mark goes with the old verdict: one mark at a time, never stacked.
    expect(card(TRUNK_CARD)).toMatchObject({
      title: `(other branch, went on ${WENT_ON_STAMP}) Macs`,
      isArchived: false,
    });
  });

  it('arrives unarchived when it is only in another account', () => {
    wentOn();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    sweep();

    expect(copies().find((data) => data.cliSessionId === TRUNK)).toMatchObject({
      title: `(other branch, went on ${WENT_ON_STAMP}) Macs`,
      isArchived: false,
    });
  });

  it('marks in whatever words the caller chose', () => {
    wentOn();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    sweep(false, { divergedTemplate: '(outro ramo, seguiu {when}) ' });

    expect(card(TRUNK_CARD).title).toBe(`(outro ramo, seguiu ${WENT_ON_STAMP}) Macs`);
  });

  it('is still stale when its own last answer is older, whatever the last click says', () => {
    // The trunk holds work of its own, but the tip answered after it; the later
    // user record on the trunk is a click on the row, not the work going on.
    fork();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TRUNK_CARD, cliSessionId: TRUNK, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    sweep();

    expect(card(TRUNK_CARD)).toMatchObject({
      title: `(stale, stopped ${STAMP}) Macs`,
      isArchived: true,
    });
  });
});

describe('a branch with nothing of its own', () => {
  const CONTAINED = '00000000-0000-4000-8000-0000000000be';
  const CONTAINED_CARD = '00000000-0000-4000-8000-0000000000bf';

  function contained(): void {
    fork();
    transcript(CONTAINED, [
      rec(ROOT, 'user', '2026-09-01T20:00:00.000Z'),
      rec(SHARED, 'assistant', '2026-09-01T20:01:00.000Z'),
    ]);
  }

  it('gets no row of its own: it would open nothing the clean row does not', () => {
    contained();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: CONTAINED_CARD, cliSessionId: CONTAINED, title: 'Macs' }),
    );

    const report = sweep();

    expect(report.branches.counts.fostered).toBe(0);
    expect(copies()).toHaveLength(0);
    const row = report.branches.forks[0]!.rows.find((entry) => entry.cliSessionId === CONTAINED);
    expect(row).toMatchObject({ only: 0, held: 0, action: 'none' });
  });

  it('is still marked stale when a row for it is already here', () => {
    contained();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: CONTAINED_CARD, cliSessionId: CONTAINED, title: 'Macs' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: TIP_CARD, cliSessionId: TIP, title: 'Macs' }),
    );

    sweep();

    expect(card(CONTAINED_CARD).title).toMatch(/^\(stale, stopped .*\) Macs$/);
    expect(card(CONTAINED_CARD).isArchived).toBe(true);
  });
});
