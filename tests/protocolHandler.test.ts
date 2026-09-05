import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  armedCommand,
  inspectHandler,
  parseHandler,
  planLogin,
  restoreHandler,
  runLogin,
  type HandlerIo,
  type LoginPlan,
} from '../src/engine/protocolHandler.js';
import { project } from '../src/ledger/project.js';
import type { LedgerEvent, LedgerEventInput } from '../src/ledger/types.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import { makeStore } from './helpers/store.js';

// Not a real machine path (this repo is public) — the same shape the registry
// actually holds: a quoted exe followed by a quoted argument.
const EXE = 'C:\\home\\AppData\\Local\\Packages\\Claude_0.0.0.0_x64__test\\app\\Claude.exe';
const PLAIN_HANDLER = `"${EXE}" "%1"`;

/** An in-memory HandlerIo. `log`, when given, records `write:<value>` in order. */
function fakeIo(initial: string | undefined, log?: string[]): HandlerIo {
  let value = initial;
  return {
    read: () => ({ value }),
    write: (next: string) => {
      log?.push(`write:${next}`);
      value = next;
    },
  };
}

/** A HandlerIo whose read() always reports a spawn failure, never a value. */
function brokenIo(error: string): HandlerIo {
  return {
    read: () => ({ error }),
    write: () => {
      throw new Error('not reached: write is never called once read fails');
    },
  };
}

function fakeAppend(log: string[]): (event: LedgerEventInput) => void {
  return (event) => log.push(`append:${event.kind}`);
}

describe('parseHandler', () => {
  it('parses a plain handler', () => {
    expect(parseHandler(PLAIN_HANDLER)).toEqual({ exe: EXE, raw: PLAIN_HANDLER });
  });

  it('parses an unquoted --user-data-dir', () => {
    const command = `"${EXE}" --user-data-dir=D:\\Claude-Work "%1"`;
    expect(parseHandler(command)).toEqual({
      exe: EXE,
      userDataDir: 'D:\\Claude-Work',
      raw: command,
    });
  });

  it('parses a quoted --user-data-dir', () => {
    const command = `"${EXE}" --user-data-dir="D:\\Claude Work" "%1"`;
    expect(parseHandler(command)).toEqual({
      exe: EXE,
      userDataDir: 'D:\\Claude Work',
      raw: command,
    });
  });

  it('returns undefined for anything else', () => {
    expect(parseHandler(undefined)).toBeUndefined();
    expect(parseHandler('')).toBeUndefined();
    expect(parseHandler('not a handler at all')).toBeUndefined();
    expect(parseHandler(`"${EXE}"`)).toBeUndefined();
  });
});

describe('armedCommand', () => {
  it('quotes a spelling that contains a space', () => {
    expect(armedCommand(EXE, 'D:\\Claude Work')).toBe(
      `"${EXE}" --user-data-dir="D:\\Claude Work" "%1"`,
    );
  });

  it('leaves a spelling with no space unquoted', () => {
    expect(armedCommand(EXE, 'D:\\Claude-Work')).toBe(
      `"${EXE}" --user-data-dir=D:\\Claude-Work "%1"`,
    );
  });
});

describe('planLogin', () => {
  // Empty, not inherited: the suite runs on a real machine, and a real
  // LOCALAPPDATA/APPDATA would make storeIdentity see this test's synthetic
  // store as (or through) the real installation.
  const NO_ENV: NodeJS.ProcessEnv = {};

  it('refuses off Windows', () => {
    const store = makeStore();
    const plan = planLogin(store, {
      io: fakeIo(PLAIN_HANDLER),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'linux',
    });

    expect(plan.blockers).toEqual([
      'the claude:// handler is a Windows registry key; there is nothing to route elsewhere',
    ]);
  });

  it('refuses when the key is missing', () => {
    const store = makeStore();
    const plan = planLogin(store, {
      io: fakeIo(undefined),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain('is missing or not in the shape');
  });

  it('refuses when the key is unparseable', () => {
    const store = makeStore();
    const plan = planLogin(store, {
      io: fakeIo('not a handler at all'),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain('is missing or not in the shape');
  });

  it("refuses with reg's own message when reg itself could not be run", () => {
    // The reported case: an elevated PowerShell whose PATH does not resolve
    // `reg`, so the spawn throws before it ever touches the registry. That
    // must not read as "the key is missing" — start Claude Desktop once would
    // do nothing for a PATH problem.
    const store = makeStore();
    const plan = planLogin(store, {
      io: brokenIo('spawnSync reg ENOENT'),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain(
      'could not read HKCU\\Software\\Classes\\claude\\shell\\open\\command',
    );
    expect(plan.blockers[0]).toContain('spawnSync reg ENOENT');
    expect(plan.blockers[0]).not.toContain('is missing or not in the shape');
  });

  it('refuses when claude:// already routes to a different profile', () => {
    const store = makeStore();
    const command = `"${EXE}" --user-data-dir=D:\\Claude-Other "%1"`;
    const plan = planLogin(store, {
      io: fakeIo(command),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain('already routed to D:\\Claude-Other');
    expect(plan.blockers[0]).toContain('foster app login --restore');
    expect(plan.armed).toBeUndefined();
  });

  it('only warns when the handler is already routed to this same store', () => {
    const store = makeStore();
    const command = `"${EXE}" --user-data-dir="${store.root}" "%1"`;
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: store.root,
        previous: PLAIN_HANDLER,
        exe: EXE,
        armed: command,
      },
    ];
    const plan = planLogin(store, {
      io: fakeIo(command),
      events,
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('already routed'))).toBe(true);
    expect(plan.armed).toBe(command);
    expect(plan.previous).toBe(PLAIN_HANDLER);
  });

  it('rebuilds previous from the exe when routed to this same store but the ledger has no record', () => {
    // No `handler_armed` event — a reset/relocated FOSTER_HOME, or the key
    // pointed at this store's directory by something other than a tracked
    // foster run. `plan.previous` must still be a real value: runLogin would
    // otherwise default it to an empty string and wipe the handler on restore.
    const store = makeStore();
    const command = `"${EXE}" --user-data-dir="${store.root}" "%1"`;
    const plan = planLogin(store, {
      io: fakeIo(command),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.armed).toBe(command);
    expect(plan.previous).toBe(`"${EXE}" "%1"`);
  });

  it('refuses the installed app itself', () => {
    const store = makeStore();
    const plan = planLogin(store, {
      io: fakeIo(PLAIN_HANDLER),
      // The same trick paths.test.ts uses to make a synthetic store answer as
      // the default installation: CLAUDE_USER_DATA_DIR is one of the paths
      // storeIdentity treats as naming it.
      env: { CLAUDE_USER_DATA_DIR: store.root },
      events: [],
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers.some((b) => b.includes('app login is for a second profile'))).toBe(true);
  });

  it('warns when the profile already holds a token cache', () => {
    const store = makeStore();
    writeFileSync(
      store.configFile,
      JSON.stringify({
        lastKnownAccountUuid: '00000000-0000-4000-8000-00000000000a',
        'oauth:tokenCacheV2': 'opaque',
      }),
      'utf8',
    );
    const plan = planLogin(store, {
      io: fakeIo(PLAIN_HANDLER),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.signedInBefore).toBe(true);
    expect(plan.accountBefore).toBe('00000000-0000-4000-8000-00000000000a');
    expect(plan.warnings.some((w) => w.includes('already holds a token cache'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('00000000-0000-4000-8000-00000000000a'))).toBe(
      true,
    );
  });

  it('takes the spelling from a running instance of this store', () => {
    const store = makeStore();
    const row: ProcessRow = {
      pid: 500,
      parentPid: 9,
      name: 'claude.exe',
      path: EXE,
      commandLine: `"${EXE}" --user-data-dir="${store.root}\\"`,
    };
    const plan = planLogin(store, {
      io: fakeIo(PLAIN_HANDLER),
      events: [],
      env: NO_ENV,
      list: () => [row],
      platform: 'win32',
    });

    expect(plan.spelling).toBe(`${store.root}\\`);
  });

  it('falls back to the store root when nothing is running', () => {
    const store = makeStore();
    const plan = planLogin(store, {
      io: fakeIo(PLAIN_HANDLER),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.spelling).toBe(store.root);
  });
});

describe('runLogin', () => {
  const account = '00000000-0000-4000-8000-00000000000a';

  function basePlan(overrides: Partial<LoginPlan> = {}): LoginPlan {
    return {
      root: 'D:\\Claude-Work',
      running: true,
      signedInBefore: false,
      spelling: 'D:\\Claude-Work',
      exe: EXE,
      previous: PLAIN_HANDLER,
      armed: `"${EXE}" --user-data-dir=D:\\Claude-Work "%1"`,
      blockers: [],
      warnings: [],
      ...overrides,
    };
  }

  it('refuses a plan carrying blockers', async () => {
    const plan = basePlan({ blockers: ['nope'] });
    await expect(
      runLogin(plan, {
        io: fakeIo(undefined),
        append: () => {},
        readState: () => ({ hasTokenCache: false }),
      }),
    ).rejects.toThrow('nope');
  });

  it('appends handler_armed before writing the key', async () => {
    const log: string[] = [];
    const plan = basePlan();
    const io = fakeIo(plan.previous, log);

    await runLogin(plan, {
      io,
      append: fakeAppend(log),
      readState: () => ({ hasTokenCache: true, accountUuid: account }),
      now: () => 0,
      sleep: async () => {},
    });

    expect(log[0]).toBe('append:handler_armed');
    expect(log[1]).toBe(`write:${plan.armed}`);
  });

  it('restores verbatim and records the account on success', async () => {
    const plan = basePlan();
    const log: string[] = [];
    const io = fakeIo(plan.previous, log);
    let calls = 0;
    const readState = () => {
      calls += 1;
      return calls < 2 ? { hasTokenCache: false } : { hasTokenCache: true, accountUuid: account };
    };

    const result = await runLogin(plan, {
      io,
      append: fakeAppend(log),
      readState,
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.outcome).toBe('signed-in');
    expect(result.accountAfter).toBe(account);
    expect(result.restored).toBe(true);
    expect(io.read().value).toBe(plan.previous);
    expect(log.filter((l) => l.startsWith('write:'))).toEqual([
      `write:${plan.armed}`,
      `write:${plan.previous}`,
    ]);
    expect(log.at(-1)).toBe('append:handler_restored');
  });

  it('restores on timeout', async () => {
    const plan = basePlan();
    const io = fakeIo(plan.previous);
    let t = 0;
    const now = () => t;
    const sleep = async () => {
      t += 10_000;
    };

    const result = await runLogin(plan, {
      io,
      append: () => {},
      readState: () => ({ hasTokenCache: false }),
      timeoutMs: 1_000,
      now,
      sleep,
    });

    expect(result.outcome).toBe('timeout');
    expect(result.restored).toBe(true);
    expect(io.read().value).toBe(plan.previous);
  });

  it('restores when aborted', async () => {
    const plan = basePlan();
    const io = fakeIo(plan.previous);
    const controller = new AbortController();
    controller.abort();

    const result = await runLogin(plan, {
      io,
      append: () => {},
      readState: () => ({ hasTokenCache: false }),
      signal: controller.signal,
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.outcome).toBe('aborted');
    expect(result.restored).toBe(true);
    expect(io.read().value).toBe(plan.previous);
  });

  it('stops without writing when the handler is rewritten underneath it', async () => {
    const plan = basePlan();
    const writes: string[] = [];
    let reads = 0;
    let value: string | undefined;
    const io: HandlerIo = {
      read: () => {
        reads += 1;
        // The very next read after the arm-write is runLogin's own
        // verification that the write landed; only after that does this
        // fixture pretend the app restarted and rewrote the key.
        return { value: reads <= 1 ? value : 'rewritten-by-app' };
      },
      write: (next) => {
        writes.push(next);
        value = next;
      },
    };

    const result = await runLogin(plan, {
      io,
      append: () => {},
      readState: () => ({ hasTokenCache: false }),
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.outcome).toBe('handler-rewritten');
    expect(result.restored).toBe(false);
    expect(writes).toEqual([plan.armed]);
  });
});

describe('restoreHandler', () => {
  it('says there is nothing to restore when the handler carries no --user-data-dir', () => {
    const io = fakeIo(PLAIN_HANDLER);
    const result = restoreHandler(project([]), io, () => {});

    expect(result).toEqual({ ok: false, message: expect.stringContaining('nothing to restore') });
  });

  it('restores from the ledger record', () => {
    const command = `"${EXE}" --user-data-dir=D:\\Claude-Work "%1"`;
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: 'D:\\Claude-Work',
        previous: PLAIN_HANDLER,
        exe: EXE,
        armed: command,
      },
    ];
    const io = fakeIo(command);
    const appended: LedgerEventInput[] = [];

    const result = restoreHandler(project(events), io, (e) => appended.push(e));

    expect(result.ok).toBe(true);
    expect(io.read().value).toBe(PLAIN_HANDLER);
    expect(appended).toEqual([
      { kind: 'handler_restored', root: 'D:\\Claude-Work', restored: true },
    ]);
  });

  it('rebuilds a plain handler from the exe when the ledger has no record', () => {
    const command = `"${EXE}" --user-data-dir=D:\\Claude-Work "%1"`;
    const io = fakeIo(command);
    const appended: LedgerEventInput[] = [];

    const result = restoreHandler(project([]), io, (e) => appended.push(e));

    expect(result.ok).toBe(true);
    expect(result.message).toContain('rebuilt');
    expect(io.read().value).toBe(PLAIN_HANDLER);
    expect(appended).toEqual([
      { kind: 'handler_restored', root: 'D:\\Claude-Work', restored: true },
    ]);
  });
});

describe('inspectHandler', () => {
  it('reports the current parsed handler and nothing armed', () => {
    const state = inspectHandler(project([]), fakeIo(PLAIN_HANDLER));
    expect(state.current).toEqual({ exe: EXE, raw: PLAIN_HANDLER });
    expect(state.armed).toBeUndefined();
  });

  it('reports what the ledger says is armed', () => {
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: 'D:\\Claude-Work',
        previous: PLAIN_HANDLER,
        exe: EXE,
        armed: `"${EXE}" --user-data-dir=D:\\Claude-Work "%1"`,
      },
    ];
    const state = inspectHandler(project(events), fakeIo(undefined));
    expect(state.armed).toEqual({
      root: 'D:\\Claude-Work',
      previous: PLAIN_HANDLER,
      at: 1_700_000_000_000,
    });
  });
});
