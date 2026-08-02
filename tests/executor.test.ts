import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../src/engine/executor.js';
import { removeSafely } from '../src/engine/fsatomic.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { scanAccount } from '../src/store/scanner.js';
import type { CodeSessionData, StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

let store: StoreLayout;
let ledger: Ledger;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-led-')), 'ledger.jsonl'));
});

function seed(overrides: Partial<CodeSessionData> = {}) {
  writeSession(store, OLD_ACCOUNT, session(overrides));
  return scanAccount(store, OLD_ACCOUNT);
}

/** Tests drive a synthetic store, so the real removal gate is not the thing under test. */
const noGuard = () => {};
const opts = () => ({ store, ledger, target: NEW_ACCOUNT });

describe('fosterSessions', () => {
  it('writes a copy into the target account and leaves the original untouched', () => {
    const sessions = seed({ title: 'Refactor parser' });
    const originalBytes = readFileSync(sessions[0]!.path);

    const [outcome] = fosterSessions(sessions, opts());

    expect(outcome!.status).toBe('fostered');
    expect(existsSync(outcome!.copyPath!)).toBe(true);
    expect(readFileSync(sessions[0]!.path)).toEqual(originalBytes);
  });

  it('gives the copy a fresh id while keeping the transcript pointer', () => {
    const sessions = seed();
    const [outcome] = fosterSessions(sessions, opts());
    const copy = JSON.parse(readFileSync(outcome!.copyPath!, 'utf8')) as CodeSessionData;

    expect(copy.sessionId).not.toBe(sessions[0]!.data.sessionId);
    expect(copy.cliSessionId).toBe(sessions[0]!.data.cliSessionId);
  });

  it('strips an inherited error so the session does not show a stale warning', () => {
    const sessions = seed({ error: 'weekly limit reached', errorAt: 1_700_000_400_000 });
    const [outcome] = fosterSessions(sessions, opts());
    const copy = JSON.parse(readFileSync(outcome!.copyPath!, 'utf8')) as CodeSessionData;

    expect(copy.error).toBeUndefined();
    expect(copy.errorAt).toBeUndefined();
  });

  it('is idempotent — re-running does not mint a second copy', () => {
    const sessions = seed();
    fosterSessions(sessions, opts());
    const second = fosterSessions(sessions, opts());

    expect(second[0]!.status).toBe('skipped');
    expect(second[0]!.detail).toBe('already fostered');
    expect(listActive(project(ledger.read()))).toHaveLength(1);
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(1);
  });

  it('skips sessions that would never appear in the sidebar', () => {
    const scheduled = session({
      sessionId: '00000000-0000-4000-8000-00000000005a',
      scheduledTaskId: 'nightly',
    });
    writeSession(store, OLD_ACCOUNT, scheduled);

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), opts());
    const skipped = outcomes.find((o) => o.originSessionId === scheduled.sessionId);

    expect(skipped!.status).toBe('skipped');
    expect(skipped!.detail).toContain('scheduled-task');
  });

  it('writes nothing on a dry run', () => {
    const sessions = seed();
    const [outcome] = fosterSessions(sessions, { ...opts(), dryRun: true });

    expect(outcome!.status).toBe('fostered');
    expect(existsSync(outcome!.copyPath!)).toBe(false);
    expect(ledger.read()).toHaveLength(0);
  });

  it('reports per session, so one failure does not abort the batch', () => {
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-00000000006a' }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-00000000006b', scheduledTaskId: 'nightly' }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), opts());

    expect(summariseOutcomes(outcomes)).toMatchObject({ fostered: 1, skipped: 1, failed: 0 });
  });
});

describe('returnFosterings', () => {
  it('removes the copy and clears it from active state', () => {
    const sessions = seed();
    const [fosterOutcome] = fosterSessions(sessions, opts());
    const active = listActive(project(ledger.read()));

    const [returned] = returnFosterings(active, { store, ledger, guard: noGuard });

    expect(returned!.status).toBe('returned');
    expect(existsSync(fosterOutcome!.copyPath!)).toBe(false);
    expect(listActive(project(ledger.read()))).toHaveLength(0);
  });

  it('leaves the origin account exactly as it was', () => {
    const sessions = seed();
    const originalBytes = readFileSync(sessions[0]!.path);
    fosterSessions(sessions, opts());
    returnFosterings(listActive(project(ledger.read())), { store, ledger, guard: noGuard });

    expect(readFileSync(sessions[0]!.path)).toEqual(originalBytes);
    expect(scanAccount(store, OLD_ACCOUNT)).toHaveLength(1);
  });

  it('treats an already-deleted copy as success', () => {
    const sessions = seed();
    fosterSessions(sessions, opts());
    const active = listActive(project(ledger.read()));
    // Simulate the user deleting it in the app instead.
    removeSafely(active[0]!.copyPath);

    const [returned] = returnFosterings(active, { store, ledger, guard: noGuard });

    expect(returned!.status).toBe('returned');
  });

  it('can re-foster after a return', () => {
    const sessions = seed();
    fosterSessions(sessions, opts());
    returnFosterings(listActive(project(ledger.read())), { store, ledger, guard: noGuard });

    const again = fosterSessions(scanAccount(store, OLD_ACCOUNT), opts());

    expect(again[0]!.status).toBe('fostered');
  });

  it('refuses when the gate objects, and removes nothing', () => {
    const sessions = seed();
    const [fostered] = fosterSessions(sessions, opts());
    const active = listActive(project(ledger.read()));
    const refuse = () => {
      throw new Error('Claude Desktop is running');
    };

    expect(() => returnFosterings(active, { store, ledger, guard: refuse })).toThrow(/running/);
    expect(existsSync(fostered!.copyPath!)).toBe(true);
  });

  it('does not consult the gate for a dry run', () => {
    const sessions = seed();
    fosterSessions(sessions, opts());
    const refuse = () => {
      throw new Error('should not be called');
    };

    expect(() =>
      returnFosterings(listActive(project(ledger.read())), {
        store,
        ledger,
        guard: refuse,
        dryRun: true,
      }),
    ).not.toThrow();
  });
});
