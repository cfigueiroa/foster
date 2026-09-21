import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodeSessionData, DiscoveredSession } from '../src/domain/types.js';
import { findStopped, USAGE_LIMIT, type ReviveDeps } from '../src/engine/revive.js';
import { lastAnswer, projectDirName, type LastAnswer } from '../src/store/transcripts.js';
import { NEW_ACCOUNT, session } from './helpers/store.js';

/**
 * `foster revive` lists what a usage limit stopped, for the `/retoma` skill to
 * carry on after a sweep. What these pin down is the part that decides who gets
 * a message: only a limit stops a session, a row nobody is waiting on is left
 * alone, and no conversation or branch gets two agents at once.
 */

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SINCE = NOW - 24 * HOUR;

function card(overrides: Partial<CodeSessionData>, reasons: DiscoveredSession['reasons'] = []) {
  const data = session(overrides);
  return {
    account: NEW_ACCOUNT,
    path: `${data.sessionId}.json`,
    data,
    isCopy: false,
    reasons,
  } as DiscoveredSession;
}

const limited = (at: number): LastAnswer => ({
  at,
  error: USAGE_LIMIT,
  text: "You've hit your weekly limit",
});

/** One file per conversation, named after it; answers keyed by that file. */
function deps(answers: Record<string, LastAnswer>, live: string[] = []): ReviveDeps {
  return {
    filesOf: (id) => (answers[id] ? [id] : []),
    lastAnswer: (file) => answers[file],
    liveIds: new Set(live.map((id) => id.toLowerCase())),
  };
}

const run = (sessions: DiscoveredSession[], d: ReviveDeps, includeArchived = false) =>
  findStopped(sessions, { since: SINCE, includeArchived }, d);

const A = '00000000-0000-4000-8000-0000000002a1';
const B = '00000000-0000-4000-8000-0000000002a2';
const C = '00000000-0000-4000-8000-0000000002a3';

describe('findStopped', () => {
  it('lists a session whose conversation ended on the usage limit', () => {
    const { stopped } = run(
      [card({ sessionId: A, title: 'Cut off', branch: 'feat/a' })],
      deps({ [A]: limited(NOW - HOUR) }),
    );

    expect(stopped).toEqual([
      {
        sessionId: `local_${A}`,
        cliSessionId: A,
        title: 'Cut off',
        cwd: '/workspace/project',
        branch: 'feat/a',
        stoppedAt: NOW - HOUR,
        limit: "You've hit your weekly limit",
      },
    ]);
  });

  it('leaves out a session that finished, or stopped on some other error', () => {
    const { stopped } = run(
      [card({ sessionId: A }), card({ sessionId: B })],
      deps({ [A]: { at: NOW - HOUR }, [B]: { at: NOW - HOUR, error: 'invalid_request' } }),
    );

    expect(stopped).toEqual([]);
  });

  it('leaves out a limit hit before the window', () => {
    const { stopped } = run([card({ sessionId: A })], deps({ [A]: limited(SINCE - 1) }));

    expect(stopped).toEqual([]);
  });

  it('leaves archived rows alone unless asked, and scheduled or spawned ones always', () => {
    const sessions = [
      card({ sessionId: A, isArchived: true }),
      card({ sessionId: B }, ['scheduled-task']),
      card({ sessionId: C }, ['spawned-task', 'never-opened']),
    ];
    const answers = deps({ [A]: limited(NOW), [B]: limited(NOW), [C]: limited(NOW) });

    expect(run(sessions, answers).stopped).toEqual([]);
    expect(run(sessions, answers, true).stopped.map((row) => row.cliSessionId)).toEqual([A]);
  });

  it('names a session a live claude is writing rather than listing it', () => {
    const { stopped, passedOver } = run(
      [card({ sessionId: A, title: 'Busy' })],
      deps({ [A]: limited(NOW) }, [A]),
    );

    expect(stopped).toEqual([]);
    expect(passedOver).toEqual([{ sessionId: `local_${A}`, title: 'Busy', reason: 'live' }]);
  });

  it('keeps one row per conversation, the one stopped last', () => {
    // Two cards, one conversation: the second opens the same file.
    const older = card({ sessionId: B, cliSessionId: A, lastActivityAt: 1 });
    const newer = card({ sessionId: C, cliSessionId: A, lastActivityAt: 2 });
    const { stopped, passedOver } = run([older, newer], deps({ [A]: limited(NOW) }));

    expect(stopped).toHaveLength(1);
    expect(passedOver).toHaveLength(1);
    expect(passedOver[0]!.reason).toBe('same-conversation');
    expect(passedOver[0]!.keptSessionId).toBe(stopped[0]!.sessionId);
  });

  it('keeps one conversation per branch of a repository, the fresher one', () => {
    const { stopped, passedOver } = run(
      [
        card({ sessionId: A, title: 'Stopped first', branch: 'feat/x' }),
        card({ sessionId: B, title: 'Stopped last', branch: 'feat/x' }),
        // Same branch name, another repository: no clash.
        card({ sessionId: C, branch: 'feat/x', cwd: '/elsewhere', originCwd: '/elsewhere' }),
      ],
      deps({ [A]: limited(NOW - 2 * HOUR), [B]: limited(NOW - HOUR), [C]: limited(NOW) }),
    );

    expect(stopped.map((row) => row.cliSessionId)).toEqual([C, B]);
    expect(passedOver).toEqual([
      {
        sessionId: `local_${A}`,
        title: 'Stopped first',
        reason: 'same-branch',
        keptSessionId: `local_${B}`,
      },
    ]);
  });

  it('reads the file the card opens when the conversation has more than one', () => {
    const repo = 'C:\\work\\project';
    const files = [
      path.join('projects', projectDirName(repo), `${A}.jsonl`),
      path.join('projects', projectDirName('C:\\work\\elsewhere'), `${A}.jsonl`),
    ];
    const d: ReviveDeps = {
      filesOf: () => files,
      // The other directory's file ended on the limit; the card's own did not.
      lastAnswer: (file) => (file === files[0] ? { at: NOW } : limited(NOW)),
      liveIds: new Set(),
    };

    const { stopped } = run([card({ sessionId: A, cwd: repo })], d);

    expect(stopped).toEqual([]);
  });
});

describe('lastAnswer', () => {
  function write(records: unknown[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-revive-'));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
    return file;
  }

  it('reads the limit record the app writes, past the bookkeeping after it', () => {
    const file = write([
      { type: 'user', uuid: 'u1', timestamp: '2026-09-20T01:58:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-20T01:59:06.481Z',
        isApiErrorMessage: true,
        error: 'rate_limit',
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: "You've hit your weekly limit · resets Sep 25" }],
        },
      },
      { type: 'last-prompt', lastPrompt: 'go on' },
    ]);

    expect(lastAnswer(file)).toEqual({
      at: Date.parse('2026-09-20T01:59:06.481Z'),
      error: 'rate_limit',
      text: "You've hit your weekly limit · resets Sep 25",
    });
  });

  it('answers with no error for a real answer, and ignores a subagent sidechain', () => {
    const file = write([
      { type: 'assistant', uuid: 'a1', timestamp: '2026-09-20T01:00:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a2',
        isSidechain: true,
        timestamp: '2026-09-20T02:00:00.000Z',
        isApiErrorMessage: true,
        error: 'rate_limit',
      },
    ]);

    expect(lastAnswer(file)).toEqual({ at: Date.parse('2026-09-20T01:00:00.000Z') });
  });

  it('is undefined for a file that is not there', () => {
    expect(lastAnswer(path.join(tmpdir(), 'no-such-transcript.jsonl'))).toBeUndefined();
  });
});
