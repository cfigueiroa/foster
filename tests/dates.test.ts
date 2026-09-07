import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dateCards,
  planDates,
  requestsFromPlan,
  undoDateRequests,
  type DateCandidate,
} from '../src/engine/dates.js';
import { lineageAt } from '../src/engine/lineage.js';
import { Ledger } from '../src/ledger/log.js';
import { listDated, project } from '../src/ledger/project.js';
import { transcriptRoots } from '../src/store/transcripts.js';
import type { CodeSessionData } from '../src/domain/types.js';
import { NEW_ACCOUNT, makeStore, session, writeSession } from './helpers/store.js';

/**
 * #47: a card's `lastActivityAt` freezes the moment the app stops hosting the
 * conversation, while work done through the CLI keeps the transcript moving.
 * `planDates` is where "never move a date backwards" is enforced — it only
 * ever proposes advancing a card whose transcript answers later than the
 * card's own date — and `dateCards` is the same atomic-write/ledger-event/
 * dry-run/skip-when-unchanged discipline `retitleCards` already established
 * for a different field.
 */

const CARD = '00000000-0000-4000-8000-0000000000d1';
const CLI_ID = '00000000-0000-4000-8000-0000000000d2';
const T0 = 1_700_000_000_000;
const T1 = T0 + 3 * 60 * 60 * 1000;

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-dates-')), 'l.jsonl'));
}

function fixture(lastActivityAt: number | undefined = T0) {
  const store = makeStore();
  const file = writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: CARD, cliSessionId: CLI_ID, lastActivityAt, title: 'Work' }),
  );
  return { store, file, ledger: ledgerIn() };
}

function candidate(file: string, lastActivityAt: number | undefined): DateCandidate {
  return {
    path: file,
    sessionId: `local_${CARD}`,
    title: 'Work',
    target: NEW_ACCOUNT,
    native: true,
    lastActivityAt,
    cliSessionId: CLI_ID,
  };
}

function readCard(file: string): CodeSessionData {
  return JSON.parse(readFileSync(file, 'utf8')) as CodeSessionData;
}

/** An assistant record, the only kind `lastAssistantAt` counts. */
function assistantLine(at: number, uuid: string): string {
  return `${JSON.stringify({ type: 'assistant', uuid, timestamp: new Date(at).toISOString() })}\n`;
}

/** A single-file transcript whose last answer was written at `at`. */
function transcriptEnv(at: number, id = CLI_ID): NodeJS.ProcessEnv {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-dates-cfg-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.jsonl`), assistantLine(at, 'u1'), 'utf8');
  return { CLAUDE_CONFIG_DIR: config };
}

/**
 * One conversation occupying two files — a worktree's, whose last answer came
 * earlier, and the repository's, whose last answer came later — the shape
 * #40's union of `scanConversationFiles` exists to read correctly.
 */
function multiFileEnv(olderAt: number, newerAt: number, id = CLI_ID): NodeJS.ProcessEnv {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-dates-multi-'));
  const treeDir = path.join(config, 'projects', 'C--work-project--claude-worktrees-w');
  const repoDir = path.join(config, 'projects', 'C--work-project');
  mkdirSync(treeDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(treeDir, `${id}.jsonl`), assistantLine(olderAt, 't1'), 'utf8');
  writeFileSync(path.join(repoDir, `${id}.jsonl`), assistantLine(newerAt, 'r1'), 'utf8');
  return { CLAUDE_CONFIG_DIR: config };
}

function scanOfFor(env: NodeJS.ProcessEnv) {
  const kin = lineageAt(transcriptRoots(env));
  return (cliSessionId: string) => kin.scanOf(cliSessionId);
}

describe('planDates', () => {
  it('proposes advancing a card whose transcript is ahead of it', () => {
    const { file } = fixture(T0);
    const scanOf = scanOfFor(transcriptEnv(T1));

    const [item] = planDates([candidate(file, T0)], scanOf);
    expect(item).toMatchObject({ status: 'advance', from: T0, transcriptAt: T1 });
  });

  it('leaves a card alone that is already ahead of its transcript', () => {
    const { file } = fixture(T1);
    // The transcript's last answer is earlier than the card's own date — the
    // opposite of #47's bug, and not this tool's business to touch.
    const scanOf = scanOfFor(transcriptEnv(T0));

    const [item] = planDates([candidate(file, T1)], scanOf);
    expect(item).toMatchObject({ status: 'already-ahead', from: T1, transcriptAt: T0 });
  });

  it('reports no transcript rather than guessing', () => {
    const { file } = fixture(T0);
    const config = mkdtempSync(path.join(tmpdir(), 'foster-dates-empty-'));
    mkdirSync(path.join(config, 'projects'), { recursive: true });
    const scanOf = scanOfFor({ CLAUDE_CONFIG_DIR: config });

    const [item] = planDates([candidate(file, T0)], scanOf);
    expect(item!.status).toBe('no-transcript');
  });

  it('takes the later answer of a conversation held in two files (#40)', () => {
    const { file } = fixture(T0);
    // The worktree's file stopped soon after T0; the repository's file, which
    // the same conversation also occupies, kept going until T1.
    const scanOf = scanOfFor(multiFileEnv(T0 + 5_000, T1));

    const [item] = planDates([candidate(file, T0)], scanOf);
    expect(item).toMatchObject({ status: 'advance', transcriptAt: T1 });
  });
});

describe('dateCards', () => {
  it('advances a card to its transcript, and records what it wore before', () => {
    const { file, ledger } = fixture(T0);
    const scanOf = scanOfFor(transcriptEnv(T1));

    const items = planDates([candidate(file, T0)], scanOf);
    const [outcome] = dateCards(requestsFromPlan(items), { ledger });

    expect(outcome).toMatchObject({ status: 'dated', from: T0, to: T1 });
    expect(readCard(file).lastActivityAt).toBe(T1);

    const [event] = ledger.read();
    expect(event).toMatchObject({
      kind: 'card_dated',
      sessionId: `local_${CARD}`,
      from: T0,
      to: T1,
      native: true,
    });
    expect(listDated(project(ledger.read()))).toHaveLength(1);
  });

  it('running the plan again is a no-op', () => {
    const { file, ledger } = fixture(T0);
    const scanOf = scanOfFor(transcriptEnv(T1));

    const run = () =>
      dateCards(
        requestsFromPlan(planDates([candidate(file, readCard(file).lastActivityAt)], scanOf)),
        {
          ledger,
        },
      );

    const first = run();
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe('dated');

    const second = run();
    // The card now already wears T1, so the second plan calls it
    // already-ahead and never even builds a request for `dateCards` to see.
    expect(second).toHaveLength(0);
    expect(listDated(project(ledger.read()))).toHaveLength(1);
  });

  it('never writes a card that is already ahead of its transcript', () => {
    const { file, ledger } = fixture(T1);
    const scanOf = scanOfFor(transcriptEnv(T0));
    const before = readFileSync(file, 'utf8');

    const items = planDates([candidate(file, T1)], scanOf);
    const outcomes = dateCards(requestsFromPlan(items), { ledger });

    expect(outcomes).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(ledger.read()).toHaveLength(0);
  });

  it('writes nothing on a dry run, and still says what it would do', () => {
    const { file, ledger } = fixture(T0);
    const before = readFileSync(file, 'utf8');
    const scanOf = scanOfFor(transcriptEnv(T1));

    const items = planDates([candidate(file, T0)], scanOf);
    const [outcome] = dateCards(requestsFromPlan(items), { ledger, dryRun: true });

    expect(outcome).toMatchObject({ status: 'dated', from: T0, to: T1 });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(ledger.read()).toHaveLength(0);
  });

  it('fails a card it cannot read rather than inventing one', () => {
    const { store, ledger } = fixture(T0);
    const missing = path.join(store.codeSessionsDir, 'local_missing.json');

    const [outcome] = dateCards(
      [{ path: missing, target: NEW_ACCOUNT, native: true, lastActivityAt: T1 }],
      {
        ledger,
      },
    );

    expect(outcome!.status).toBe('failed');
    expect(ledger.read()).toHaveLength(0);
  });
});

describe('undoDateRequests', () => {
  it('puts the original lastActivityAt back, and drops the card from `dated`', () => {
    const { file, ledger } = fixture(T0);
    const scanOf = scanOfFor(transcriptEnv(T1));

    dateCards(requestsFromPlan(planDates([candidate(file, T0)], scanOf)), { ledger });

    const marked = listDated(project(ledger.read()));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ from: T0, to: T1 });

    dateCards(undoDateRequests(marked), { ledger });

    expect(readCard(file).lastActivityAt).toBe(T0);
    const events = ledger.read();
    const undo = events[events.length - 1];
    // `to === from` is exactly what the fold's own `back` check looks for —
    // the same shape `undoRetitleRequests` relies on.
    expect(undo).toMatchObject({ kind: 'card_dated', to: T0 });
    expect(listDated(project(events))).toHaveLength(0);
  });

  it('carries the original through repeated advances, then undoes to it', () => {
    const { file, ledger } = fixture(T0);

    dateCards(
      requestsFromPlan(planDates([candidate(file, T0)], scanOfFor(transcriptEnv(T0 + 60_000)))),
      {
        ledger,
      },
    );
    dateCards(
      requestsFromPlan(
        planDates([candidate(file, readCard(file).lastActivityAt)], scanOfFor(transcriptEnv(T1))),
      ),
      { ledger },
    );

    const marked = listDated(project(ledger.read()));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.from).toBe(T0);

    dateCards(undoDateRequests(marked), { ledger });

    expect(readCard(file).lastActivityAt).toBe(T0);
    expect(listDated(project(ledger.read()))).toHaveLength(0);
  });
});
