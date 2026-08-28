import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodeSessionData, DiscoveredSession } from '../src/domain/types.js';
import {
  findStranded,
  openResumeTabs,
  resumeCommandFor,
  type RescueDeps,
  type StrandedConversation,
} from '../src/engine/rescue.js';
import { lastRecordedCwd } from '../src/store/transcripts.js';

const CONVERSATION = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const MIRROR = 'session_000000000000000000000001';

function card(
  over: Partial<CodeSessionData> = {},
  extra: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  const data: CodeSessionData = {
    sessionId: 'local_0000000a',
    cliSessionId: CONVERSATION,
    bridgeSessionIds: [MIRROR],
    lastActivityAt: 1_000,
    ...over,
  };
  return {
    path: `/store/${data.sessionId}.json`,
    account: {
      accountUuid: '00000000-0000-4000-8000-00000000000a',
      organizationUuid: '00000000-0000-4000-8000-00000000000b',
    },
    data,
    isCopy: false,
    isStranded: false,
    reasons: [],
    ...extra,
  };
}

function deps(over: Partial<RescueDeps> = {}): RescueDeps {
  return {
    transcriptFor: () => '/projects/somewhere/conversation.jsonl',
    lastCwd: () => '/work/alpha',
    liveIds: new Set<string>(),
    sizeOf: () => 42,
    directoryExists: () => true,
    ...over,
  };
}

describe('findStranded', () => {
  it('reports a mirrored conversation with no live writer, resumable where it last ran', () => {
    const rows = findStranded([card()], { includeArchived: false }, deps());
    expect(rows).toEqual([
      {
        cliSessionId: CONVERSATION,
        cwd: '/work/alpha',
        cwdExists: true,
        transcriptPath: '/projects/somewhere/conversation.jsonl',
        sizeBytes: 42,
        lastActivityAt: 1_000,
        isArchived: false,
      },
    ]);
  });

  it('leaves a card that never had a mirror alone', () => {
    // Without a mirror there is no "unreachable" card to fix: the session just
    // sits there resumable, and listing it would send someone to rescue nothing.
    const bare = card({ bridgeSessionIds: undefined });
    expect(findStranded([bare], { includeArchived: false }, deps())).toEqual([]);
  });

  it('does not count a conversation that has a live writer', () => {
    const holding = deps({ liveIds: new Set([CONVERSATION]) });
    expect(findStranded([card()], { includeArchived: false }, holding)).toEqual([]);
  });

  it('excludes archived sessions unless asked, and marks them when included', () => {
    const archived = card({ isArchived: true });
    expect(findStranded([archived], { includeArchived: false }, deps())).toEqual([]);
    const rows = findStranded([archived], { includeArchived: true }, deps());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isArchived).toBe(true);
  });

  it('applies the activity window', () => {
    const old = card({ lastActivityAt: 500 });
    expect(findStranded([old], { since: 900, includeArchived: false }, deps())).toEqual([]);
    expect(findStranded([old], { since: 100, includeArchived: false }, deps())).toHaveLength(1);
  });

  it('reports one row per conversation, keeping the most recent card', () => {
    const older = card({ sessionId: 'local_0000000b', lastActivityAt: 1_000 });
    const newer = card({ sessionId: 'local_0000000c', lastActivityAt: 2_000 });
    const rows = findStranded([older, newer], { includeArchived: false }, deps());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastActivityAt).toBe(2_000);
  });

  it('rescues a fostered copy — in a swept account it is the only card there is', () => {
    // The original sits in another account's directory, outside this scan;
    // skipping copies would hide exactly the cards the sidebar is showing.
    const copy = card({}, { isCopy: true });
    expect(findStranded([copy], { includeArchived: false }, deps())).toHaveLength(1);
  });

  it('offers a conversation once when its original and its copy are both here', () => {
    const original = card({ sessionId: 'local_0000000f', lastActivityAt: 2_000 });
    const copy = card({ sessionId: 'local_00000010', lastActivityAt: 1_000 }, { isCopy: true });
    const rows = findStranded([original, copy], { includeArchived: false }, deps());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastActivityAt).toBe(2_000);
  });

  it('drops a conversation the app already re-hosted through a fresh mirrorless card', () => {
    // Rescuing leaves this exact shape behind: the husk keeps its dead mirror,
    // and the app's fresh hosting card has none. Once the host exits there is
    // no live writer either — without reading the fresh card, the conversation
    // would come back to this list every day, already rescued.
    const husk = card({ sessionId: 'local_00000011', lastActivityAt: 1_000 });
    const rehost = card({
      sessionId: 'local_00000012',
      bridgeSessionIds: undefined,
      cwd: '/work/alpha',
      lastActivityAt: 2_000,
    });
    expect(findStranded([husk, rehost], { includeArchived: false }, deps())).toEqual([]);
  });

  it('still lists it when the re-host card points at a directory that is gone', () => {
    // The app refuses to start a session whose folder no longer exists
    // (measured), so a re-host card with a dead cwd proves nothing.
    const husk = card({ sessionId: 'local_00000013', lastActivityAt: 1_000 });
    const rehost = card({
      sessionId: 'local_00000014',
      bridgeSessionIds: undefined,
      cwd: '/work/gone',
      lastActivityAt: 2_000,
    });
    const seesOnlyAlpha = deps({ directoryExists: (dir) => dir === '/work/alpha' });
    expect(findStranded([husk, rehost], { includeArchived: false }, seesOnlyAlpha)).toHaveLength(1);
  });

  it('still lists it when the mirror card is newer than the re-host card', () => {
    // A mirror attached after the re-host means the conversation moved on and
    // crashed again; the old hosting card is history, not reachability.
    const husk = card({ sessionId: 'local_00000015', lastActivityAt: 3_000 });
    const rehost = card({
      sessionId: 'local_00000016',
      bridgeSessionIds: undefined,
      cwd: '/work/alpha',
      lastActivityAt: 2_000,
    });
    expect(findStranded([husk, rehost], { includeArchived: false }, deps())).toHaveLength(1);
  });

  it('ignores an archived re-host card — closed on purpose is not reachable', () => {
    const husk = card({ sessionId: 'local_00000017', lastActivityAt: 1_000 });
    const rehost = card({
      sessionId: 'local_00000018',
      bridgeSessionIds: undefined,
      cwd: '/work/alpha',
      isArchived: true,
      lastActivityAt: 2_000,
    });
    expect(findStranded([husk, rehost], { includeArchived: false }, deps())).toHaveLength(1);
  });

  it('keeps a conversation whose transcript is gone, saying so rather than hiding it', () => {
    // A list that quietly omits the unrescuable case is the shape of a bug
    // report; the row stays, with nothing to resume attached to it.
    const rows = findStranded(
      [card()],
      { includeArchived: false },
      deps({ transcriptFor: () => undefined }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transcriptPath).toBeUndefined();
    expect(rows[0]!.cwd).toBeUndefined();
  });

  it('names a resume directory that no longer exists', () => {
    // Worktrees are removed once their session is archived; the resume has to
    // say so up front rather than fail inside a closing terminal tab.
    const rows = findStranded(
      [card()],
      { includeArchived: false },
      deps({ directoryExists: () => false }),
    );
    expect(rows[0]!.cwdExists).toBe(false);
  });

  it('sorts the most recently active first', () => {
    const first = card({
      sessionId: 'local_0000000d',
      cliSessionId: CONVERSATION,
      lastActivityAt: 1_000,
    });
    const second = card({
      sessionId: 'local_0000000e',
      cliSessionId: OTHER,
      lastActivityAt: 3_000,
    });
    const rows = findStranded([first, second], { includeArchived: false }, deps());
    expect(rows.map((row) => row.cliSessionId)).toEqual([OTHER, CONVERSATION]);
  });
});

describe('openResumeTabs', () => {
  const stranded: StrandedConversation = {
    cliSessionId: CONVERSATION,
    cwd: '/work/alpha',
    cwdExists: true,
    transcriptPath: '/projects/somewhere/conversation.jsonl',
    isArchived: false,
  };

  it('opens what can be opened and refuses what cannot, each with its reason', () => {
    const opened: string[] = [];
    const outcomes = openResumeTabs(
      [
        stranded,
        { ...stranded, cliSessionId: OTHER, cwdExists: false },
        {
          ...stranded,
          cliSessionId: '00000000-0000-4000-8000-0000000000a3',
          transcriptPath: undefined,
        },
      ],
      (row) => opened.push(row.cliSessionId),
    );
    expect(opened).toEqual([CONVERSATION]);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(['opened', 'cwd-gone', 'no-transcript']);
  });

  it('turns an opener failure into an outcome instead of a crash', () => {
    const outcomes = openResumeTabs([stranded], () => {
      throw new Error('no terminal');
    });
    expect(outcomes[0]!.outcome).toBe('failed');
  });
});

describe('resumeCommandFor', () => {
  it('is the plain resume, with nothing a shell could misread', () => {
    expect(resumeCommandFor({ cliSessionId: CONVERSATION, isArchived: false })).toBe(
      `claude --resume ${CONVERSATION}`,
    );
  });
});

describe('lastRecordedCwd', () => {
  function transcriptWith(lines: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-rescue-'));
    const file = path.join(dir, 'conversation.jsonl');
    writeFileSync(file, lines.join('\n'), 'utf8');
    return file;
  }

  it('returns the last cwd, not the first', () => {
    // The head names where the session started; a session that moved between
    // worktrees is filed under where it ended, and that is where resume works.
    const file = transcriptWith([
      JSON.stringify({ cwd: '/work/alpha' }),
      JSON.stringify({ say: 'something' }),
      JSON.stringify({ cwd: '/work/beta' }),
      JSON.stringify({ say: 'more' }),
    ]);
    expect(lastRecordedCwd(file)).toBe('/work/beta');
  });

  it('survives a tail that starts mid-record', () => {
    // Reading a bounded tail of a large file lands mid-line; the fragment must
    // be dropped, not parsed into a wrong answer.
    const padding = JSON.stringify({ filler: 'x'.repeat(1024) });
    const lines = Array.from({ length: 400 }, () => padding);
    lines.unshift(JSON.stringify({ cwd: '/work/alpha' }));
    lines.push(JSON.stringify({ cwd: '/work/final' }));
    const file = transcriptWith(lines);
    expect(lastRecordedCwd(file)).toBe('/work/final');
  });

  it('answers nothing for a file it cannot read', () => {
    expect(lastRecordedCwd('/nowhere/conversation.jsonl')).toBeUndefined();
  });
});
