import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsAtomic from '../src/util/fsatomic.js';
import { Ledger } from '../src/ledger/log.js';
import { isFostered, project } from '../src/ledger/project.js';
import { scanAccount } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/** Flipped per test to make the next write fail, without touching the real implementation. */
let failNextWrite = false;

vi.mock('../src/util/fsatomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FsAtomic>();
  return {
    ...actual,
    writeFileAtomic: (target: string, contents: string) => {
      if (failNextWrite) throw new Error('simulated disk failure');
      return actual.writeFileAtomic(target, contents);
    },
  };
});

const { fosterSessions } = await import('../src/engine/executor.js');

beforeEach(() => {
  failNextWrite = false;
});

describe('a foster whose write fails', () => {
  it('records nothing active, so a later run retries instead of skipping forever', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-fw-')), 'l.jsonl'));
    writeSession(store, OLD_ACCOUNT, session());
    const sessions = scanAccount(store, OLD_ACCOUNT);
    const opts = { store, ledger, target: NEW_ACCOUNT, guard: () => {} };

    failNextWrite = true;
    const [failed] = fosterSessions(sessions, opts);

    expect(failed!.status).toBe('failed');
    // The bug this guards against: logging intent before the write left a
    // "fostered" event that the fold still counted as active, so every retry
    // skipped the session as already fostered while no copy existed on disk.
    expect(isFostered(project(ledger.read()), sessions[0]!.data.sessionId, NEW_ACCOUNT)).toBe(
      false,
    );
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(0);

    failNextWrite = false;
    const [retried] = fosterSessions(scanAccount(store, OLD_ACCOUNT), opts);

    expect(retried!.status).toBe('fostered');
    expect(existsSync(retried!.copyPath!)).toBe(true);
  });
});
