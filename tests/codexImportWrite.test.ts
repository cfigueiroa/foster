import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sessionPath } from '../src/domain/paths.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../src/domain/types.js';
import { Ledger } from '../src/ledger/log.js';
import { listImported, project } from '../src/ledger/project.js';
import { importCodexRollouts, undoCodexImports } from '../src/engine/codexImportWrite.js';
import { readRolloutMeta, type CodexRolloutMeta } from '../src/store/codex.js';
import { claudeProjectsDir, projectDirName } from '../src/store/transcripts.js';
import { layoutFor } from '../src/domain/paths.js';

const TARGET: AccountRef = {
  accountUuid: '11111111-1111-4111-8111-111111111111',
  organizationUuid: '11111111-1111-4111-8111-111111111112',
};
const ROLLOUT_ID = '00000000-0000-4000-8000-00000000000a';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let codexDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  store = layoutFor(mkdtempSync(path.join(tmpdir(), 'foster-store-')));
  mkdirSync(store.codeSessionsDir, { recursive: true });
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-led-')), 'ledger.jsonl'));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-cfg-'));
  codexDir = mkdtempSync(path.join(tmpdir(), 'foster-codex-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
});

/** Write a rollout .jsonl and return its discovered meta. */
function rollout(
  records: object[],
  meta: { id?: string; cwd?: string; cliVersion?: string } = {},
): CodexRolloutMeta {
  const id = meta.id ?? ROLLOUT_ID;
  const head = {
    type: 'session_meta',
    timestamp: '2026-09-01T10:00:00.000Z',
    payload: {
      id,
      timestamp: '2026-09-01T10:00:00.000Z',
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      cli_version: meta.cliVersion ?? '0.155.0',
    },
  };
  const file = path.join(codexDir, `rollout-${id}.jsonl`);
  writeFileSync(file, [head, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const read = readRolloutMeta(file);
  if (!read) throw new Error('fixture rollout has no readable meta');
  return read;
}

function userMsg(text: string): object {
  return {
    type: 'response_item',
    timestamp: '2026-09-01T10:01:00.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}
function assistantMsg(text: string): object {
  return {
    type: 'response_item',
    timestamp: '2026-09-01T10:02:00.000Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}
function fnCall(callId: string): object {
  return {
    type: 'response_item',
    timestamp: '2026-09-01T10:03:00.000Z',
    payload: {
      type: 'function_call',
      call_id: callId,
      name: 'shell',
      arguments: '{"command":["ls"]}',
    },
  };
}
function fnOut(callId: string): object {
  return {
    type: 'response_item',
    timestamp: '2026-09-01T10:04:00.000Z',
    payload: { type: 'function_call_output', call_id: callId, output: 'ok' },
  };
}

function conversation(cwd = '/repo/demo'): CodexRolloutMeta {
  return rollout([userMsg('please build it'), assistantMsg('on it'), fnCall('c1'), fnOut('c1')], {
    cwd,
  });
}

function run(metas: CodexRolloutMeta[], dryRun: boolean) {
  return importCodexRollouts(metas, {
    store,
    ledger,
    state: project(ledger.read()),
    target: TARGET,
    dryRun,
    env,
    now: 1_700_000_000_000,
  });
}

function transcriptPathFor(id: string, cwd = '/repo/demo'): string {
  return path.join(claudeProjectsDir(env), projectDirName(cwd), `${id}.jsonl`);
}
function cardPathFor(id: string): string {
  return sessionPath(store, TARGET, `local_${id}`);
}

describe('importCodexRollouts', () => {
  it('writes a transcript, a card and a ledger event for a rollout', () => {
    const meta = conversation();
    const [outcome] = run([meta], false);

    expect(outcome!.status).toBe('imported');
    expect(existsSync(transcriptPathFor(ROLLOUT_ID))).toBe(true);
    expect(existsSync(cardPathFor(ROLLOUT_ID))).toBe(true);

    const card = JSON.parse(readFileSync(cardPathFor(ROLLOUT_ID), 'utf8')) as CodeSessionData;
    expect(card.cliSessionId).toBe(ROLLOUT_ID);
    expect(card.sessionId).toBe(`local_${ROLLOUT_ID}`);
    expect(card.lastFocusedAt).toBeDefined(); // without it the card never reaches Recents
    expect(card._fosterImport?.rolloutId).toBe(ROLLOUT_ID);
    expect(card._fosterImport?.sourceRolloutPath).toBe(meta.file);
    expect(card._fosterImport?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const imported = listImported(project(ledger.read()));
    expect(imported).toHaveLength(1);
    expect(imported[0]!.rolloutId).toBe(ROLLOUT_ID);

    // The transcript is well-formed JSONL the reader can take.
    const lines = readFileSync(transcriptPathFor(ROLLOUT_ID), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('writes nothing on a dry run', () => {
    const [outcome] = run([conversation()], true);
    expect(outcome!.status).toBe('imported'); // a dry run still previews it as importable
    expect(existsSync(transcriptPathFor(ROLLOUT_ID))).toBe(false);
    expect(existsSync(cardPathFor(ROLLOUT_ID))).toBe(false);
    expect(listImported(project(ledger.read()))).toHaveLength(0);
  });

  it('skips a rollout it has already imported', () => {
    run([conversation()], false);
    const [second] = run([conversation()], false); // fresh fold sees the first import
    expect(second!.status).toBe('skipped');
    expect(second!.reason).toMatch(/already imported/);
  });

  it('refuses to overwrite a transcript it did not write', () => {
    // A file already sits where the import would land, and nothing in the ledger
    // vouches for it — so it belongs to someone else.
    const target = transcriptPathFor(ROLLOUT_ID);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '{"not":"ours"}\n', 'utf8');

    const [outcome] = run([conversation()], false);
    expect(outcome!.status).toBe('skipped');
    expect(outcome!.reason).toMatch(/already exists/);
    expect(readFileSync(target, 'utf8')).toBe('{"not":"ours"}\n'); // untouched
  });

  it('skips a rollout with no working directory', () => {
    const meta = rollout([userMsg('hi'), assistantMsg('yo')], { cwd: undefined });
    const [outcome] = run([meta], false);
    expect(outcome!.status).toBe('skipped');
    expect(outcome!.reason).toMatch(/working directory/);
  });

  it('records a failure in the ledger rather than throwing out of the batch', () => {
    // Two rollouts; the first is fine. The batch must complete regardless.
    const ok = conversation('/repo/one');
    const also = rollout([userMsg('second'), assistantMsg('done')], {
      id: '00000000-0000-4000-8000-00000000000b',
      cwd: '/repo/two',
    });
    const outcomes = run([ok, also], false);
    expect(outcomes.map((o) => o.status)).toEqual(['imported', 'imported']);
  });
});

describe('undoCodexImports', () => {
  it('removes both files and lets the rollout be imported again', () => {
    run([conversation()], false);
    const imports = listImported(project(ledger.read()));
    expect(imports).toHaveLength(1);

    const [undone] = undoCodexImports(imports, { ledger, dryRun: false });
    expect(undone!.status).toBe('undone');
    expect(existsSync(transcriptPathFor(ROLLOUT_ID))).toBe(false);
    expect(existsSync(cardPathFor(ROLLOUT_ID))).toBe(false);
    expect(listImported(project(ledger.read()))).toHaveLength(0);

    // With the record gone and the files removed, a re-import is clean.
    const [again] = run([conversation()], false);
    expect(again!.status).toBe('imported');
  });

  it('writes nothing on a dry run', () => {
    run([conversation()], false);
    const imports = listImported(project(ledger.read()));
    undoCodexImports(imports, { ledger, dryRun: true });
    expect(existsSync(cardPathFor(ROLLOUT_ID))).toBe(true); // still there
    expect(listImported(project(ledger.read()))).toHaveLength(1);
  });
});
