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

    const { conversations: results } = grepTranscripts(store, /frobnicator/, {
      projectsDirs: dirs,
    });

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

    const { conversations: results } = grepTranscripts(store, /\berror code \d{4}\b/, {
      projectsDirs: dirs,
    });
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

    const { conversations: results } = grepTranscripts(store, /frobnicator/, {
      projectsDirs: dirs,
    });
    expect(results).toHaveLength(0);
  });

  it('finds a literal term whose match spans a double quote (JSON-escaped on disk)', () => {
    // The record's raw JSONL line carries `\"connection refused\"`, never the
    // contiguous bytes `"connection refused"` — the coarse pre-filter must
    // compare against the escaped form, not the term as it was typed.
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record(
          'user',
          'the error said "connection refused" during startup',
          '2026-09-01T00:00:00.000Z',
        ),
      ],
    });

    const { conversations: results } = grepTranscripts(store, /"connection refused"/, {
      projectsDirs: dirs,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.hits[0]!.snippet).toContain('connection refused');
  });

  it('finds a Windows path whose backslashes JSON escaping doubles on disk', () => {
    // A pattern carrying a `\` is never the literal fast path (`\` is regex
    // syntax), so this exercises the regex/prefilter side of the same fix —
    // the raw line holds `C:\\repos\\widget-service\\...`, doubled, never
    // the single backslashes the pattern (or the decoded message) uses.
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record(
          'assistant',
          'run C:\\repos\\widget-service\\bin\\tarefas-invisiveis\\vigia.vbs to fix it',
          '2026-09-01T00:00:00.000Z',
        ),
      ],
    });

    const pattern = /C:\\repos\\widget-service\\bin\\tarefas-invisiveis\\vigia\.vbs/;
    const { conversations: results } = grepTranscripts(store, pattern, { projectsDirs: dirs });
    expect(results).toHaveLength(1);
  });

  it('finds a literal term containing a control character JSON escapes', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'columns:\tvalue', '2026-09-01T00:00:00.000Z')],
    });

    // Built from a string with a real tab character, not a regex `\t`
    // escape, so `.source` carries the raw control character and stays on
    // the literal fast path (no regex-meta character in it).
    // eslint-disable-next-line no-control-regex -- the raw tab is the point of this test
    const pattern = new RegExp('columns:\tvalue');
    const { conversations: results } = grepTranscripts(store, pattern, { projectsDirs: dirs });
    expect(results).toHaveLength(1);
  });

  it('decodes non-ASCII text correctly rather than matching mojibake', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [
        record('assistant', 'código pronto: revisão concluída', '2026-09-01T00:00:00.000Z'),
      ],
    });

    const { conversations: results } = grepTranscripts(store, /revisão/, { projectsDirs: dirs });
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

    const { conversations: onlyAssistant } = grepTranscripts(store, /gizmo/, {
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

    const { conversations: results } = grepTranscripts(store, /widget/, {
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

    const { conversations: results } = grepTranscripts(store, /widget/, {
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

    const { conversations: results } = grepTranscripts(store, /gadget/, { projectsDirs: dirs });
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

    const { conversations: results } = grepTranscripts(store, /widget/, {
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

    const { conversations: results } = grepTranscripts(store, /sprocket/, { projectsDirs: dirs });
    expect(results[0]!.cards).toHaveLength(0);
  });

  it('reports a file it could not open as unreadable, rather than as no match', () => {
    const store = makeStore();
    const config = mkdtempSync(path.join(tmpdir(), 'foster-grep-'));
    const dir = path.join(config, 'projects', '-workspace-project');
    mkdirSync(dir, { recursive: true });
    // A directory sitting where a transcript file is expected: `indexAllTranscripts`
    // only checks the `.jsonl` suffix, so this is treated as a candidate file, and
    // `readFileSync` on it throws EISDIR rather than ENOENT.
    mkdirSync(path.join(dir, `${CONVERSATION}.jsonl`));
    writeFileSync(
      path.join(dir, `${OTHER}.jsonl`),
      `${record('user', 'widget everywhere', '2026-09-01T00:00:00.000Z')}\n`,
      'utf8',
    );

    const { conversations: results, unreadable } = grepTranscripts(store, /widget/, {
      projectsDirs: [path.join(config, 'projects')],
    });

    expect(unreadable).toEqual([path.join(dir, `${CONVERSATION}.jsonl`)]);
    // The readable sibling still matches — one unreadable file must not sink
    // the whole search.
    expect(results).toHaveLength(1);
    expect(results[0]!.cliSessionId).toBe(OTHER);
  });

  it('stops at --limit conversations', () => {
    const store = makeStore();
    const dirs = transcripts({
      [CONVERSATION]: [record('user', 'widget one', '2026-09-01T00:00:00.000Z')],
      [OTHER]: [record('user', 'widget two', '2026-09-01T00:00:00.000Z')],
    });

    const { conversations: results } = grepTranscripts(store, /widget/, {
      projectsDirs: dirs,
      limit: 1,
    });
    expect(results).toHaveLength(1);
  });
});
