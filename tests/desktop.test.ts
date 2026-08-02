import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  inspectDesktop,
  packagedAppId,
  parseProcessCsv,
  quitDesktop,
  type ProcessRow,
} from '../src/engine/desktop.js';
import { heldInMemory } from '../src/engine/safety.js';
import { layoutFor } from '../src/domain/paths.js';
import type { StoreLayout } from '../src/domain/types.js';
import type { ActiveFostering } from '../src/ledger/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

const DESKTOP = 'C:\\Program Files\\WindowsApps\\Claude_0.0.0.0_x64__test\\app\\Claude.exe';
// Not under a C:\Users\<name> path: this repo is public, and CI rejects anything
// that looks like somebody's home directory.
const CLI = 'C:\\home\\AppData\\Roaming\\Claude\\claude-code\\1.0.0\\claude.exe';

function rows(...entries: Partial<ProcessRow>[]): ProcessRow[] {
  return entries.map((entry, index) => ({
    pid: 100 + index,
    parentPid: 1,
    name: 'claude.exe',
    path: DESKTOP,
    ...entry,
  }));
}

describe('parseProcessCsv', () => {
  it('reads the fields PowerShell quotes', () => {
    const csv = [
      '"ProcessId","ParentProcessId","Name","ExecutablePath","Started"',
      '"4340","10568","Claude.exe","C:\\Apps\\Claude.exe","2026-08-01T23:08:31.0000000Z"',
    ].join('\r\n');

    expect(parseProcessCsv(csv)).toEqual([
      {
        pid: 4340,
        parentPid: 10568,
        name: 'Claude.exe',
        path: 'C:\\Apps\\Claude.exe',
        startedAt: Date.parse('2026-08-01T23:08:31.000Z'),
      },
    ]);
  });

  it('keeps a row whose path contains a comma', () => {
    const csv = [
      '"ProcessId","ParentProcessId","Name","ExecutablePath","Started"',
      '"7","1","x.exe","C:\\Program Files\\a, b\\x.exe",""',
    ].join('\n');

    const [row] = parseProcessCsv(csv);
    expect(row!.path).toBe('C:\\Program Files\\a, b\\x.exe');
    expect(row!.startedAt).toBeUndefined();
  });

  it('skips rows that are not processes', () => {
    const csv = '"ProcessId","ParentProcessId","Name","ExecutablePath","Started"\n"","","","",""';
    expect(parseProcessCsv(csv)).toEqual([]);
  });
});

describe('inspectDesktop', () => {
  it('reports not running when no desktop process exists', () => {
    expect(inspectDesktop(() => [])).toMatchObject({ running: false, codeSessions: 0 });
  });

  it('picks the process nothing in the app spawned as the main one', () => {
    const table = rows(
      { pid: 500, parentPid: 9 },
      { pid: 501, parentPid: 500 },
      { pid: 502, parentPid: 500 },
    );

    expect(inspectDesktop(() => table).mainPid).toBe(500);
  });

  it('counts the Code sessions the app is hosting, and only those', () => {
    const table = rows(
      { pid: 500, parentPid: 9 },
      { pid: 501, parentPid: 500, path: CLI },
      { pid: 502, parentPid: 500, path: CLI },
      // A CLI started from a plain terminal is nobody's business here.
      { pid: 503, parentPid: 9, path: CLI },
      { pid: 504, parentPid: 500 },
    );

    expect(inspectDesktop(() => table).codeSessions).toBe(2);
  });

  it('never mistakes a Code CLI for the app itself', () => {
    // Both executables are called claude.exe; only the path separates them.
    const table = rows({ pid: 700, parentPid: 9, path: CLI });
    expect(inspectDesktop(() => table, {})).toMatchObject({ running: false });
  });

  it('detects that foster is running inside the app it would close', () => {
    const table = rows(
      { pid: 500, parentPid: 9 },
      { pid: 501, parentPid: 500, path: CLI },
      { pid: process.pid, parentPid: 501, name: 'node.exe', path: 'C:\\node.exe' },
    );

    expect(inspectDesktop(() => table, {}).selfHosted).toBe(true);
  });

  it('trusts the hosted-session marker when the parent chain is broken', () => {
    // An exited intermediate orphans the process, so ancestry alone says nothing.
    const table = rows(
      { pid: 500, parentPid: 9 },
      { pid: process.pid, parentPid: 41_000, name: 'node.exe', path: 'C:\\node.exe' },
    );

    expect(inspectDesktop(() => table, { CLAUDE_CODE_HOST_SESSION_ID: 'local_x' }).selfHosted).toBe(
      true,
    );
  });

  it('still refuses when the app is not in the process table but hosts this process', () => {
    expect(inspectDesktop(() => [], { CLAUDE_CODE_HOST_SESSION_ID: 'local_x' })).toMatchObject({
      running: false,
      selfHosted: true,
    });
  });

  it('does not follow a recycled pid up into a younger parent', () => {
    // The pid the child records was reused by a process started afterwards, so
    // the chain is a coincidence rather than a lineage.
    const table = rows(
      { pid: 500, parentPid: 9, startedAt: 5_000 },
      {
        pid: process.pid,
        parentPid: 500,
        name: 'node.exe',
        path: 'C:\\node.exe',
        startedAt: 1_000,
      },
    );

    expect(inspectDesktop(() => table, {}).selfHosted).toBe(false);
  });
});

describe('packagedAppId', () => {
  it('derives the launch identity from the store path', () => {
    const store = layoutFor(
      'C:\\home\\AppData\\Local\\Packages\\Claude_abc123\\LocalCache\\Roaming\\Claude',
    );
    expect(packagedAppId(store)).toBe('Claude_abc123!Claude');
  });

  it('has no answer for a store outside an app package', () => {
    expect(packagedAppId(layoutFor('C:\\home\\AppData\\Roaming\\Claude'))).toBeUndefined();
  });
});

describe('heldInMemory', () => {
  const fostering = (fosteredAt: number): ActiveFostering => ({
    originSessionId: 'local_a',
    origin: OLD_ACCOUNT,
    target: NEW_ACCOUNT,
    copySessionId: 'local_b',
    copyPath: 'C:\\copy.json',
    fosteredAt,
  });

  it('holds nothing when the app is not running', () => {
    expect(
      heldInMemory([fostering(1)], { running: false, codeSessions: 0, selfHosted: false }),
    ).toHaveLength(0);
  });

  it('holds only copies that already existed when the app started', () => {
    const desktop = { running: true, startedAt: 500, codeSessions: 0, selfHosted: false };
    const older = fostering(100);
    const newer = fostering(900);

    expect(heldInMemory([older, newer], desktop)).toEqual([older]);
  });

  it('assumes the worst when the start time is unknown', () => {
    const desktop = { running: true, codeSessions: 0, selfHosted: false };
    expect(heldInMemory([fostering(100)], desktop)).toHaveLength(1);
  });
});

describe('quitDesktop', () => {
  // Not a pid Windows can issue: these cases reach taskkill, and a plausible
  // number would mean signalling whatever real process happened to hold it.
  const PID = 999_999;
  const table = (): ProcessRow[] => rows({ pid: PID, parentPid: 9 });
  // The suite itself runs inside a hosted Code session, so the environment has to
  // be stated rather than inherited — otherwise every case below would hit the
  // self-host refusal instead of the behaviour under test.
  const outside: NodeJS.ProcessEnv = {};

  function storeWith(config: Record<string, unknown>): StoreLayout {
    const store = makeStore();
    writeFileSync(store.configFile, JSON.stringify(config), 'utf8');
    return store;
  }

  it('says nothing to do when the app is not running', async () => {
    const result = await quitDesktop(storeWith({}), { list: () => [], env: outside });
    expect(result.outcome).toBe('not-running');
  });

  it('refuses to close the app it is running inside', async () => {
    await expect(
      quitDesktop(storeWith({}), {
        list: table,
        terminate: true,
        env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_x' },
      }),
    ).rejects.toThrow(/running inside/);
  });

  it('will not ask a tray-backed app to close, because asking only hides it', async () => {
    // The default is no menuBarEnabled key at all. Posting WM_CLOSE here would
    // make the user's window vanish and leave the process up — strictly worse
    // than doing nothing, which is why this reports instead of trying.
    const result = await quitDesktop(storeWith({ locale: 'en-US' }), {
      list: table,
      env: outside,
    });

    expect(result).toEqual({ outcome: 'needs-terminate', mainPid: PID });
  });

  it('treats the tray being switched off as permission to ask', async () => {
    // With the tray off the window's close handler really does quit the app, so a
    // polite route exists and this must not report needs-terminate.
    const result = await quitDesktop(storeWith({ menuBarEnabled: false }), {
      list: table,
      env: outside,
      timeoutMs: 1,
    });

    expect(result.outcome).not.toBe('needs-terminate');
  });
});
