import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fosterSessionsTool,
  labelAccount,
  listSessions,
  readTranscript,
  resumeHeadless,
  returnFosteringsTool,
  scanAccounts,
  WRITES_DISABLED,
  type AgentToolContext,
} from '../src/agent/tools.js';
import { AppRunningError } from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { liveSessions } from '../src/store/liveSessions.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * The agent's tools are the CLI's engine behind the CLI's gates. What these
 * tests pin down is the gating itself: a mutation is a dry run unless the user
 * allowed writes AND the model asked to apply — the model alone can never write.
 */

function makeContext(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  const store = makeStore();
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  // The destination directory must exist for the account to be discoverable.
  mkdirSync(
    path.join(store.codeSessionsDir, NEW_ACCOUNT.accountUuid, NEW_ACCOUNT.organizationUuid),
    { recursive: true },
  );
  const ledger = new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'foster-agent-')), 'l.jsonl'),
  );
  return { store, ledger, allowWrites: false, ...overrides };
}

interface ListResult {
  total: number;
  shown: number;
  note?: string;
  sessions: { sessionId: string; accountUuid: string; cliSessionId: string | null }[];
}

interface MutationResult {
  dryRun: boolean;
  note?: string;
  refused?: string;
  counts: Record<string, number>;
  outcomes?: { status: string }[];
}

describe('list_sessions', () => {
  it('offers the other accounts by default and a named account on request', () => {
    const ctx = makeContext();
    writeSession(
      ctx.store,
      OLD_ACCOUNT,
      session({ sessionId: 'aaaa0000-0000-4000-8000-000000000001' }),
    );
    writeSession(
      ctx.store,
      NEW_ACCOUNT,
      session({ sessionId: 'aaaa0000-0000-4000-8000-000000000002' }),
    );

    const elsewhere = listSessions(ctx, {}) as ListResult;
    expect(elsewhere.sessions.map((row) => row.accountUuid)).toEqual([OLD_ACCOUNT.accountUuid]);

    const current = listSessions(ctx, {
      accountUuid: NEW_ACCOUNT.accountUuid.slice(0, 8),
    }) as ListResult;
    expect(current.sessions.map((row) => row.accountUuid)).toEqual([NEW_ACCOUNT.accountUuid]);
  });

  it('filters by title and says when the list was truncated', () => {
    const ctx = makeContext();
    for (const [suffix, title] of [
      ['3', 'billing rework'],
      ['4', 'billing cleanup'],
      ['5', 'unrelated'],
    ] as const) {
      writeSession(
        ctx.store,
        OLD_ACCOUNT,
        session({ sessionId: `aaaa0000-0000-4000-8000-00000000000${suffix}`, title }),
      );
    }

    const filtered = listSessions(ctx, { title: 'billing' }) as ListResult;
    expect(filtered.total).toBe(2);

    const truncated = listSessions(ctx, { limit: 1 }) as ListResult;
    expect(truncated.total).toBe(3);
    expect(truncated.shown).toBe(1);
    expect(truncated.note).toContain('truncated');
  });

  it('refuses an account prefix that matches nothing', () => {
    const ctx = makeContext();
    expect(() => listSessions(ctx, { accountUuid: 'ffff' })).toThrow(/No account matches/);
  });
});

describe('scan_accounts and label_account', () => {
  it('reports every account with its label and which one the sidebar shows', () => {
    const ctx = makeContext();
    writeSession(
      ctx.store,
      OLD_ACCOUNT,
      session({ sessionId: 'aaaa0000-0000-4000-8000-000000000006' }),
    );
    labelAccount(ctx, { accountUuid: OLD_ACCOUNT.accountUuid, label: 'work' });

    const result = scanAccounts(ctx) as {
      accounts: {
        accountUuid: string;
        label: string | null;
        isCurrent: boolean;
        sessions: number;
      }[];
    };
    const old = result.accounts.find((row) => row.accountUuid === OLD_ACCOUNT.accountUuid);
    expect(old).toMatchObject({ label: 'work', isCurrent: false, sessions: 1 });
    const current = result.accounts.find((row) => row.accountUuid === NEW_ACCOUNT.accountUuid);
    expect(current?.isCurrent).toBe(true);
  });

  it('refuses an empty label', () => {
    const ctx = makeContext();
    expect(() => labelAccount(ctx, { accountUuid: OLD_ACCOUNT.accountUuid, label: '  ' })).toThrow(
      /must not be empty/,
    );
  });
});

describe('foster_sessions gating', () => {
  function withCandidate(overrides: Partial<AgentToolContext> = {}) {
    const ctx = makeContext(overrides);
    writeSession(
      ctx.store,
      OLD_ACCOUNT,
      session({ sessionId: 'aaaa0000-0000-4000-8000-000000000007' }),
    );
    return ctx;
  }

  function copiesWritten(ctx: AgentToolContext): number {
    return listActive(project(ctx.ledger.read())).length;
  }

  it('is a dry run when apply is not asked for', () => {
    const ctx = withCandidate({ allowWrites: true });
    const result = fosterSessionsTool(ctx, {}) as MutationResult;
    expect(result.dryRun).toBe(true);
    expect(result.counts.fostered).toBe(1);
    expect(copiesWritten(ctx)).toBe(0);
  });

  it('stays a dry run when the model asks to apply but the user withheld --yes', () => {
    const ctx = withCandidate({ allowWrites: false });
    const result = fosterSessionsTool(ctx, { apply: true }) as MutationResult;
    expect(result.dryRun).toBe(true);
    expect(result.note).toBe(WRITES_DISABLED);
    expect(copiesWritten(ctx)).toBe(0);
  });

  it('writes only when the user allowed it and the model asked for it', () => {
    const ctx = withCandidate({ allowWrites: true });
    const result = fosterSessionsTool(ctx, { apply: true }) as MutationResult;
    expect(result.dryRun).toBe(false);
    expect(result.counts.fostered).toBe(1);
    expect(result.note).toContain('restarted');

    const active = listActive(project(ctx.ledger.read()));
    expect(active).toHaveLength(1);
    expect(existsSync(active[0]!.copyPath)).toBe(true);
  });

  it('refuses session ids that match nothing instead of fostering a subset', () => {
    const ctx = withCandidate();
    expect(() => fosterSessionsTool(ctx, { sessionIds: ['ffffffff'] })).toThrow(
      /No session matches/,
    );
  });
});

describe('return_fosterings gating', () => {
  function withFostered(overrides: Partial<AgentToolContext> = {}) {
    const ctx = makeContext({ allowWrites: true, ...overrides });
    writeSession(
      ctx.store,
      OLD_ACCOUNT,
      session({ sessionId: 'aaaa0000-0000-4000-8000-000000000008' }),
    );
    fosterSessionsTool(ctx, { apply: true });
    const copyPath = listActive(project(ctx.ledger.read()))[0]!.copyPath;
    return { ctx, copyPath };
  }

  it('is a dry run by default and removes only on apply', () => {
    const { ctx, copyPath } = withFostered();

    const dry = returnFosteringsTool(ctx, {}) as MutationResult;
    expect(dry.dryRun).toBe(true);
    expect(existsSync(copyPath)).toBe(true);

    const applied = returnFosteringsTool(ctx, { apply: true }) as MutationResult;
    expect(applied.counts.returned).toBe(1);
    expect(existsSync(copyPath)).toBe(false);
  });

  it('reports the running app as a refusal, not an error, and removes nothing', () => {
    const { ctx, copyPath } = withFostered({
      removalGuard: () => {
        throw new AppRunningError('Claude Desktop is running and has 1 of these copies loaded.');
      },
    });

    const result = returnFosteringsTool(ctx, { apply: true }) as MutationResult;
    expect(result.refused).toContain('Claude Desktop is running');
    expect(existsSync(copyPath)).toBe(true);
  });

  it('keeps the dry run gate when the user withheld --yes', () => {
    const { ctx, copyPath } = withFostered();
    const gated = returnFosteringsTool(
      { ...ctx, allowWrites: false },
      { apply: true },
    ) as MutationResult;
    expect(gated.dryRun).toBe(true);
    expect(gated.note).toBe(WRITES_DISABLED);
    expect(existsSync(copyPath)).toBe(true);
  });
});

describe('read_transcript', () => {
  const CID = '00000000-0000-4000-8000-0000000000cc';

  function withTranscript() {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-agent-cfg-'));
    const dir = path.join(configDir, 'projects', 'C--workspace-project');
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        aiTitle: 'Fix the build',
        cwd: '/workspace/project',
        timestamp: '2026-01-01T00:00:00Z',
      }),
      JSON.stringify({ role: 'user', text: 'first message' }),
      JSON.stringify({ role: 'assistant', text: 'the very last line' }),
    ];
    writeFileSync(path.join(dir, `${CID}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    return makeContext({ env: { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv });
  }

  it('recovers the facts and the requested end of the conversation', () => {
    const ctx = withTranscript();
    const tail = readTranscript(ctx, { cliSessionId: CID }) as {
      title: string;
      text: string;
      truncated: boolean;
    };
    expect(tail.title).toBe('Fix the build');
    expect(tail.text).toContain('the very last line');
    expect(tail.truncated).toBe(false);

    const head = readTranscript(ctx, { cliSessionId: CID, part: 'head', maxChars: 1000 }) as {
      text: string;
    };
    expect(head.text).toContain('Fix the build');
  });

  it('says plainly when no transcript exists for the id', () => {
    const ctx = withTranscript();
    expect(() =>
      readTranscript(ctx, { cliSessionId: '00000000-0000-4000-8000-0000000000cd' }),
    ).toThrow(/No transcript found/);
  });
});

describe('resume_headless', () => {
  const CID = '00000000-0000-4000-8000-0000000000ce';

  it('sits behind the --yes switch like every other write', () => {
    const ctx = makeContext({ allowWrites: false });
    const result = resumeHeadless(ctx, { cliSessionId: CID, prompt: 'hi' }) as { refused: string };
    expect(result.refused).toBe(WRITES_DISABLED);
  });

  it('refuses a conversation a live process is holding open', () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-agent-live-'));
    mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'sessions', 'entry.json'),
      JSON.stringify({ pid: process.pid, sessionId: CID, cwd: '/workspace/project' }),
      'utf8',
    );
    const ctx = makeContext({
      allowWrites: true,
      env: { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
      resumeRunner: () => {
        throw new Error('must not run');
      },
    });

    const result = resumeHeadless(ctx, { cliSessionId: CID, prompt: 'hi' }) as { refused: string };
    expect(result.refused).toContain(`pid ${process.pid}`);
  });

  it('runs the resume when nothing is holding the conversation', () => {
    const seen: string[] = [];
    const ctx = makeContext({
      allowWrites: true,
      env: {
        CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-agent-idle-')),
      } as NodeJS.ProcessEnv,
      resumeRunner: (id, prompt) => {
        seen.push(id, prompt);
        return 'answer';
      },
    });

    const result = resumeHeadless(ctx, { cliSessionId: CID, prompt: 'carry on' }) as {
      output: string;
    };
    expect(result.output).toBe('answer');
    expect(seen).toEqual([CID, 'carry on']);
  });

  it('refuses an id that does not look like a conversation', () => {
    const ctx = makeContext({ allowWrites: true });
    expect(() => resumeHeadless(ctx, { cliSessionId: 'not; an id', prompt: 'hi' })).toThrow(
      /does not look like/,
    );
  });
});

describe('live session registry', () => {
  it('only counts entries whose process still answers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'foster-agent-reg-'));
    writeFileSync(
      path.join(root, 'a.json'),
      JSON.stringify({ pid: 1111, sessionId: '00000000-0000-4000-8000-0000000000d1' }),
      'utf8',
    );
    writeFileSync(
      path.join(root, 'b.json'),
      JSON.stringify({ pid: 2222, sessionId: '00000000-0000-4000-8000-0000000000d2' }),
      'utf8',
    );
    writeFileSync(path.join(root, 'torn.json'), '{', 'utf8');

    const live = liveSessions([root], (pid) => pid === 2222);
    expect(live.map((entry) => entry.pid)).toEqual([2222]);
  });
});
