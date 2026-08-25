import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import type { CodeSessionData, StoreLayout } from '../src/domain/types.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import { Ledger } from '../src/ledger/log.js';
import { restartPlan, runSweep } from '../src/ops/sweep.js';
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

function sweep(dryRun = false) {
  return runSweep({ store, ledger, target: NEW_ACCOUNT, dryRun, env, configDirs: [] });
}

function copies(): CodeSessionData[] {
  return scanAccount(store, NEW_ACCOUNT)
    .filter((entry) => entry.isCopy)
    .map((entry) => entry.data);
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
    expect(report.confirmation).toEqual({ fosterable: 0, restorable: 0, exhausted: true });
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
});

/**
 * The one hazard the sweep has to ask about before acting: a Code session opened
 * from the app's sidebar is a child of the app, so restarting it kills the
 * caller mid-run. `quitDesktop` already refuses; the sweep asks first so it can
 * end with the command to run somewhere else instead of a thrown error after
 * writing everything.
 */
describe('restartPlan', () => {
  const DESKTOP = 'C:\\Program Files\\WindowsApps\\Claude_0.0.0.0_x64__test\\app\\Claude.exe';
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
