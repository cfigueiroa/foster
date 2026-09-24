import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConversation } from '../src/engine/resolveConversation.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster export` resolves an id or a title fragment to one conversation the
 * same three-step way `--store` resolves a name: see the function's own doc
 * for the order. These fixtures never touch a real `CLAUDE_CONFIG_DIR` or the
 * real home directory — `projectsDirs` is handed over directly, the same seam
 * `lineageAt` gives `engine/lineage.ts`'s own tests.
 */

const CONVERSATION_A = '00000000-0000-4000-8000-0000000000a1';
const CONVERSATION_B = '00000000-0000-4000-8000-0000000000b1';

/** A `projects/` tree with one transcript per conversation id given. */
function transcriptTree(ids: string[]): string[] {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-resolve-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ uuid: id, type: 'user', timestamp: '2026-09-01T00:00:00.000Z' })}\n`,
      'utf8',
    );
  }
  return [path.join(config, 'projects')];
}

describe('resolveConversation', () => {
  it('resolves by an exact conversation id, even with no card anywhere', () => {
    const store = makeStore();
    const resolved = resolveConversation(
      CONVERSATION_A,
      store,
      undefined,
      {},
      transcriptTree([CONVERSATION_A]),
    );
    expect(resolved.cliSessionId).toBe(CONVERSATION_A);
    expect(resolved.files).toHaveLength(1);
    expect(resolved.cards).toHaveLength(0);
  });

  it('resolves by an unambiguous id prefix', () => {
    const store = makeStore();
    const resolved = resolveConversation(
      CONVERSATION_A.slice(0, 35),
      store,
      undefined,
      {},
      transcriptTree([CONVERSATION_A, CONVERSATION_B]),
    );
    expect(resolved.cliSessionId).toBe(CONVERSATION_A);
  });

  it('refuses an id prefix that names more than one conversation', () => {
    const store = makeStore();
    const shared = CONVERSATION_A.slice(0, 8);
    expect(() =>
      resolveConversation(
        shared,
        store,
        undefined,
        {},
        transcriptTree([CONVERSATION_A, CONVERSATION_B]),
      ),
    ).toThrow(/ambiguous/i);
  });

  it("falls through to a card's own sessionId when no transcript id matches", () => {
    const store = makeStore();
    const cardPath = writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c1', cliSessionId: CONVERSATION_A }),
    );
    void cardPath;

    const resolved = resolveConversation(
      '00000000-0000-4000-8000-0000000000c1',
      store,
      undefined,
      {},
      transcriptTree([CONVERSATION_A]),
    );
    expect(resolved.cliSessionId).toBe(CONVERSATION_A);
    expect(resolved.cards).toHaveLength(1);
  });

  it('falls through to a case-insensitive title fragment', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000c2',
        cliSessionId: CONVERSATION_A,
        title: 'Fixing the Frobnicator',
      }),
    );

    const resolved = resolveConversation(
      'frobnicator',
      store,
      undefined,
      {},
      transcriptTree([CONVERSATION_A]),
    );
    expect(resolved.cliSessionId).toBe(CONVERSATION_A);
  });

  it('refuses a title fragment matching more than one conversation', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000c3',
        cliSessionId: CONVERSATION_A,
        title: 'Fixing the frobnicator',
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000c4',
        cliSessionId: CONVERSATION_B,
        title: 'Frobnicator, take two',
      }),
    );

    expect(() =>
      resolveConversation(
        'frobnicator',
        store,
        undefined,
        {},
        transcriptTree([CONVERSATION_A, CONVERSATION_B]),
      ),
    ).toThrow(/matches 2 conversations by title/i);
  });

  it('narrows to the accounts given', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000c5',
        cliSessionId: CONVERSATION_A,
        title: 'Only in the old account',
      }),
    );

    expect(() =>
      resolveConversation(
        'only in the old account',
        store,
        [NEW_ACCOUNT],
        {},
        transcriptTree([CONVERSATION_A]),
      ),
    ).toThrow(/No conversation found/);
  });

  it('refuses an empty argument outright', () => {
    const store = makeStore();
    expect(() => resolveConversation('   ', store, undefined, {}, [])).toThrow(
      /nothing to resolve/i,
    );
  });

  it('refuses when nothing at all matches', () => {
    const store = makeStore();
    expect(() =>
      resolveConversation(
        'nothing-like-this',
        store,
        undefined,
        {},
        transcriptTree([CONVERSATION_A]),
      ),
    ).toThrow(/No conversation found/);
  });
});
