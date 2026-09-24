import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { layoutFor, sessionPath } from '../src/domain/paths.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../src/domain/types.js';
import type { CloudSessionDetail, TeleportEvent } from '../src/engine/cloudApi.js';
import { pullCloudSession } from '../src/engine/cloudImportWrite.js';
import { undoCodexImports } from '../src/engine/codexImportWrite.js';
import { Ledger } from '../src/ledger/log.js';
import { listImported, project } from '../src/ledger/project.js';
import { claudeProjectsDir, projectDirName } from '../src/store/transcripts.js';

const TARGET: AccountRef = {
  accountUuid: '11111111-1111-4111-8111-111111111111',
  organizationUuid: '11111111-1111-4111-8111-111111111112',
};
const CLOUD_ID = 'cse_00000000000000000000000001';
const CWD = '/repo/demo';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  store = layoutFor(mkdtempSync(path.join(tmpdir(), 'foster-cloud-store-')));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-cloud-cfg-'));
  ledger = new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'foster-cloud-led-')), 'ledger.jsonl'),
  );
  env = { CLAUDE_CONFIG_DIR: configDir };
});

function detail(overrides: Partial<CloudSessionDetail> = {}): CloudSessionDetail {
  return {
    id: CLOUD_ID,
    title: 'Fix the thing',
    status: 'idle',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastEventAt: '2026-09-01T00:10:00.000Z',
    repo: { repo: 'acme/widgets', branch: 'claude/fix-thing' },
    ...overrides,
  };
}

function events(): TeleportEvent[] {
  return [
    {
      eventId: 'u1',
      eventType: 'user',
      payload: {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        sessionId: 'old-session-id',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { role: 'user', content: 'please build it' },
      },
    },
    {
      eventId: 'a1',
      eventType: 'assistant',
      payload: {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        isSidechain: false,
        sessionId: 'old-session-id',
        timestamp: '2026-09-01T00:05:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
      },
    },
  ];
}

function run(dryRun: boolean, overrides: Partial<CloudSessionDetail> = {}, evs = events()) {
  return pullCloudSession(CLOUD_ID, detail(overrides), evs, {
    store,
    ledger,
    state: project(ledger.read()),
    target: TARGET,
    cwd: CWD,
    dryRun,
    env,
    now: 1_700_000_000_000,
  });
}

describe('pullCloudSession', () => {
  it('writes a transcript, a card and a ledger event with source: cloud', () => {
    const outcome = run(false);
    expect(outcome.status).toBe('imported');
    expect(outcome.cardPath).toBeDefined();
    expect(outcome.transcriptPath).toBeDefined();
    expect(existsSync(outcome.cardPath!)).toBe(true);
    expect(existsSync(outcome.transcriptPath!)).toBe(true);

    const card = JSON.parse(readFileSync(outcome.cardPath!, 'utf8')) as CodeSessionData;
    expect(card.cwd).toBe(CWD);
    expect(card.originCwd).toBe(CWD);
    expect(card.title).toBe('Fix the thing');
    expect(card.branch).toBe('claude/fix-thing');
    expect(card.lastFocusedAt).toBeDefined(); // without it the card never reaches Recents
    expect(card._fosterImport?.source).toBe('cloud');
    expect(card._fosterImport?.rolloutId).toBe(CLOUD_ID);
    expect(card._fosterImport?.sourceRolloutPath).toContain(CLOUD_ID);
    expect(card._fosterImport?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The transcript's own sessionId is a freshly minted uuid, not the cloud id.
    expect(card.cliSessionId).not.toBe(CLOUD_ID);
    expect(card.sessionId).toBe(`local_${card.cliSessionId}`);

    const transcriptDir = path.join(claudeProjectsDir(env), projectDirName(CWD));
    expect(path.dirname(outcome.transcriptPath!)).toBe(transcriptDir);
    expect(path.basename(outcome.transcriptPath!)).toBe(`${card.cliSessionId}.jsonl`);

    const lines = readFileSync(outcome.transcriptPath!, 'utf8').trim().split('\n');
    expect(lines.length).toBe(3); // 2 real records + the continuation notice
    for (const line of lines) {
      const record = JSON.parse(line) as { sessionId: string; cwd: string };
      expect(record.sessionId).toBe(card.cliSessionId);
      expect(record.cwd).toBe(CWD);
    }

    const imported = listImported(project(ledger.read()));
    expect(imported).toHaveLength(1);
    expect(imported[0]!.rolloutId).toBe(CLOUD_ID);
    expect(imported[0]!.source).toBe('cloud');
  });

  it('writes nothing on a dry run', () => {
    const outcome = run(true);
    expect(outcome.status).toBe('imported'); // a dry run still previews it as pullable
    expect(existsSync(outcome.cardPath!)).toBe(false);
    expect(existsSync(outcome.transcriptPath!)).toBe(false);
    expect(listImported(project(ledger.read()))).toHaveLength(0);
  });

  it('skips a session it has already pulled, unchanged', () => {
    run(false);
    const second = run(false);
    expect(second.status).toBe('skipped');
    expect(second.reason).toMatch(/already pulled/);
  });

  it('pulls again when the session history has changed since the last pull', () => {
    run(false);
    const changed = events();
    changed.push({
      eventId: 'a2',
      eventType: 'assistant',
      payload: {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        isSidechain: false,
        sessionId: 'old-session-id',
        timestamp: '2026-09-01T00:06:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'more work' }] },
      },
    });
    const first = project(ledger.read()).imported.get(CLOUD_ID)!;
    const outcome = run(false, {}, changed);
    expect(outcome.status).toBe('imported');
    // Overwritten in place — same minted uuid, same paths — not a second copy.
    expect(outcome.cardPath).toBe(first.cardPath);
    expect(outcome.transcriptPath).toBe(first.transcriptPath);
    expect(listImported(project(ledger.read()))).toHaveLength(1);
    const lines = readFileSync(outcome.transcriptPath!, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4); // 3 real records + the continuation notice
  });

  it('drops sidechain records and marks the card archived when the session is archived', () => {
    const withSidechain = events();
    withSidechain.push({
      eventId: 'side1',
      eventType: 'user',
      payload: {
        type: 'user',
        uuid: 'side1',
        parentUuid: 'a1',
        isSidechain: true,
        sessionId: 'old-session-id',
        timestamp: '2026-09-01T00:07:00.000Z',
        message: { role: 'user', content: 'a digression' },
      },
    });
    const outcome = run(false, { status: 'archived' }, withSidechain);
    expect(outcome.sidechainsDropped).toBe(1);

    const card = JSON.parse(readFileSync(outcome.cardPath!, 'utf8')) as CodeSessionData;
    expect(card.isArchived).toBe(true);
  });
});

describe('undoing a cloud pull (via undoCodexImports, which is generic over source)', () => {
  it('removes both files and lets the session be pulled again', () => {
    run(false);
    const imports = listImported(project(ledger.read())).filter((i) => i.source === 'cloud');
    expect(imports).toHaveLength(1);

    const [undone] = undoCodexImports(imports, { ledger, dryRun: false });
    expect(undone!.status).toBe('undone');
    expect(existsSync(imports[0]!.cardPath)).toBe(false);
    expect(existsSync(imports[0]!.transcriptPath)).toBe(false);
    expect(listImported(project(ledger.read()))).toHaveLength(0);

    const again = run(false);
    expect(again.status).toBe('imported');
  });
});

describe('sessionPath agrees with what pullCloudSession wrote', () => {
  it('the card lands exactly where sessionPath says it should', () => {
    const outcome = run(false);
    const card = JSON.parse(readFileSync(outcome.cardPath!, 'utf8')) as CodeSessionData;
    expect(outcome.cardPath).toBe(sessionPath(store, TARGET, card.sessionId));
  });
});
