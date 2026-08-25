import { describe, expect, it } from 'vitest';
import type { ProcessRow } from '../src/engine/desktop.js';
import type { LiveCliSession } from '../src/store/liveSessions.js';
import { selectWriters, stopWriters } from '../src/ops/writers.js';

const ONE = '11111111-0000-4000-8000-00000000000a';
const TWO = '22222222-0000-4000-8000-00000000000b';

const RECORDED_AT = Date.parse('2026-08-24T20:45:00.000Z');
const WRITER_STARTED = RECORDED_AT - 2_000;

function writer(over: Partial<LiveCliSession> = {}): LiveCliSession {
  const pid = over.pid ?? 4242;
  return {
    registryFile: `C:\\reg\\${pid}.json`,
    pid,
    sessionId: ONE,
    cwd: 'D:\\work\\thing',
    identity: { pid, procStartedAt: WRITER_STARTED, recordedAt: RECORDED_AT },
    ...over,
  };
}

function process_(over: Partial<ProcessRow> & { pid: number }): ProcessRow {
  return {
    parentPid: 1,
    name: 'claude.exe',
    path: 'D:\\roaming\\Claude\\claude-code\\2.1.237\\claude.exe',
    commandLine: '',
    startedAt: WRITER_STARTED,
    ...over,
  };
}

/** Nothing here is running under a session, unless a case says it is. */
const NO_SESSION: NodeJS.ProcessEnv = {};

describe('selectWriters', () => {
  const sessions = [writer(), writer({ pid: 5353, sessionId: TWO })];

  it('resolves a prefix to one conversation, whatever case it is typed in', () => {
    expect(selectWriters(sessions, ['1111'])).toEqual([sessions[0]]);
    expect(selectWriters(sessions, [ONE.toUpperCase()])).toEqual([sessions[0]]);
  });

  it('refuses a prefix that matches nothing rather than ending nothing quietly', () => {
    expect(() => selectWriters(sessions, ['9999'])).toThrow(/No live session matches 9999/);
  });

  it('refuses an ambiguous prefix, and says where each candidate is', () => {
    // A short id typed for the session someone had in mind used to end the
    // others too, and a kill is not an operation anyone gets to take back.
    const ambiguous = [
      writer({ sessionId: 'aaaa1111-0000-4000-8000-00000000000c' }),
      writer({ pid: 6464, sessionId: 'aaaa2222-0000-4000-8000-00000000000d' }),
    ];

    expect(() => selectWriters(ambiguous, ['aaaa'])).toThrow(/matches 2 live sessions/);
    expect(() => selectWriters(ambiguous, ['aaaa'])).toThrow(/D:\\work\\thing/);
  });

  it('takes both writers when one conversation has two records', () => {
    // Two clients, one transcript: releasing it means both, not an error about
    // an ambiguity that is really one answer.
    const twice = [writer(), writer({ pid: 7373, registryFile: 'C:\\other\\7373.json' })];

    expect(selectWriters(twice, ['1111'])).toHaveLength(2);
  });

  it('names each conversation once however many prefixes reach it', () => {
    expect(selectWriters(sessions, ['1111', ONE])).toEqual([sessions[0]]);
  });
});

describe('stopWriters', () => {
  const rows = [process_({ pid: 4242 })];

  function run(sessions: LiveCliSession[], over: Partial<Parameters<typeof stopWriters>[1]> = {}) {
    const ended: number[] = [];
    const result = stopWriters(sessions, {
      apply: true,
      processes: () => rows,
      end: (pid) => ended.push(pid),
      alive: () => false,
      selfPid: 999,
      env: NO_SESSION,
      settleMs: 0,
      ...over,
    });
    return { result, ended };
  }

  it('ends a writer it has identified, and waits for the pid to stop answering', async () => {
    const { result, ended } = run([writer()]);

    expect((await result).map((r) => r.outcome)).toEqual(['ended']);
    expect(ended).toEqual([4242]);
  });

  it('reports a kill that was asked for and did not take', async () => {
    // taskkill returns when termination has been requested, not when it has
    // happened, and a process that keeps answering has to be said out loud.
    const { result } = run([writer()], { alive: () => true });

    expect((await result).map((r) => r.outcome)).toEqual(['still-running']);
  });

  it('kills nothing without apply', async () => {
    const { result, ended } = run([writer()], { apply: false });

    expect((await result).map((r) => r.outcome)).toEqual(['would-end']);
    expect(ended).toEqual([]);
  });

  it('refuses the session foster is running in, on the session id it was given', async () => {
    // The ancestry walk cannot answer this one: the table below has no link from
    // foster to the writer at all, which is what a chain through an exited shell
    // looks like.
    const { result, ended } = run([writer()], {
      env: { CLAUDE_CODE_SESSION_ID: ONE.toUpperCase() },
      processes: () => [process_({ pid: 4242 }), process_({ pid: 999, parentPid: 1 })],
    });

    expect((await result).map((r) => r.outcome)).toEqual(['refused-self']);
    expect(ended).toEqual([]);
  });

  it('refuses it on the pid when the session id was not exported', async () => {
    const { result, ended } = run([writer()], { env: { CLAUDE_PID: '4242' } });

    expect((await result).map((r) => r.outcome)).toEqual(['refused-self']);
    expect(ended).toEqual([]);
  });

  it('does not mistake another conversation for this one', async () => {
    const { result, ended } = run([writer()], { env: { CLAUDE_CODE_SESSION_ID: TWO } });

    expect((await result).map((r) => r.outcome)).toEqual(['ended']);
    expect(ended).toEqual([4242]);
  });

  it('still refuses the session it descends from when nothing marked it', async () => {
    // foster under the writer, one link apart. The walk is the only evidence
    // here, and it is enough while every process in the chain is alive.
    const tree = [
      process_({ pid: 4242 }),
      process_({ pid: 77, parentPid: 4242, name: 'node.exe' }),
    ];
    const { result, ended } = run([writer()], { processes: () => tree, selfPid: 77 });

    expect((await result).map((r) => r.outcome)).toEqual(['refused-self']);
    expect(ended).toEqual([]);
  });

  it('refuses a pid that is no longer the process the record named', async () => {
    // The kill is taskkill /F /T. Against a recycled pid it takes a stranger's
    // process and every child it has.
    const recycled = [
      process_({ pid: 4242, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 43_200_000 }),
    ];
    const { result, ended } = run([writer()], { processes: () => recycled });

    const [only] = await result;
    expect(only?.outcome).toBe('refused-unidentified');
    expect(only?.reason).toContain('postgres.exe');
    expect(ended).toEqual([]);
  });

  it('refuses in a dry run too, so the plan is the truth', async () => {
    const recycled = [
      process_({ pid: 4242, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 43_200_000 }),
    ];
    const { result } = run([writer()], { apply: false, processes: () => recycled });

    expect((await result).map((r) => r.outcome)).toEqual(['refused-unidentified']);
  });

  it('refuses what it cannot identify at all', async () => {
    const { result, ended } = run([writer()], { processes: () => [] });

    const [only] = await result;
    expect(only?.outcome).toBe('refused-unidentified');
    expect(ended).toEqual([]);
  });

  it('goes on to the next writer after a refusal', async () => {
    const sessions = [writer({ pid: 4242 }), writer({ pid: 5353, sessionId: TWO })];
    const table = [
      process_({ pid: 4242, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 43_200_000 }),
      process_({ pid: 5353 }),
    ];
    const { result, ended } = run(sessions, { processes: () => table });

    expect((await result).map((r) => r.outcome)).toEqual(['refused-unidentified', 'ended']);
    expect(ended).toEqual([5353]);
  });
});
