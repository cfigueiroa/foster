import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import type { StoreLayout } from '../src/domain/types.js';
import {
  assertPurgeConfirmed,
  purgeConversations,
  summarisePurge,
  PurgeNotConfirmedError,
} from '../src/engine/purge.js';
import { Ledger } from '../src/ledger/log.js';
import { findPurgeable } from '../src/store/purge.js';
import { findRestorable } from '../src/store/restore.js';
import { scanTombstones } from '../src/store/tombstones.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

const DELETED_CLI = '00000000-0000-4000-8000-0000000000d1';
const OTHER_CLI = '00000000-0000-4000-8000-0000000000d2';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let env: NodeJS.ProcessEnv;

function tombstone(ids: string[], at = 1_700_000_500_000) {
  const dir = accountDir(store, OLD_ACCOUNT);
  mkdirSync(dir, { recursive: true });
  for (const id of ids) writeFileSync(path.join(dir, `deleted_${id}`), String(at), 'utf8');
}

/** Returns the path, because these tests care about the file itself. */
function transcript(cliSessionId: string, project = 'C--work-project'): string {
  const dir = path.join(configDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cliSessionId}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Something private', sessionId: cliSessionId }),
      JSON.stringify({ type: 'user', cwd: '/work/project', timestamp: '2023-11-15T10:00:00.000Z' }),
    ].join('\n'),
    'utf8',
  );
  return file;
}

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-purge-')), 'l.jsonl'));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-cfg-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
  mkdirSync(accountDir(store, OLD_ACCOUNT), { recursive: true });
});

describe('findPurgeable', () => {
  it('offers exactly what restore would bring back', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);

    const purgeable = findPurgeable({ store, env });
    expect(purgeable).toHaveLength(1);
    expect(purgeable[0]!.cliSessionId).toBe(DELETED_CLI);
    expect(purgeable[0]!.facts.title).toBe('Something private');
    expect(purgeable[0]!.bytes).toBeGreaterThan(0);
    // The two commands are the same set read in opposite directions.
    expect(findRestorable(store, env).map((r) => r.facts.cliSessionId)).toEqual([DELETED_CLI]);
  });

  it('never offers a conversation a session still points at', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);
    writeSession(store, NEW_ACCOUNT, session({ cliSessionId: DELETED_CLI }));

    expect(findPurgeable({ store, env })).toEqual([]);
  });

  it('counts a card in another installation as a reference', () => {
    // The guard that matters, and the one restore does not need: a profile foster
    // is not pointed at right now still shows that session after a restart.
    const other = makeStore();
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);
    writeSession(other, NEW_ACCOUNT, session({ cliSessionId: DELETED_CLI }));

    expect(findPurgeable({ store, env })).toHaveLength(1);
    expect(findPurgeable({ store, referenceStores: [other], env })).toEqual([]);
  });

  it('counts a Cowork card as a reference', () => {
    // local-agent-mode-sessions is the other session tree in the same store.
    // scanStore does not read it — Cowork sessions are not fosterable — but the
    // question here is whether anything still points at the conversation.
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);
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

    expect(findPurgeable({ store, env })).toEqual([]);
  });

  it('counts the store in use even when the caller names others', () => {
    // The bug this exists for: the CLI built its list from "every installation
    // foster knows about", which for a store nothing had heard of — a fresh
    // profile, a --store path — did not include the store being worked on. Every
    // card in it counted for nothing, and its live conversations were offered up
    // for destruction.
    const elsewhere = makeStore();
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);
    writeSession(store, NEW_ACCOUNT, session({ cliSessionId: DELETED_CLI }));

    expect(findPurgeable({ store, referenceStores: [elsewhere], env })).toEqual([]);
  });

  it('ignores markers left for identifiers that are not conversations', () => {
    tombstone(['00000000-0000-4000-8000-0000000000d9', DELETED_CLI]);
    transcript(DELETED_CLI);

    expect(findPurgeable({ store, env })).toHaveLength(1);
  });

  it('collects every copy of a mirrored transcript', () => {
    tombstone([DELETED_CLI]);
    const first = transcript(DELETED_CLI, 'C--work-project');
    const second = transcript(DELETED_CLI, 'C--work-project-moved');

    expect(findPurgeable({ store, env })[0]!.files.sort()).toEqual([first, second].sort());
  });
});

describe('purging', () => {
  it('destroys the conversation and leaves nothing to restore', () => {
    tombstone([DELETED_CLI]);
    const file = transcript(DELETED_CLI);

    const outcomes = purgeConversations(findPurgeable({ store, env }), { ledger });

    expect(outcomes[0]!.status).toBe('purged');
    expect(existsSync(file)).toBe(false);
    // The point of the command: the route back is gone, not merely hidden.
    expect(findRestorable(store, env)).toEqual([]);
    expect(findPurgeable({ store, env })).toEqual([]);
  });

  it('removes every mirrored copy, not just the one it read', () => {
    tombstone([DELETED_CLI]);
    const first = transcript(DELETED_CLI, 'C--work-project');
    const second = transcript(DELETED_CLI, 'C--work-project-moved');

    const [outcome] = purgeConversations(findPurgeable({ store, env }), { ledger });

    expect(outcome!.files).toBe(2);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    tombstone([DELETED_CLI]);
    const file = transcript(DELETED_CLI);

    const outcomes = purgeConversations(findPurgeable({ store, env }), { ledger, dryRun: true });

    expect(outcomes[0]!.status).toBe('purged');
    expect(existsSync(file)).toBe(true);
    expect(ledger.read()).toEqual([]);
  });

  it('refuses one a live claude process is holding open', () => {
    tombstone([DELETED_CLI]);
    const file = transcript(DELETED_CLI);

    const outcomes = purgeConversations(findPurgeable({ store, env }), {
      ledger,
      held: new Set([DELETED_CLI]),
    });

    expect(outcomes[0]!.status).toBe('skipped');
    expect(existsSync(file)).toBe(true);
  });

  it('leaves the app’s deletion marker alone', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);

    purgeConversations(findPurgeable({ store, env }), { ledger });

    // The marker is the app's record of its own deletion, not foster's to erase.
    expect(scanTombstones(store, OLD_ACCOUNT)).toHaveLength(1);
  });

  it('records that it happened without preserving what was destroyed', () => {
    tombstone([DELETED_CLI]);
    transcript(DELETED_CLI);

    purgeConversations(findPurgeable({ store, env }), { ledger });

    const [event] = ledger.read();
    expect(event).toMatchObject({ kind: 'conversation_purged', cliSessionId: DELETED_CLI });
    // A ledger that kept the title would be the backup this command promises
    // not to keep.
    expect(JSON.stringify(event)).not.toContain('Something private');
    expect(JSON.stringify(event)).not.toContain('/work/project');
  });

  it('records what it destroyed even when a later copy will not go', () => {
    // A mirrored transcript where the second copy cannot be removed — here a
    // non-empty directory wearing the .jsonl name, which is what a locked file
    // looks like from removeSafely's point of view: it throws. The first copy is
    // already gone by then, and saying "0 destroyed" over a half-destroyed
    // conversation is the report that must not happen.
    tombstone([DELETED_CLI]);
    const real = transcript(DELETED_CLI, 'C--work-project');
    // Named so it is listed after the real copy: the point of the test is a
    // throw that lands once something has already been destroyed.
    const blocked = path.join(configDir, 'projects', 'C--work-zz-blocked', `${DELETED_CLI}.jsonl`);
    mkdirSync(blocked, { recursive: true });
    writeFileSync(path.join(blocked, 'held.txt'), 'x', 'utf8');

    const [outcome] = purgeConversations(findPurgeable({ store, env }), { ledger });

    expect(existsSync(real)).toBe(false);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.files).toBe(1);
    expect(outcome!.bytes).toBeGreaterThan(0);

    const events = ledger.read();
    // Both halves of the truth: what was destroyed, and that it then failed.
    expect(events[0]).toMatchObject({ kind: 'conversation_purged', files: 1 });
    expect(events[1]).toMatchObject({ kind: 'failed', cliSessionId: DELETED_CLI });
  });

  it('counts only the bytes it actually reclaimed', () => {
    tombstone([DELETED_CLI]);
    const first = transcript(DELETED_CLI, 'C--work-project');
    const second = transcript(DELETED_CLI, 'C--work-project-moved');
    const found = findPurgeable({ store, env });
    const oneCopy = statSync(first).size;
    // Something else removes one copy between the scan and the purge.
    rmSync(second);

    const [outcome] = purgeConversations(found, { ledger });

    expect(found[0]!.bytes).toBe(oneCopy * 2);
    expect(outcome!.files).toBe(1);
    // The scan's total would have claimed both copies back.
    expect(outcome!.bytes).toBe(oneCopy);
  });

  it('reports what went, in files and bytes', () => {
    tombstone([DELETED_CLI, OTHER_CLI]);
    transcript(DELETED_CLI);
    transcript(OTHER_CLI);

    const counts = summarisePurge(purgeConversations(findPurgeable({ store, env }), { ledger }));

    expect(counts).toMatchObject({ purged: 2, skipped: 0, failed: 0 });
    expect(counts.bytes).toBeGreaterThan(0);
  });
});

describe('the confirmation gate', () => {
  it('refuses --yes on its own', () => {
    expect(() => assertPurgeConfirmed(undefined, 3)).toThrow(PurgeNotConfirmedError);
    expect(() => assertPurgeConfirmed(undefined, 3)).toThrow(/--confirm 3/);
  });

  it('refuses a count that does not match', () => {
    // The case this exists for: something else was deleted in the app between
    // reading the list and running the command.
    expect(() => assertPurgeConfirmed('3', 4)).toThrow(/does not match the 4/);
  });

  it('refuses anything that is not a count', () => {
    expect(() => assertPurgeConfirmed('yes', 1)).toThrow(/not "yes"/);
    expect(() => assertPurgeConfirmed('1e0', 1)).toThrow(/not "1e0"/);
  });

  it('passes when the number was read off the dry run', () => {
    expect(() => assertPurgeConfirmed('4', 4)).not.toThrow();
    expect(() => assertPurgeConfirmed('0', 0)).not.toThrow();
  });
});
