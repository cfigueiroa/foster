import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDuplicates } from '../src/engine/duplicates.js';
import { fosterSessions } from '../src/engine/executor.js';
import { lineage } from '../src/engine/lineage.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { conversationRoot } from '../src/store/transcripts.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * A branch is one piece of work wearing two identifiers.
 *
 * The app forks a conversation it cannot continue — something else is writing it —
 * by copying the history into a new transcript and moving the card onto that. The
 * check that keeps one sidebar from showing one conversation twice compares
 * `cliSessionId`, which is precisely the field the fork changes, so the pair walks
 * straight past it. These are the tests for recognising the two halves.
 */

const ROOT = '00000000-0000-4000-8000-0000000000e0';
const ORIGINAL = '00000000-0000-4000-8000-0000000000e1';
const BRANCH = '00000000-0000-4000-8000-0000000000e2';
const UNRELATED = '00000000-0000-4000-8000-0000000000e3';

/** A config directory with transcripts in it, as CLAUDE_CONFIG_DIR points at. */
function transcripts(files: Record<string, string[]>): NodeJS.ProcessEnv {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-lin-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  for (const [id, records] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${id}.jsonl`), `${records.join('\n')}\n`, 'utf8');
  }
  return { CLAUDE_CONFIG_DIR: config };
}

/** The app's own bookkeeping, which carries no uuid and is rewritten on every save. */
const META = JSON.stringify({ type: 'custom-title', customTitle: '↪ Work' });

function record(uuid: string): string {
  return JSON.stringify({ uuid, type: 'user', timestamp: '2026-08-06T05:12:01.370Z' });
}

/** One conversation and the branch the app forked out of it. */
function forked(): NodeJS.ProcessEnv {
  return transcripts({
    [ORIGINAL]: [META, record(ROOT), record('00000000-0000-4000-8000-0000000000e4')],
    [BRANCH]: [META, record(ROOT), record('00000000-0000-4000-8000-0000000000e5')],
    [UNRELATED]: [META, record('00000000-0000-4000-8000-0000000000e6')],
  });
}

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-lin-l-')), 'l.jsonl'));
}

/** The destination already holds the original; the branch waits in the old account. */
function branchWaiting(): { store: StoreLayout; ledger: Ledger } {
  const store = makeStore();
  writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000e7', cliSessionId: ORIGINAL }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000e8', cliSessionId: BRANCH }),
  );
  return { store, ledger: ledgerIn() };
}

describe('conversationRoot', () => {
  it('is the first record carrying a uuid, not the first line', () => {
    const env = forked();
    const file = path.join(env.CLAUDE_CONFIG_DIR!, 'projects', '-workspace-project');
    expect(conversationRoot(path.join(file, `${ORIGINAL}.jsonl`))).toBe(ROOT);
  });

  it('is shared by a conversation and the branch forked out of it', () => {
    const kin = lineage(forked());
    expect(kin.sameWork(ORIGINAL, BRANCH)).toBe(true);
    expect(kin.sameWork(ORIGINAL, UNRELATED)).toBe(false);
  });

  it('answers nothing for a conversation with no transcript on disk', () => {
    const kin = lineage(forked());
    expect(kin.rootOf('00000000-0000-4000-8000-0000000000e9')).toBeUndefined();
    // Unanswerable is not "the same": a missing transcript must not make two
    // unrelated conversations collide on undefined.
    expect(kin.sameWork('00000000-0000-4000-8000-0000000000e9', ORIGINAL)).toBe(false);
  });
});

describe('fostering a branch', () => {
  it('refuses a second row for work the account already shows', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      env: forked(),
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.detail).toBe('this account already has a branch of that conversation');
  });

  it('still allows it when the session was named one by one', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      env: forked(),
      explicit: true,
    });

    expect(outcomes[0]!.status).toBe('fostered');
  });

  it('does not refuse a conversation that merely has no transcript', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ea', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000eb',
        cliSessionId: '00000000-0000-4000-8000-0000000000ec',
      }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      env: forked(),
    });

    expect(outcomes[0]!.status).toBe('fostered');
  });

  it('brings one row when a sweep finds both halves at once', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ed', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ee', cliSessionId: BRANCH }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      env: forked(),
    });

    expect(outcomes.filter((o) => o.status === 'fostered')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1);
  });

  it('makes the same marks on a dry run as on a real one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ef', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f0', cliSessionId: BRANCH }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      env: forked(),
      dryRun: true,
    });

    expect(outcomes.filter((o) => o.status === 'fostered')).toHaveLength(1);
  });
});

describe('findDuplicates', () => {
  it('reports a branch pair apart from an exact one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d1', cliSessionId: BRANCH }),
    );
    const ledger = ledgerIn();
    // Fostered while the destination had nothing, which is how the pairs already
    // on disk were made: the other half arrived afterwards.
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      env: forked(),
    });
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d2', cliSessionId: ORIGINAL }),
    );

    const report = findDuplicates(store, listActive(project(ledger.read())), forked());
    expect(report.branches).toHaveLength(1);
    expect(report.copies).toHaveLength(0);
    expect(report.appMade).toBe(0);
  });

  it('keeps one row when both halves are copies, and it is the live one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d5', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d6', cliSessionId: BRANCH }),
    );
    const ledger = ledgerIn();
    const env = forked();
    // Fostered one at a time, as two accounts' sweeps would have done it before
    // the refusal existed: neither run could see the other half arriving.
    for (const card of scanAccount(store, OLD_ACCOUNT)) {
      fosterSessions([card], { store, ledger, target: NEW_ACCOUNT, env, explicit: true });
    }
    const branchFile = path.join(
      env.CLAUDE_CONFIG_DIR!,
      'projects',
      '-workspace-project',
      `${BRANCH}.jsonl`,
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(branchFile, later, later);

    const active = listActive(project(ledger.read()));
    const report = findDuplicates(store, active, env);

    // Both are copies and each is a branch of the other. Reporting both would be
    // true of each and ruinous together: --branches would take the work out of
    // the sidebar altogether.
    expect(report.branches).toHaveLength(1);
    const removed = new Set(report.branches.map((f) => f.copySessionId));
    const kept = active.filter((f) => !removed.has(f.copySessionId));
    expect(kept).toHaveLength(1);
    // And the survivor is the branch that carried on, not whichever came first.
    expect(kept[0]!.cliSessionId).toBe(BRANCH);
  });

  it('leaves an unrelated conversation alone', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d3', cliSessionId: UNRELATED }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      env: forked(),
    });
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d4', cliSessionId: ORIGINAL }),
    );

    const report = findDuplicates(store, listActive(project(ledger.read())), forked());
    expect(report.branches).toHaveLength(0);
    expect(report.copies).toHaveLength(0);
  });
});
