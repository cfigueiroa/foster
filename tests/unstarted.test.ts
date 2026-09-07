import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodeSessionData, DiscoveredSession } from '../src/domain/types.js';
import { findUnstarted, isUnstarted, type UnstartedDeps } from '../src/engine/unstarted.js';
import { firstPrompt } from '../src/store/transcripts.js';

/**
 * A request that died before its first turn leaves a card that looks ordinary
 * and a prompt nobody can see. What these pin down is the three marks that
 * separate it from every card that merely resembles it, and that the prompt
 * comes back whole.
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

function card(over: Partial<CodeSessionData> = {}): DiscoveredSession {
  const data: CodeSessionData = {
    sessionId: 'local_0000000a',
    cliSessionId: CONVERSATION,
    spawnedFrom: { sessionId: 'local_0000000b', taskId: 'task_1', title: 'The orchestrator' },
    error: "You've hit your session limit",
    completedTurns: 0,
    createdAt: 10_000,
    lastActivityAt: 22_000,
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
  };
}

function deps(over: Partial<UnstartedDeps> = {}): UnstartedDeps {
  return {
    transcriptFor: () => '/transcripts/one.jsonl',
    promptIn: () => 'Write the guard',
    ...over,
  };
}

const all = { includeArchived: true };

describe('isUnstarted', () => {
  it('takes a chip that errored without finishing a turn', () => {
    expect(isUnstarted(card().data)).toBe(true);
  });

  it('leaves out a session nobody spawned, however it ended', () => {
    // A person opened this one and walked away. They can see it; it is not lost.
    expect(isUnstarted(card({ spawnedFrom: undefined }).data)).toBe(false);
  });

  it('leaves out a chip that is merely still running', () => {
    // Zero turns and no error is a request that has not started YET. Calling
    // that lost would raise a false alarm on every chip in flight.
    expect(isUnstarted(card({ error: undefined }).data)).toBe(false);
  });

  it('leaves out a chip that answered before it died', () => {
    // One completed turn means there is work on disk to resume, which is
    // rescue's business. Re-asking would redo an answer that already exists.
    expect(isUnstarted(card({ completedTurns: 1 }).data)).toBe(false);
  });

  it('treats a missing turn count as no turns, not as unknown', () => {
    const data = card().data;
    delete data.completedTurns;
    expect(isUnstarted(data)).toBe(true);
  });
});

describe('findUnstarted', () => {
  it('recovers the prompt, which is the whole of what is left', () => {
    const [row] = findUnstarted([card()], all, deps({ promptIn: () => 'Parse every plist' }));

    expect(row?.prompt).toBe('Parse every plist');
    expect(row?.error).toBe("You've hit your session limit");
    expect(row?.parentTitle).toBe('The orchestrator');
    expect(row?.lifetimeMs).toBe(12_000);
  });

  it('says so by omission when the transcript is gone', () => {
    // Nothing at all is recoverable then, and an empty string would read as a
    // request that was blank rather than one that cannot be read.
    const [row] = findUnstarted([card()], all, deps({ transcriptFor: () => undefined }));

    expect(row).toBeDefined();
    expect(row?.prompt).toBeUndefined();
  });

  it('offers one row per conversation when a sweep left two cards for it', () => {
    const copy = card();
    copy.data.sessionId = 'local_0000000c';
    copy.isCopy = true;

    expect(findUnstarted([card(), copy], all, deps())).toHaveLength(1);
  });

  it('reads the transcript once for a conversation, not once per card', () => {
    // The row would be unique either way, because the map keys on the
    // conversation. What a second visit costs is a second read of a transcript
    // to recover a prompt already recovered, and in a swept store every lost
    // request has two cards.
    const copy = card();
    copy.data.sessionId = 'local_0000000c';
    copy.isCopy = true;
    let reads = 0;

    findUnstarted(
      [card(), copy],
      all,
      deps({
        promptIn: () => {
          reads += 1;
          return 'Parse every plist';
        },
      }),
    );

    expect(reads).toBe(1);
  });

  it('keeps archived cards out unless they are asked for', () => {
    const archived = card({ isArchived: true });

    expect(findUnstarted([archived], { includeArchived: false }, deps())).toHaveLength(0);
    expect(findUnstarted([archived], all, deps())).toHaveLength(1);
  });

  it('judges the window on when it was created, and drops what is older', () => {
    const old = card({ cliSessionId: OTHER, createdAt: 5_000 });

    const rows = findUnstarted([card(), old], { ...all, since: 9_000 }, deps());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.cliSessionId).toBe(CONVERSATION);
  });

  it('puts the newest first, so a stale request is not the one in front', () => {
    const older = card({ cliSessionId: OTHER, createdAt: 1_000 });

    const rows = findUnstarted([older, card()], all, deps());

    expect(rows.map((row) => row.cliSessionId)).toEqual([CONVERSATION, OTHER]);
  });
});

describe('firstPrompt', () => {
  const write = (records: unknown[]): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-prompt-'));
    const file = path.join(dir, 'transcript.jsonl');
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));
    return file;
  };

  it('reads the words that started the conversation', () => {
    const file = write([
      { type: 'summary' },
      { type: 'user', message: { content: 'Parse every plist' } },
      { type: 'assistant', message: { content: 'On it' } },
    ]);

    expect(firstPrompt(file)).toBe('Parse every plist');
  });

  it('reads through a system reminder rather than returning one', () => {
    // The harness injects these as user turns, so position alone would hand
    // back scaffolding nobody asked for.
    const file = write([
      { type: 'user', message: { content: '<system-reminder>be nice</system-reminder>' } },
      { type: 'user', message: { content: 'The actual request' } },
    ]);

    expect(firstPrompt(file)).toBe('The actual request');
  });

  it('reads through a tool result, which carries no text part', () => {
    const file = write([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'The actual request' }] } },
    ]);

    expect(firstPrompt(file)).toBe('The actual request');
  });

  it('has no answer for a transcript with no user record at all', () => {
    expect(
      firstPrompt(write([{ type: 'assistant', message: { content: 'hello' } }])),
    ).toBeUndefined();
  });

  it('does not throw on a file that is not there', () => {
    expect(firstPrompt('/no/such/transcript.jsonl')).toBeUndefined();
  });
});
