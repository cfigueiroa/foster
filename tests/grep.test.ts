import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grepTranscripts } from '../src/engine/grep.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster grep` reads every transcript through `engine/grep.js`'s own
 * `projectsDirs` test seam, never through the real `CLAUDE_CONFIG_DIR`/home
 * directory `transcriptRoots` would otherwise scan — the same isolation
 * `lineage.test.ts` gives `lineageAt`.
 */

const CONVERSATION = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';

function record(type: 'user' | 'assistant', text: string, when: string): string {
  return JSON.stringify({
    uuid: `${type}-${when}`,
    type,
    timestamp: when,
    message: { role: type, content: [{ type: 'text', text }] },
  });
}

/** A tool-call/tool-result pair, which must never itself read as a hit. */
function toolUse(name: string, input: unknown, when: string): string {
  return JSON.stringify({
    uuid: `tool-${when}`,
    type: 'assistant',
    timestamp: when,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
  });
}

function toolResult(content: string, when: string): string {
  return JSON.stringify({
    uuid: `result-${when}`,
    type: 'user',
    timestamp: when,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }],
    },
  });
}

/** One `projects/` tree, one conversation per id given. */
function transcripts(byId: Record<string, string[]>): string[] {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-grep-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  for (const [id, lines] of Object.entries(byId)) {
    writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }
  return [path.join(config, 'projects')];
}

describe('grepTranscripts', () => {
  it('finds a literal term in message text', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record('user', 'please rename the frobnicator module', '2026-09-01T00:00:00.000Z'),
      ],
      [OTHER]: [record('user', 'totally unrelated work', '2026-09-01T00:00:00.000Z')],
    });

    const results = grepTranscripts(store, /frobnicator/, { projectsDirs: dirs });

    expect(results).toHaveLength(1);
    expect(results[0]!.cliSessionId).toBe(CONVERSATION);
    expect(results[0]!.hits).toHaveLength(1);
    expect(results[0]!.hits[0]!.role).toBe('user');
    expect(results[0]!.hits[0]!.snippet).toContain('frobnicator');
  });

  it('matches a real regex, not just a literal substring', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record('user', 'error code 4042 while deploying', '2026-09-01T00:00:00.000Z'),
      ],
    });

    const results = grepTranscripts(store, /\berror code \d{4}\b/, { projectsDirs: dirs });
    expect(results).toHaveLength(1);
  });

  it('does not fire on a JSON-escaping artefact the raw line carries', () => {
    // The literal text "frobnicator" sits only inside the tool's raw JSON
    // input (a quoted argument) and the tool_use record's own `name` never
    // reaches a rendered message — a search of the *decoded message text*
    // must see neither, though a naive grep of the raw line would hit both.
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        toolUse('Bash', { command: 'echo frobnicator' }, '2026-09-01T00:00:00.000Z'),
        toolResult('done', '2026-09-01T00:00:01.000Z'),
      ],
    });

    const results = grepTranscripts(store, /frobnicator/, { projectsDirs: dirs });
    expect(results).toHaveLength(0);
  });

  it('decodes non-ASCII text correctly rather than matching mojibake', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record('assistant', 'código pronto: revisão concluída', '2026-09-01T00:00:00.000Z'),
      ],
    });

    const results = grepTranscripts(store, /revisão/, { projectsDirs: dirs });
    expect(results).toHaveLength(1);
    expect(results[0]!.hits[0]!.snippet).toContain('revisão');
  });

  it('filters by --role', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record('user', 'mentions gizmo here', '2026-09-01T00:00:00.000Z'),
        record('assistant', 'also mentions gizmo here', '2026-09-01T00:00:01.000Z'),
      ],
    });

    const onlyAssistant = grepTranscripts(store, /gizmo/, {
      projectsDirs: dirs,
      role: 'assistant',
    });
    expect(onlyAssistant[0]!.hits).toHaveLength(1);
    expect(onlyAssistant[0]!.hits[0]!.role).toBe('assistant');
  });

  it('skips a transcript file older than --since', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'mentions widget here', '2026-01-01T00:00:00.000Z')],
    });
    const file = path.join(dirs[0]!, '-workspace-project', `${CONVERSATION}.jsonl`);
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(file, old, old);

    const results = grepTranscripts(store, /widget/, {
      projectsDirs: dirs,
      since: Date.now() - 24 * 60 * 60 * 1000,
    });
    expect(results).toHaveLength(0);
  });

  it('filters by a conversation-level --cwd fragment', () => {
    const store = makeStore();
    const config = mkdtempSync(path.join(tmpdir(), 'foster-grep-cwd-'));
    const dir = path.join(config, 'projects', '-workspace-widget-service');
    mkdirSync(dir, { recursive: true });
    const meta = JSON.stringify({ type: 'custom-title', cwd: '/workspace/widget-service' });
    writeFileSync(
      path.join(dir, `${CONVERSATION}.jsonl`),
      `${meta}\n${record('user', 'mentions widget here', '2026-09-01T00:00:00.000Z')}\n`,
      'utf8',
    );

    const results = grepTranscripts(store, /widget/, {
      projectsDirs: [path.join(config, 'projects')],
      cwd: 'widget-service',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.cwd).toBe('/workspace/widget-service');
  });

  it('attaches every card, across every account, that opens the conversation', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d5',
        cliSessionId: CONVERSATION,
        title: 'Old account copy',
      }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d6',
        cliSessionId: CONVERSATION,
        title: 'New account copy',
        isArchived: true,
      }),
    );
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'mentions gadget here', '2026-09-01T00:00:00.000Z')],
    });

    const results = grepTranscripts(store, /gadget/, { projectsDirs: dirs });
    expect(results[0]!.cards).toHaveLength(2);
    expect(results[0]!.cards.some((card) => card.isArchived)).toBe(true);
  });

  it('narrows to conversations with a card in --account', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000d7',
        cliSessionId: CONVERSATION,
      }),
    );
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'mentions widget here', '2026-09-01T00:00:00.000Z')],
      [OTHER]: [record('user', 'also mentions widget here', '2026-09-01T00:00:00.000Z')],
    });

    const results = grepTranscripts(store, /widget/, {
      projectsDirs: dirs,
      accountUuid: OLD_ACCOUNT.accountUuid,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.cliSessionId).toBe(CONVERSATION);
  });

  it('reports a conversation with no card left, with an empty card list', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'mentions sprocket here', '2026-09-01T00:00:00.000Z')],
    });

    const results = grepTranscripts(store, /sprocket/, { projectsDirs: dirs });
    expect(results[0]!.cards).toHaveLength(0);
  });

  it('stops at --limit conversations', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'widget one', '2026-09-01T00:00:00.000Z')],
      [OTHER]: [record('user', 'widget two', '2026-09-01T00:00:00.000Z')],
    });

    const results = grepTranscripts(store, /widget/, { projectsDirs: dirs, limit: 1 });
    expect(results).toHaveLength(1);
  });
});
