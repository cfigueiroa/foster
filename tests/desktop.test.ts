import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  inspectDesktop,
  inspectDesktopFor,
  packagedAppId,
  parseProcessCsv,
  quitDesktop,
  runningStores,
  startDesktop,
  desktopExecutable,
  deliverUrl,
  type ProcessRow,
} from '../src/engine/desktop.js';
import { heldInMemory, inspectApp } from '../src/engine/safety.js';
import { layoutFor, storeIdentity } from '../src/domain/paths.js';
import type { StoreLayout } from '../src/domain/types.js';
import type { ActiveFostering } from '../src/ledger/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

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
    commandLine: `"${DESKTOP}"`,
    ...entry,
  }));
}

describe('parseProcessCsv', () => {
  it('reads the fields PowerShell quotes', () => {
    const csv = [
      '"ProcessId","ParentProcessId","Name","ExecutablePath","CommandLine","Started"',
      '"4340","10568","Claude.exe","C:\\Apps\\Claude.exe","""C:\\Apps\\Claude.exe""","2026-08-01T23:08:31.0000000Z"',
    ].join('\r\n');

    expect(parseProcessCsv(csv)).toEqual([
      {
        pid: 4340,
        parentPid: 10568,
        name: 'Claude.exe',
        path: 'C:\\Apps\\Claude.exe',
        commandLine: '"C:\\Apps\\Claude.exe"',
        startedAt: Date.parse('2026-08-01T23:08:31.000Z'),
      },
    ]);
  });

  it('keeps a row whose path contains a comma', () => {
    const csv = [
      '"ProcessId","ParentProcessId","Name","ExecutablePath","CommandLine","Started"',
      '"7","1","x.exe","C:\\Program Files\\a, b\\x.exe","x.exe --flag=a,b",""',
    ].join('\n');

    const [row] = parseProcessCsv(csv);
    expect(row!.path).toBe('C:\\Program Files\\a, b\\x.exe');
    expect(row!.commandLine).toBe('x.exe --flag=a,b');
    expect(row!.startedAt).toBeUndefined();
  });

  it('skips rows that are not processes', () => {
    const csv =
      '"ProcessId","ParentProcessId","Name","ExecutablePath","CommandLine","Started"\n"","","","","",""';
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

describe('inspectApp', () => {
  /**
   * The cheap check reads a lockfile inside the store, plus a process name. Only
   * the first is about that store: with the installed app up, the process name
   * made every profile look busy, and an undo in a closed profile asked the user
   * to close an app that was not running.
   */
  it('does not let another installation make a closed profile look busy', () => {
    // A temp store: no lockfile, and nothing in this environment resolves to it.
    // Whatever is running on the machine, this store is not it.
    expect(inspectApp(makeStore(), {})).toEqual({ running: false, evidence: [] });
  });
});

describe('quitDesktop', () => {
  // Not a pid Windows can issue: these cases reach taskkill, and a plausible
  // number would mean signalling whatever real process happened to hold it.
  const PID = 999_999;
  // The instance has to name the store under test. These stores are temp
  // directories, never the installed app, so a switchless process would belong
  // to the default installation and rightly be ignored.
  const table = (root: string) => (): ProcessRow[] =>
    rows({ pid: PID, parentPid: 9, commandLine: `"Claude.exe" --user-data-dir="${root}"` });
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
    const store = storeWith({});
    await expect(
      quitDesktop(store, {
        list: table(store.root),
        terminate: true,
        env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_x' },
      }),
    ).rejects.toThrow(/running inside/);
  });

  it('will not ask a tray-backed app to close, because asking only hides it', async () => {
    // The default is no menuBarEnabled key at all. Posting WM_CLOSE here would
    // make the user's window vanish and leave the process up — strictly worse
    // than doing nothing, which is why this reports instead of trying.
    const store = storeWith({ locale: 'en-US' });
    const result = await quitDesktop(store, {
      list: table(store.root),
      env: outside,
    });

    expect(result).toEqual({ outcome: 'needs-terminate', mainPid: PID });
  });

  it('treats the tray being switched off as permission to ask', async () => {
    // With the tray off the window's close handler really does quit the app, so a
    // polite route exists and this must not report needs-terminate.
    const store = storeWith({ menuBarEnabled: false });
    const result = await quitDesktop(store, {
      list: table(store.root),
      env: outside,
      timeoutMs: 1,
    });

    expect(result.outcome).not.toBe('needs-terminate');
  });
});

describe('which instance foster is running inside', () => {
  /**
   * The hosted-session marker says foster is inside *an* instance, not which one.
   * Left global it made every store refuse: `--store <profile> app restart`
   * declined to close a profile foster was demonstrably not inside. The instance
   * that stamped the marker is the one holding that session file, so the file
   * settles it.
   */
  const HOSTED = 'local_00000000-0000-4000-8000-0000000000c1';

  function hostStore(): StoreLayout {
    const store = makeStore();
    writeSession(store, NEW_ACCOUNT, session({ sessionId: HOSTED }));
    return store;
  }

  const instanceOn = (root: string): ProcessRow[] =>
    rows({ pid: 500, parentPid: 9, commandLine: `"Claude.exe" --user-data-dir="${root}"` });

  it('refuses for the installation that holds the session hosting it', () => {
    const host = hostStore();
    const env = { CLAUDE_CODE_HOST_SESSION_ID: HOSTED, CLAUDE_USER_DATA_DIR: host.root };

    const state = inspectDesktopFor(
      storeIdentity(host.root, env),
      () => instanceOn(host.root),
      env,
    );
    expect(state.selfHosted).toBe(true);
  });

  it('does not refuse for another installation running beside it', () => {
    const host = hostStore();
    const other = makeStore();
    const env = { CLAUDE_CODE_HOST_SESSION_ID: HOSTED, CLAUDE_USER_DATA_DIR: host.root };

    const state = inspectDesktopFor(
      storeIdentity(other.root, env),
      () => instanceOn(other.root),
      env,
    );
    expect(state.selfHosted).toBe(false);
  });

  it('keeps refusing when no store admits to holding the session', () => {
    // Deleted mid-session, say. Over-refusing costs a manual restart; the other
    // way round kills the process asking.
    const other = makeStore();
    const env = { CLAUDE_CODE_HOST_SESSION_ID: HOSTED };

    const state = inspectDesktopFor(
      storeIdentity(other.root, env),
      () => instanceOn(other.root),
      env,
    );
    expect(state.selfHosted).toBe(true);
  });
});

describe('starting the app', () => {
  /**
   * A profile is the same application on another userData, so it has no
   * application id to activate — and activating the installed one would start the
   * very installation the profile exists to sit beside. It is started by running
   * the executable with the switch instead.
   */
  const EXE = 'C:\\Apps\\Claude_1.0.0_x64__test\\app\\Claude.exe';
  const PACKAGED = layoutFor(
    'C:\\home\\AppData\\Local\\Packages\\Claude_abc123\\LocalCache\\Roaming\\Claude',
  );

  it('activates the installed app by its application id', async () => {
    const activated: string[] = [];
    await startDesktop(PACKAGED, {
      timeoutMs: 1,
      launch: (appId) => activated.push(appId),
      launchProfile: () => expect.unreachable('a packaged store is not a profile'),
    });

    expect(activated).toEqual(['Claude_abc123!Claude']);
  });

  it('runs the executable with the switch for a profile', async () => {
    const store = makeStore();
    const started: string[][] = [];
    await startDesktop(store, {
      timeoutMs: 1,
      launch: () => expect.unreachable('a profile has no application id to activate'),
      launchProfile: (exe, root) => started.push([exe, root]),
      executable: () => EXE,
    });

    expect(started).toEqual([[EXE, store.root]]);
  });

  it('says so plainly when there is no installed app to start a profile with', async () => {
    await expect(
      startDesktop(makeStore(), { timeoutMs: 1, executable: () => undefined }),
    ).rejects.toThrow(/Start it yourself/);
  });
});

describe('handing a link to one installation', () => {
  /**
   * Windows routes claude:// to the installed package, so a profile never
   * receives its own sign-in callback. The registration is a plain executable
   * with the URL as an argument, and a second invocation carrying the same
   * --user-data-dir forwards its argv to the instance holding that profile.
   */
  const EXE = 'C:\\Apps\\Claude\\app\\Claude.exe';

  it('runs the executable with the profile switch and the link', () => {
    const store = makeStore();
    const calls: Array<[string, string[]]> = [];

    deliverUrl(store, 'claude://resume?id=abc', {
      executable: () => EXE,
      launch: (exe, args) => calls.push([exe, args]),
    });

    expect(calls).toEqual([[EXE, [`--user-data-dir=${store.root}`, 'claude://resume?id=abc']]]);
  });

  it('refuses anything that is not a claude:// link', () => {
    // This is a way to reach one instance, not a way to make foster run things.
    const launched: string[] = [];
    const attempt = () =>
      deliverUrl(makeStore(), 'https://example.com', {
        executable: () => EXE,
        launch: (exe) => launched.push(exe),
      });

    expect(attempt).toThrow(/Only claude:\/\/ links/);
    expect(launched).toEqual([]);
  });

  it('says so when there is no executable to hand it to', () => {
    expect(() => deliverUrl(makeStore(), 'claude://x', { executable: () => undefined })).toThrow(
      /Could not find the Claude Desktop executable/,
    );
  });
});

describe('desktopExecutable', () => {
  /**
   * Windows records the executable when it registers the claude:// handler, so
   * the registry names the same one it would run itself — no guessing at a
   * versioned package directory.
   */
  const registered = `"${'C:\\Apps\\Claude\\app\\Claude.exe'}" "%1"`;

  it('takes the path out of the registered protocol command', () => {
    expect(
      desktopExecutable(
        () => registered,
        () => [],
      ),
    ).toBe('C:\\Apps\\Claude\\app\\Claude.exe');
  });

  it('falls back to a running instance when nothing is registered', () => {
    const table = rows({ pid: 500, parentPid: 9 });
    expect(
      desktopExecutable(
        () => undefined,
        () => table,
      ),
    ).toBe(DESKTOP);
  });

  it('has no answer when neither source knows', () => {
    expect(
      desktopExecutable(
        () => undefined,
        () => [],
      ),
    ).toBeUndefined();
  });
});

describe('runningStores', () => {
  /**
   * A profile can be started by environment variable or by the --user-data-dir
   * switch. Only the first is visible to a process that did not launch it, so the
   * running command lines are the one place both spellings show up.
   */
  const withCmd = (cmd: string): Partial<ProcessRow> => ({ commandLine: cmd });

  it('reads the profile out of the command line', () => {
    const table = rows(withCmd('"Claude.exe" --user-data-dir="C:\\work\\profile" --other'));
    expect(runningStores(() => table)).toEqual(['C:\\work\\profile']);
  });

  it('reports each profile once, however many processes it has', () => {
    const table = rows(
      withCmd('"Claude.exe" --user-data-dir="C:\\one"'),
      withCmd('"Claude.exe" --type=renderer --user-data-dir="C:\\one"'),
      withCmd('"Claude.exe" --user-data-dir="C:\\two"'),
    );
    expect(runningStores(() => table).sort()).toEqual(['C:\\one', 'C:\\two']);
  });

  it('handles a profile path that is not quoted', () => {
    const table = rows(withCmd('Claude.exe --user-data-dir=C:\\plain --type=gpu'));
    expect(runningStores(() => table)).toEqual(['C:\\plain']);
  });

  it('ignores processes that are not the app', () => {
    const table = rows({ name: 'node.exe', commandLine: 'node --user-data-dir="C:\\nope"' });
    expect(runningStores(() => table)).toEqual([]);
  });

  it('says nothing when no instance names a profile', () => {
    expect(runningStores(() => rows(withCmd('"Claude.exe"')))).toEqual([]);
  });
});

describe('inspectDesktopFor', () => {
  /**
   * With two profiles up there are two main processes, so "is the app running"
   * stops being one question. Anything about a specific store has to ask about
   * that store's instance.
   */
  const ONE = 'C:\\one';
  const TWO = 'C:\\two';
  const inA = (over: Partial<ProcessRow> = {}) => ({
    commandLine: `"Claude.exe" --user-data-dir="${ONE}"`,
    ...over,
  });
  const inB = (over: Partial<ProcessRow> = {}) => ({
    commandLine: `"Claude.exe" --user-data-dir="${TWO}"`,
    ...over,
  });
  /** A profile: known by one path, and its processes always carry the switch. */
  const profile = (root: string) => ({ roots: [root], isDefault: false });

  it('reports the instance running the store it was asked about', () => {
    const table = rows(inA({ pid: 500, parentPid: 9 }), inB({ pid: 700, parentPid: 9 }));

    expect(inspectDesktopFor(profile(ONE), () => table, {}).mainPid).toBe(500);
    expect(inspectDesktopFor(profile(TWO), () => table, {}).mainPid).toBe(700);
  });

  it('says not running when only the other profile is up', () => {
    const table = rows(inB({ pid: 700, parentPid: 9 }));
    expect(inspectDesktopFor(profile(ONE), () => table, {})).toMatchObject({ running: false });
  });

  it('tolerates a trailing separator on either side', () => {
    const table = rows(inA({ pid: 500, parentPid: 9 }));
    expect(inspectDesktopFor(profile(`${ONE}\\`), () => table, {}).running).toBe(true);
  });

  it('counts an instance with no switch as the default installation', () => {
    // The packaged app names its userData differently from the path foster
    // resolves, and its main process carries no switch at all — so for the
    // default store a switchless instance is the instance.
    const table = rows({ pid: 500, parentPid: 9, commandLine: '"Claude.exe"' });
    const installed = { roots: ['C:\\Roaming\\Claude'], isDefault: true };
    expect(inspectDesktopFor(installed, () => table, {}).running).toBe(true);
  });

  it('keeps the processes the ancestry check needs', () => {
    const table = rows(inA({ pid: 500, parentPid: 9 }), {
      pid: process.pid,
      parentPid: 500,
      name: 'node.exe',
      path: 'C:\\node.exe',
      commandLine: 'node',
    });
    expect(inspectDesktopFor(profile(ONE), () => table, {}).selfHosted).toBe(true);
  });
});

describe('matching an instance to a store with two names', () => {
  /**
   * The packaged installation is known by two paths: the package directory
   * foster resolves, and the pre-virtualisation one the app passes to its
   * children. Matching by a single spelling would miss the instance — and for a
   * command that closes an app, that is the wrong way to be wrong.
   */
  const PACKAGE = 'C:\\Packages\\Claude\\LocalCache\\Roaming\\Claude';
  const APPDATA = 'C:\\Roaming\\Claude';

  it('accepts either spelling of the same installation', () => {
    const table = rows(
      { pid: 500, parentPid: 9, commandLine: '"Claude.exe"' },
      { pid: 501, parentPid: 500, commandLine: `"Claude.exe" --user-data-dir="${APPDATA}"` },
    );

    const identity = { roots: [PACKAGE, APPDATA], isDefault: true };
    const state = inspectDesktopFor(identity, () => table, {});
    expect(state.mainPid).toBe(500);
  });

  it('still excludes an instance on a genuinely different profile', () => {
    const table = rows({
      pid: 700,
      parentPid: 9,
      commandLine: '"Claude.exe" --user-data-dir="C:\\Elsewhere"',
    });

    const identity = { roots: [PACKAGE, APPDATA], isDefault: true };
    expect(inspectDesktopFor(identity, () => table, {}).running).toBe(false);
  });
});

describe('a switchless process is not a wildcard', () => {
  /**
   * The default installation's main process carries no --user-data-dir, so a
   * switchless row means "the default one". Treating it as matching any store
   * made a profile's status describe the default app — and would have offered to
   * close it.
   */
  it('does not count the default instance as a profile', () => {
    const table = rows({ pid: 500, parentPid: 9, commandLine: '"Claude.exe"' });
    const store = makeStore(); // a temp dir, never a candidate root

    expect(inspectDesktopFor(storeIdentity(store.root, {}), () => table, {}).running).toBe(false);
  });
});
