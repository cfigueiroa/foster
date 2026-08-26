import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRestoredSession, unfosterableReasons } from '../src/domain/fostering.js';
import { accountDir } from '../src/domain/paths.js';
import type { StoreLayout } from '../src/domain/types.js';
import { fosterSessions } from '../src/engine/executor.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { findRestorable } from '../src/store/restore.js';
import { scanAccount } from '../src/store/scanner.js';
import { scanTombstones } from '../src/store/tombstones.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

const DELETED_CLI = '00000000-0000-4000-8000-0000000000c1';
const DELETED_SESSION = '00000000-0000-4000-8000-0000000000c2';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let env: NodeJS.ProcessEnv;

/** Writes the markers the app leaves behind: one per id, holding the time. */
function tombstone(ids: string[], at = 1_700_000_500_000) {
  const dir = accountDir(store, OLD_ACCOUNT);
  mkdirSync(dir, { recursive: true });
  for (const id of ids) writeFileSync(path.join(dir, `deleted_${id}`), String(at), 'utf8');
}

function transcript(cliSessionId: string, records: Record<string, unknown>[]) {
  const dir = path.join(configDir, 'projects', 'C--work-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${cliSessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n'),
    'utf8',
  );
}

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-res-')), 'l.jsonl'));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-cfg-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
  // The account directory has to exist for the tombstones to be found in it.
  mkdirSync(accountDir(store, OLD_ACCOUNT), { recursive: true });
});

describe('buildRestoredSession', () => {
  it('is fosterable — in particular, not "never opened"', () => {
    // Without lastFocusedAt the app files it outside Recents, so the restore
    // would write a correct file that never appears.
    const data = buildRestoredSession({ cliSessionId: DELETED_CLI, lastActivityAt: 5 });
    expect(data.lastFocusedAt).toBe(5);
    expect(unfosterableReasons(data)).toEqual([]);
  });

  it('keeps the conversation pointer and takes its identity from it', () => {
    const data = buildRestoredSession({ cliSessionId: DELETED_CLI });
    expect(data.cliSessionId).toBe(DELETED_CLI);
    expect(data.sessionId).toBe(`local_${DELETED_CLI}`);
  });

  it('says what it is when the conversation never got a title', () => {
    expect(buildRestoredSession({ cliSessionId: DELETED_CLI }).title).toBe(
      '(recovered conversation)',
    );
  });
});

describe('findRestorable', () => {
  it('recovers the title, directory and dates from the transcript', () => {
    tombstone([DELETED_SESSION, DELETED_CLI]);
    transcript(DELETED_CLI, [
      { type: 'ai-title', aiTitle: 'Refactor the parser', sessionId: DELETED_CLI },
      { type: 'user', cwd: '/work/project', timestamp: '2023-11-15T10:00:00.000Z' },
    ]);

    const [found] = findRestorable(store, env);

    expect(found!.facts.title).toBe('Refactor the parser');
    expect(found!.session.data.cwd).toBe('/work/project');
    expect(found!.session.data.createdAt).toBe(Date.parse('2023-11-15T10:00:00.000Z'));
    expect(found!.session.account).toEqual(OLD_ACCOUNT);
  });

  it('ignores the markers left for identifiers that are not conversations', () => {
    // Deleting writes one marker per id the session carried; only one of them
    // has a transcript behind it.
    tombstone([DELETED_SESSION, DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);

    expect(findRestorable(store, env)).toHaveLength(1);
  });

  it('offers nothing when the conversation is gone too', () => {
    tombstone([DELETED_SESSION, DELETED_CLI]);
    expect(findRestorable(store, env)).toEqual([]);
  });

  it('skips a conversation a live session still points at', () => {
    // Tombstoned in one place, still referenced from another: not lost, and
    // restoring it would only duplicate it.
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);
    writeSession(store, NEW_ACCOUNT, session({ cliSessionId: DELETED_CLI }));

    expect(findRestorable(store, env)).toEqual([]);
  });

  it('skips a conversation a Cowork card still points at', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);
    const dir = path.join(
      store.agentSessionsDir,
      NEW_ACCOUNT.accountUuid,
      NEW_ACCOUNT.organizationUuid,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `local_${DELETED_CLI}.json`),
      JSON.stringify({ sessionId: `local_${DELETED_CLI}`, cliSessionId: DELETED_CLI }),
      'utf8',
    );

    expect(findRestorable(store, env)).toEqual([]);
  });

  it('reads the deletion time from the marker', () => {
    tombstone([DELETED_CLI], 1_699_999_000_000);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);

    expect(findRestorable(store, env)[0]!.tombstone.deletedAt).toBe(1_699_999_000_000);
  });
});

describe('restoring end to end', () => {
  it('writes a session that opens the deleted conversation', () => {
    tombstone([DELETED_SESSION, DELETED_CLI]);
    transcript(DELETED_CLI, [
      { type: 'ai-title', aiTitle: 'Refactor the parser', sessionId: DELETED_CLI },
      { type: 'user', cwd: '/work/project', timestamp: '2023-11-15T10:00:00.000Z' },
    ]);

    const outcomes = fosterSessions(
      findRestorable(store, env).map((entry) => entry.session),
      { store, ledger, target: NEW_ACCOUNT },
    );

    expect(outcomes[0]!.status).toBe('fostered');
    const [written] = scanAccount(store, NEW_ACCOUNT);
    expect(written!.data.cliSessionId).toBe(DELETED_CLI);
    // What this line is for is the title coming back from the transcript's own
    // ai-title record rather than being invented; copies carry no marker now.
    expect(written!.data.title).toBe('Refactor the parser');
    // A fresh identity, like every other copy foster writes.
    expect(written!.data.sessionId).not.toBe(`local_${DELETED_CLI}`);
  });

  it('is undoable like any other copy, and leaves the marker alone', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);

    fosterSessions(
      findRestorable(store, env).map((entry) => entry.session),
      { store, ledger, target: NEW_ACCOUNT },
    );

    expect(listActive(project(ledger.read()))).toHaveLength(1);
    // The app's marker is its record, not foster's to remove.
    expect(scanTombstones(store, OLD_ACCOUNT)).toHaveLength(1);
  });

  it('does not restore the same conversation twice', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);

    const once = findRestorable(store, env).map((entry) => entry.session);
    fosterSessions(once, { store, ledger, target: NEW_ACCOUNT });
    const second = fosterSessions(once, { store, ledger, target: NEW_ACCOUNT });

    expect(second[0]!.status).toBe('skipped');
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(1);
  });

  it('stops offering it once it has been restored', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user', cwd: '/work/project' }]);

    fosterSessions(
      findRestorable(store, env).map((entry) => entry.session),
      { store, ledger, target: NEW_ACCOUNT },
    );

    // The restored copy now points at the conversation, so it is no longer lost.
    expect(findRestorable(store, env)).toEqual([]);
  });
});

describe('the title a restore writes', () => {
  it('is marked as coming from the app, which is where it came from', () => {
    // Real sessions carry 'auto' for an app-generated title and 'user' for a
    // manual rename. The restored title is the app's own ai-title record.
    expect(buildRestoredSession({ cliSessionId: DELETED_CLI }).titleSource).toBe('auto');
  });

  it('is never left for the app to fill in', () => {
    // An untitled session is shown as "General coding session", which is
    // indistinguishable from every other untitled one.
    const data = buildRestoredSession({ cliSessionId: DELETED_CLI });
    expect(data.title).toBeTruthy();
  });
});

describe('conversations spread across several CLI config directories', () => {
  /**
   * Running a second Claude Code account means giving the CLI its own
   * CLAUDE_CONFIG_DIR, and each of those keeps its own projects/ tree. Looking
   * only at the one this process runs under would return a shorter list that
   * looks complete.
   */
  function transcriptIn(configDir: string, cliSessionId: string) {
    const dir = path.join(configDir, 'projects', 'C--work-other');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${cliSessionId}.jsonl`),
      JSON.stringify({ type: 'user' }),
      'utf8',
    );
  }

  it('finds one whose conversation lives under another config directory', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'foster-cfg2-'));
    tombstone([DELETED_CLI]);
    transcriptIn(other, DELETED_CLI);

    // Not under env's config dir at all — only reachable via the extra roots.
    expect(findRestorable(store, env)).toEqual([]);
    expect(findRestorable(store, env, [other])).toHaveLength(1);
  });

  it('does not count a directory that merely has the right name', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'foster-cfg3-'));
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI, [{ type: 'user' }]);

    // No projects/ tree in it, so it contributes nothing and breaks nothing.
    expect(findRestorable(store, env, [bare])).toHaveLength(1);
  });
});
