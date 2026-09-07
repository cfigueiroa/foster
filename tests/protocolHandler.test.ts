import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  armedParameters,
  armingIncomplete,
  containerBlocker,
  findProtocolProgId,
  inspectHandler,
  parseParameters,
  parseSubkeyNames,
  planLogin,
  restoreHandler,
  runLogin,
  type HandlerIo,
  type LoginPlan,
} from '../src/engine/protocolHandler.js';
import { layoutFor } from '../src/domain/paths.js';
import { project } from '../src/ledger/project.js';
import type { LedgerEvent, LedgerEventInput } from '../src/ledger/types.js';
import type { StoreLayout } from '../src/domain/types.js';
import type { ProcessRow } from '../src/engine/desktop.js';

// Not a real machine identifier (this repo is public) — the same shape
// measured on 05/09/2026: a Package Family Name followed by its application.
const APP_ID = 'Claude_pzs8sxrjxfjjc!Claude';
const PROG_ID = 'AppXaem4n1tckgw588q10avtdbzpbgt71c77';
// A second ProgID that would carry the same AppUserModelID on a real
// machine — measured 05/09/2026: one install registers both a `claude:`
// protocol handler and a file-type association, each its own ProgID.
const PROG_ID_2 = 'AppXc5eekcytc3qx4t9p10r6czzyc15gmhgf';
const OPEN_KEY = `HKCU\\Software\\Classes\\${PROG_ID}\\Shell\\open`;
const EXE =
  'C:\\home\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\app\\Claude.exe';
// A real MSIX install path under \WindowsApps\ — the shape `installedAppId`
// falls back to reading when no candidate store yields a packagedAppId.
const WINDOWS_APPS_EXE =
  'C:\\Program Files\\WindowsApps\\Claude_1.46388.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
// The bare, unrouted value every fresh install carries.
const PLAIN_PARAMETERS = '"%1"';

/**
 * A `ProcessRow` naming a running `claude.exe` under `\WindowsApps\`, so
 * `installedAppId`'s fallback (a running process's own path, when nothing in
 * `candidateStoreRoots` yields a package) resolves it to `APP_ID`.
 */
function windowsAppsRow(): ProcessRow {
  return {
    pid: 321,
    parentPid: 1,
    name: 'claude.exe',
    path: WINDOWS_APPS_EXE,
    commandLine: `"${WINDOWS_APPS_EXE}"`,
  };
}

/**
 * Synthetic `reg query <root> /f <needle> /d /s` output: one block per entry
 * (a `Shell\open` key and its `AppUserModelID`), separated by a blank line —
 * the shape `findProtocolProgId`'s registry-search fallback parses. `reg.exe`
 * always echoes the canonical, long hive name (`HKEY_CURRENT_USER`), never
 * the abbreviated one this codebase writes its own keys with (`HKCU`) — the
 * same trap `parseSubkeyNames` exists to survive, reproduced here on purpose
 * rather than in the short form that would hide it.
 */
function regSearchLines(entries: Array<{ progId: string; appUserModelId: string }>): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`HKEY_CURRENT_USER\\Software\\Classes\\${entry.progId}\\Shell\\open`);
    lines.push(`    AppUserModelID    REG_SZ    ${entry.appUserModelId}`);
    lines.push('    Parameters    REG_SZ    "%1"');
    lines.push('');
  }
  return lines;
}

// Empty, not inherited: this suite runs inside a hosted Claude Code session
// (this very repository is worked on from one), whose real process.env
// carries CLAUDE_CODE_HOST_SESSION_ID / CLAUDE_CODE_ENTRYPOINT — exactly the
// markers containerBlocker looks for. Every call below that does not mean to
// test the container check itself must pass this rather than rely on the
// default `process.env`, or the whole suite would refuse itself.
const NO_ENV: NodeJS.ProcessEnv = {};

/**
 * A store whose root sits under `\Packages\Claude_pzs8sxrjxfjjc\...`, so
 * `packagedAppId` resolves it to `APP_ID` — the shape `planLogin`'s other
 * checks (`storeIdentity`, `readConfig`) expect a real installation to have.
 * A real temp directory, unlike `makeStore()`'s plain one, so a test can
 * still write `config.json` into it.
 */
function makePackagedStore(): StoreLayout {
  const base = mkdtempSync(path.join(tmpdir(), 'foster-test-'));
  const root = path.join(
    base,
    'Packages',
    'Claude_pzs8sxrjxfjjc',
    'LocalCache',
    'Roaming',
    'Claude',
  );
  const store = layoutFor(root);
  mkdirSync(store.codeSessionsDir, { recursive: true });
  return store;
}

/**
 * A profile store with no package identity of its own at all (a
 * `D:\Claude-Work` shape — no `\Packages\` segment), alongside an env whose
 * `LOCALAPPDATA` names a temp dir holding a *separate*, installed package —
 * so `installedAppId` can find `APP_ID` by scanning `candidateStoreRoots`,
 * never by looking at the profile's own path. This is the exact case the
 * defect measured 05/09/2026 was found from: `packagedAppId(profileStore)`
 * is undefined, so anything deriving the AUMID from the store itself finds
 * nothing on a real profile, however real the installed app is.
 */
function makeProfileStoreWithInstalledApp(): { store: StoreLayout; env: NodeJS.ProcessEnv } {
  const base = mkdtempSync(path.join(tmpdir(), 'foster-test-'));
  const installedRoot = path.join(
    base,
    'Packages',
    'Claude_pzs8sxrjxfjjc',
    'LocalCache',
    'Roaming',
    'Claude',
  );
  mkdirSync(path.join(installedRoot, 'claude-code-sessions'), { recursive: true });

  const store = layoutFor(path.join(base, 'Claude-Work'));
  mkdirSync(store.codeSessionsDir, { recursive: true });

  return { store, env: { LOCALAPPDATA: base } };
}

/**
 * An in-memory registry tree with one packaged ProgID, whose `Shell\open`
 * holds `AppUserModelID` and `Parameters`. `log`, when given, records
 * `write:<key>:<name>=<value>` in call order.
 *
 * `protocolProgId` defaults to answering `PROG_ID` straight away — the shell
 * association is meant to be the easy, common case (a machine with a working
 * PowerShell), so most of the tests below never need to touch `env`/`list`/
 * `searchData` at all. Tests exercising the registry-search fallback set it
 * to `undefined` explicitly (a PowerShell that could not answer) and supply
 * `searchLines` instead.
 */
function fakeIo(
  options: {
    appUserModelId?: string;
    parameters?: string;
    log?: string[];
    protocolProgId?: string | undefined;
    searchLines?: string[];
  } = {},
): HandlerIo {
  const appUserModelId = options.appUserModelId ?? APP_ID;
  let parameters = options.parameters;
  const log = options.log;
  const protocolProgIdAnswer = 'protocolProgId' in options ? options.protocolProgId : PROG_ID;

  return {
    listSubkeys: (key) => (key === 'HKCU\\Software\\Classes' ? [PROG_ID] : []),
    keyExists: (key) => key === OPEN_KEY,
    readValue: (key, name) => {
      if (key !== OPEN_KEY) return {};
      if (name === 'AppUserModelID') return { value: appUserModelId };
      if (name === 'Parameters') return { value: parameters };
      return {};
    },
    writeValue: (key, name, value) => {
      log?.push(`write:${key}:${name}=${value}`);
      if (key === OPEN_KEY && name === 'Parameters') parameters = value;
    },
    protocolProgId: () => protocolProgIdAnswer,
    searchData: () => options.searchLines ?? [],
  };
}

/** No AppX ProgID registered at all — a machine that has never run Claude Desktop. */
function fakeIoNoProgId(): HandlerIo {
  return {
    listSubkeys: () => [],
    keyExists: () => false,
    readValue: () => ({}),
    writeValue: () => {
      throw new Error('not reached: no ProgID was found to write to');
    },
    protocolProgId: () => undefined,
    searchData: () => [],
  };
}

/** A HandlerIo whose Parameters read always reports a spawn failure, never a value. */
function brokenParametersIo(error: string): HandlerIo {
  const io = fakeIo();
  return {
    ...io,
    readValue: (key, name) => (name === 'Parameters' ? { error } : io.readValue(key, name)),
  };
}

function fakeAppend(log: string[]): (event: LedgerEventInput) => void {
  return (event) => log.push(`append:${event.kind}`);
}

describe('parseParameters', () => {
  it('parses the bare, unrouted value', () => {
    expect(parseParameters(PLAIN_PARAMETERS)).toEqual({});
  });

  it('parses an unquoted --user-data-dir', () => {
    expect(parseParameters('--user-data-dir=D:\\Claude-Work "%1"')).toEqual({
      userDataDir: 'D:\\Claude-Work',
    });
  });

  it('parses a quoted --user-data-dir', () => {
    expect(parseParameters('--user-data-dir="D:\\Claude Work" "%1"')).toEqual({
      userDataDir: 'D:\\Claude Work',
    });
  });

  it('returns undefined for anything else', () => {
    expect(parseParameters(undefined)).toBeUndefined();
    expect(parseParameters('')).toBeUndefined();
    expect(parseParameters('not a handler at all')).toBeUndefined();
    expect(parseParameters(`"${EXE}" "%1"`)).toBeUndefined();
  });
});

describe('armedParameters', () => {
  it('quotes a spelling that contains a space', () => {
    expect(armedParameters('D:\\Claude Work')).toBe('--user-data-dir="D:\\Claude Work" "%1"');
  });

  it('leaves a spelling with no space unquoted', () => {
    expect(armedParameters('D:\\Claude-Work')).toBe('--user-data-dir=D:\\Claude-Work "%1"');
  });
});

describe('containerBlocker', () => {
  it('is undefined outside the app', () => {
    expect(containerBlocker(NO_ENV)).toBeUndefined();
  });

  it('fires on the host session marker', () => {
    expect(containerBlocker({ CLAUDE_CODE_HOST_SESSION_ID: 'abc' })).toContain(
      'must run from a terminal outside Claude Desktop',
    );
  });

  it('fires on the entrypoint marker alone', () => {
    expect(containerBlocker({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toContain(
      'must run from a terminal outside Claude Desktop',
    );
  });
});

describe('parseSubkeyNames', () => {
  // Measured on a real machine: `reg query HKCU\Software\Classes` (no `/s`)
  // prints a blank line, then one FULL key path per line — always the long,
  // canonical hive name (`HKEY_CURRENT_USER`), never the short one this
  // codebase writes its keys with (`HKCU`) — CRLF terminated, ~49 KB for 96
  // `AppX*` subkeys on that machine. This is the actual defect: the previous
  // implementation compared each line against a prefix built from the short
  // spelling, which never matched a single line of real `reg.exe` output, so
  // `findProtocolProgId` reported "packaged ProgID not found" on a machine
  // that plainly had one.
  const REAL_SHAPE_OUTPUT =
    '\r\n' +
    'HKEY_CURRENT_USER\\Software\\Classes\r\n' +
    '\r\n' +
    'HKEY_CURRENT_USER\\Software\\Classes\\.001\r\n' +
    `HKEY_CURRENT_USER\\Software\\Classes\\${PROG_ID}\r\n` +
    `HKEY_CURRENT_USER\\Software\\Classes\\${PROG_ID_2}\r\n` +
    'HKEY_CURRENT_USER\\Software\\Classes\\zzzfakeprogid\r\n';

  it('parses the real, canonical-hive output shape against a short (HKCU) key', () => {
    expect(parseSubkeyNames(REAL_SHAPE_OUTPUT, 'HKCU\\Software\\Classes')).toEqual(
      expect.arrayContaining(['.001', PROG_ID, PROG_ID_2, 'zzzfakeprogid']),
    );
  });

  it('parses the same output against the already-canonical key', () => {
    expect(parseSubkeyNames(REAL_SHAPE_OUTPUT, 'HKEY_CURRENT_USER\\Software\\Classes')).toEqual(
      expect.arrayContaining([PROG_ID, PROG_ID_2]),
    );
  });

  it('ignores the key line itself and anything nested deeper than one level', () => {
    const withNesting =
      REAL_SHAPE_OUTPUT + `HKEY_CURRENT_USER\\Software\\Classes\\${PROG_ID}\\Shell\\open\r\n`;
    const names = parseSubkeyNames(withNesting, 'HKCU\\Software\\Classes');
    expect(names).not.toContain('Shell');
    expect(names).not.toContain('');
  });

  it('returns nothing for a key with no matching lines at all', () => {
    expect(parseSubkeyNames(REAL_SHAPE_OUTPUT, 'HKCU\\Software\\SomethingElse')).toEqual([]);
  });
});

describe('findProtocolProgId', () => {
  it('prefers the shell association when PowerShell can answer', () => {
    const io = fakeIo({ protocolProgId: PROG_ID, parameters: PLAIN_PARAMETERS });
    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [] })).toEqual({
      kind: 'found',
      key: OPEN_KEY,
      progId: PROG_ID,
      how: 'shell association',
    });
  });

  it('never falls through to the registry search when the shell association already answers', () => {
    const io: HandlerIo = {
      ...fakeIo({ protocolProgId: PROG_ID, parameters: PLAIN_PARAMETERS }),
      searchData: () => {
        throw new Error('not reached: the shell association already found it');
      },
    };
    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [] })).toEqual({
      kind: 'found',
      key: OPEN_KEY,
      progId: PROG_ID,
      how: 'shell association',
    });
  });

  it('falls back to a registry search for a PROFILE store, using the installed root from candidateStoreRoots', () => {
    const { env } = makeProfileStoreWithInstalledApp();
    const io = fakeIo({
      protocolProgId: undefined,
      parameters: PLAIN_PARAMETERS,
      searchLines: regSearchLines([{ progId: PROG_ID, appUserModelId: APP_ID }]),
    });

    expect(findProtocolProgId(io, { env, list: () => [] })).toEqual({
      kind: 'found',
      key: OPEN_KEY,
      progId: PROG_ID,
      how: 'registry search',
    });
  });

  it('falls back to a running Claude.exe under \\WindowsApps\\ when no candidate store yields one', () => {
    const io = fakeIo({
      protocolProgId: undefined,
      parameters: PLAIN_PARAMETERS,
      searchLines: regSearchLines([{ progId: PROG_ID, appUserModelId: APP_ID }]),
    });

    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [windowsAppsRow()] })).toEqual({
      kind: 'found',
      key: OPEN_KEY,
      progId: PROG_ID,
      how: 'registry search',
    });
  });

  it('refuses ambiguously when more than one ProgID carries the installed AppUserModelID', () => {
    const io = fakeIo({
      protocolProgId: undefined,
      searchLines: regSearchLines([
        { progId: PROG_ID, appUserModelId: APP_ID },
        { progId: PROG_ID_2, appUserModelId: APP_ID },
      ]),
    });

    const result = findProtocolProgId(io, { env: NO_ENV, list: () => [windowsAppsRow()] });
    expect(result.kind).toBe('ambiguous');
    expect(result).toMatchObject({ aumid: APP_ID });
    if (result.kind === 'ambiguous') {
      expect(result.progIds.sort()).toEqual([PROG_ID, PROG_ID_2].sort());
    }
  });

  it('ignores a sibling \\Application key that also carries the AppUserModelID', () => {
    // The same search also turns up each ProgID's \Application key (not
    // \Shell\open) — it must never be counted as a second candidate.
    const lines = [
      `HKEY_CURRENT_USER\\Software\\Classes\\${PROG_ID}\\Application`,
      `    AppUserModelID    REG_SZ    ${APP_ID}`,
      '',
      ...regSearchLines([{ progId: PROG_ID, appUserModelId: APP_ID }]),
    ];
    const io = fakeIo({
      protocolProgId: undefined,
      parameters: PLAIN_PARAMETERS,
      searchLines: lines,
    });

    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [windowsAppsRow()] })).toEqual({
      kind: 'found',
      key: OPEN_KEY,
      progId: PROG_ID,
      how: 'registry search',
    });
  });

  it('returns not-found with the AppUserModelID when the search comes up with nothing', () => {
    const io = fakeIo({ protocolProgId: undefined, searchLines: [] });
    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [windowsAppsRow()] })).toEqual({
      kind: 'not-found',
      aumid: APP_ID,
    });
  });

  it('returns not-found with no AppUserModelID when the installed app cannot be identified at all', () => {
    const io = fakeIo({ protocolProgId: undefined, searchLines: [] });
    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [] })).toEqual({ kind: 'not-found' });
  });

  it('verifies the resolved key actually carries Parameters before reporting it found', () => {
    // The shell answers a ProgID whose key exists but, in this fake, carries
    // no Parameters value at all — `keyExists` alone is not enough.
    const io: HandlerIo = {
      ...fakeIo({ protocolProgId: undefined, searchLines: [] }),
      keyExists: (key) => key === OPEN_KEY,
      readValue: () => ({}),
      protocolProgId: () => PROG_ID,
    };
    expect(findProtocolProgId(io, { env: NO_ENV, list: () => [] })).toEqual({ kind: 'not-found' });
  });

  it('honours an explicit --progid, bypassing detection entirely', () => {
    const io = fakeIo({ protocolProgId: undefined, parameters: PLAIN_PARAMETERS, searchLines: [] });
    expect(findProtocolProgId(io, { progid: PROG_ID })).toEqual({
      kind: 'found',
      key: OPEN_KEY,
      progId: PROG_ID,
      how: 'explicit',
    });
  });

  it('refuses an explicit --progid that does not exist, or has no Parameters', () => {
    const io = fakeIo({ protocolProgId: undefined, searchLines: [] });
    expect(findProtocolProgId(io, { progid: 'AppXnotreal' })).toEqual({
      kind: 'not-found',
      explicitProgId: 'AppXnotreal',
    });
  });
});

describe('planLogin', () => {
  it('refuses off Windows', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'linux',
    });

    expect(plan.blockers).toEqual([
      'the claude:// handler is a Windows registry key; there is nothing to route elsewhere',
    ]);
  });

  it('refuses from inside the app container, before anything registry-shaped is read', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: { CLAUDE_CODE_HOST_SESSION_ID: 'session-1' },
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([
      'app login must run from a terminal outside Claude Desktop: inside the app the registry is ' +
        'virtualized (MSIX), so a change made here never reaches the browser',
    ]);
  });

  it('refuses from inside the app container by entrypoint alone', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain('must run from a terminal outside Claude Desktop');
  });

  it('refuses when no packaged ProgID is registered for this install', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIoNoProgId(),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([
      'this Claude Desktop does not register claude:// as a packaged app; only the MSIX install is ' +
        'supported by app login',
    ]);
    expect(plan.key).toBeUndefined();
  });

  it("refuses with reg's own message when reg itself could not be run", () => {
    // The reported case: an elevated PowerShell whose PATH does not resolve
    // `reg`, so the spawn throws before it ever touches the registry. That
    // must not read as any registry-shape problem.
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: brokenParametersIo('spawnSync reg ENOENT'),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain(`could not read ${OPEN_KEY}\\Parameters`);
    expect(plan.blockers[0]).toContain('spawnSync reg ENOENT');
  });

  it('refuses when Parameters exists but is unparseable', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: 'not a handler at all' }),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers[0]).toContain('exists but is not in the shape');
  });

  it('arms Parameters with --user-data-dir from the bare value', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.key).toBe(OPEN_KEY);
    expect(plan.progId).toBe(PROG_ID);
    expect(plan.progIdSource).toBe('shell association');
    expect(plan.previous).toBe(PLAIN_PARAMETERS);
    expect(plan.armed).toBe(armedParameters(plan.spelling));
  });

  it('refuses ambiguously when more than one ProgID carries the AppUserModelID, and points at --progid', () => {
    const store = makePackagedStore();
    const io = fakeIo({
      parameters: PLAIN_PARAMETERS,
      protocolProgId: undefined,
      searchLines: regSearchLines([
        { progId: PROG_ID, appUserModelId: APP_ID },
        { progId: PROG_ID_2, appUserModelId: APP_ID },
      ]),
    });
    const plan = planLogin(store, {
      io,
      events: [],
      env: NO_ENV,
      list: () => [windowsAppsRow()],
      platform: 'win32',
    });

    expect(plan.key).toBeUndefined();
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain(APP_ID);
    expect(plan.blockers[0]).toContain(PROG_ID);
    expect(plan.blockers[0]).toContain(PROG_ID_2);
    expect(plan.blockers[0]).toContain('--progid');
  });

  it('honours --progid to resolve what would otherwise be an ambiguous ProgID', () => {
    const store = makePackagedStore();
    const io = fakeIo({
      parameters: PLAIN_PARAMETERS,
      protocolProgId: undefined,
      searchLines: regSearchLines([
        { progId: PROG_ID, appUserModelId: APP_ID },
        { progId: PROG_ID_2, appUserModelId: APP_ID },
      ]),
    });
    const plan = planLogin(store, {
      io,
      events: [],
      env: NO_ENV,
      list: () => [windowsAppsRow()],
      platform: 'win32',
      progid: PROG_ID,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.key).toBe(OPEN_KEY);
    expect(plan.progIdSource).toBe('explicit');
    expect(plan.armed).toBe(armedParameters(plan.spelling));
  });

  it('flags a plan with nothing armed as incomplete', () => {
    expect(armingIncomplete({ key: OPEN_KEY, armed: undefined })).toBe(true);
    expect(armingIncomplete({ key: undefined, armed: undefined })).toBe(true);
    expect(armingIncomplete({ key: undefined, armed: '--user-data-dir=x "%1"' })).toBe(true);
    expect(armingIncomplete({ key: OPEN_KEY, armed: '--user-data-dir=x "%1"' })).toBe(false);
  });

  it('every no-blocker plan produced above has both key and armed set', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([]);
    expect(armingIncomplete(plan)).toBe(false);
  });

  it('refuses when claude:// already routes to a different profile', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: '--user-data-dir=D:\\Claude-Other "%1"' }),
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
    const store = makePackagedStore();
    const command = `--user-data-dir="${store.root}" "%1"`;
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: store.root,
        key: OPEN_KEY,
        previous: PLAIN_PARAMETERS,
        exe: EXE,
        armed: command,
      },
    ];
    const plan = planLogin(store, {
      io: fakeIo({ parameters: command }),
      events,
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('already routed'))).toBe(true);
    expect(plan.armed).toBe(command);
    expect(plan.previous).toBe(PLAIN_PARAMETERS);
  });

  it('falls back to the bare value when routed to this same store but the ledger has no record', () => {
    // No `handler_armed` event — a reset/relocated FOSTER_HOME, or Parameters
    // pointed at this store's directory by something other than a tracked
    // foster run. There is no other natural value to restore to.
    const store = makePackagedStore();
    const command = `--user-data-dir="${store.root}" "%1"`;
    const plan = planLogin(store, {
      io: fakeIo({ parameters: command }),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.armed).toBe(command);
    expect(plan.previous).toBe(PLAIN_PARAMETERS);
  });

  it('refuses the installed app itself', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
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
    const store = makePackagedStore();
    writeFileSync(
      store.configFile,
      JSON.stringify({
        lastKnownAccountUuid: '00000000-0000-4000-8000-00000000000a',
        'oauth:tokenCacheV2': 'opaque',
      }),
      'utf8',
    );
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
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
    const store = makePackagedStore();
    const row: ProcessRow = {
      pid: 500,
      parentPid: 9,
      name: 'claude.exe',
      path: EXE,
      commandLine: `"${EXE}" --user-data-dir="${store.root}\\"`,
    };
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: NO_ENV,
      list: () => [row],
      platform: 'win32',
    });

    expect(plan.spelling).toBe(`${store.root}\\`);
  });

  it('falls back to the store root when nothing is running', () => {
    const store = makePackagedStore();
    const plan = planLogin(store, {
      io: fakeIo({ parameters: PLAIN_PARAMETERS }),
      events: [],
      env: NO_ENV,
      list: () => [],
      platform: 'win32',
    });

    expect(plan.spelling).toBe(store.root);
    expect(plan.warnings.some((w) => w.includes('is not running'))).toBe(true);
  });

  describe('package identity', () => {
    // A row this environment can prove is the app: under \Packages\Claude,
    // orphaned (no parent among desktop rows) so it is picked as the main
    // process — see isDesktopProcess/inspectDesktop in desktop.ts.
    function runningRow(store: StoreLayout): ProcessRow {
      return {
        pid: 700,
        parentPid: 1,
        name: 'claude.exe',
        path: EXE,
        commandLine: `"${EXE}" --user-data-dir="${store.root}"`,
      };
    }

    it('blocks when the running profile has no package identity', () => {
      const store = makePackagedStore();
      const plan = planLogin(store, {
        io: fakeIo({ parameters: PLAIN_PARAMETERS }),
        events: [],
        env: NO_ENV,
        list: () => [runningRow(store)],
        platform: 'win32',
        identity: () => 'none',
        lockfileHeld: () => true,
      });

      expect(plan.identity).toBe('none');
      expect(plan.blockers.some((b) => b.includes('without package identity'))).toBe(true);
    });

    it('warns but proceeds when identity cannot be determined', () => {
      const store = makePackagedStore();
      const plan = planLogin(store, {
        io: fakeIo({ parameters: PLAIN_PARAMETERS }),
        events: [],
        env: NO_ENV,
        list: () => [runningRow(store)],
        platform: 'win32',
        identity: () => 'unknown',
        lockfileHeld: () => true,
      });

      expect(plan.identity).toBe('unknown');
      expect(plan.blockers).toEqual([]);
      expect(plan.warnings.some((w) => w.includes('package identity'))).toBe(true);
    });

    it('has no identity blocker or warning when the profile runs packaged', () => {
      const store = makePackagedStore();
      const plan = planLogin(store, {
        io: fakeIo({ parameters: PLAIN_PARAMETERS }),
        events: [],
        env: NO_ENV,
        list: () => [runningRow(store)],
        platform: 'win32',
        identity: () => 'packaged',
        lockfileHeld: () => true,
      });

      expect(plan.identity).toBe('packaged');
      expect(plan.blockers).toEqual([]);
      expect(plan.warnings.some((w) => w.includes('package identity'))).toBe(false);
    });

    it('skips the identity check entirely when the profile is not running', () => {
      const store = makePackagedStore();
      const plan = planLogin(store, {
        io: fakeIo({ parameters: PLAIN_PARAMETERS }),
        events: [],
        env: NO_ENV,
        list: () => [],
        platform: 'win32',
        identity: () => {
          throw new Error('not reached: nothing is running to ask about');
        },
      });

      expect(plan.identity).toBeUndefined();
      expect(plan.blockers).toEqual([]);
    });
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
      key: OPEN_KEY,
      previous: PLAIN_PARAMETERS,
      armed: '--user-data-dir=D:\\Claude-Work "%1"',
      blockers: [],
      warnings: [],
      ...overrides,
    };
  }

  it('refuses a plan carrying blockers', async () => {
    const plan = basePlan({ blockers: ['nope'] });
    await expect(
      runLogin(plan, {
        io: fakeIo(),
        append: () => {},
        readState: () => ({ hasTokenCache: false }),
      }),
    ).rejects.toThrow('nope');
  });

  it('appends handler_armed before writing the key', async () => {
    const log: string[] = [];
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS, log });

    await runLogin(plan, {
      io,
      append: fakeAppend(log),
      readState: () => ({ hasTokenCache: true, accountUuid: account }),
      now: () => 0,
      sleep: async () => {},
    });

    expect(log[0]).toBe('append:handler_armed');
    expect(log[1]).toBe(`write:${OPEN_KEY}:Parameters=${plan.armed}`);
  });

  it('fires onArmed once the write has landed, before the wait begins', async () => {
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
    const order: string[] = [];

    await runLogin(plan, {
      io,
      append: () => {},
      readState: () => {
        order.push('read-state');
        return { hasTokenCache: true, accountUuid: account };
      },
      onArmed: () => order.push('armed'),
      now: () => 0,
      sleep: async () => {},
    });

    expect(order[0]).toBe('armed');
    expect(order.slice(1)).toContain('read-state');
  });

  it('restores verbatim and records the account on success', async () => {
    const plan = basePlan();
    const log: string[] = [];
    const io = fakeIo({ parameters: PLAIN_PARAMETERS, log });
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
    expect(io.readValue(OPEN_KEY, 'Parameters').value).toBe(PLAIN_PARAMETERS);
    expect(log.filter((l) => l.startsWith('write:'))).toEqual([
      `write:${OPEN_KEY}:Parameters=${plan.armed}`,
      `write:${OPEN_KEY}:Parameters=${PLAIN_PARAMETERS}`,
    ]);
    expect(log.at(-1)).toBe('append:handler_restored');
  });

  it('restores on timeout', async () => {
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
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
    expect(io.readValue(OPEN_KEY, 'Parameters').value).toBe(PLAIN_PARAMETERS);
  });

  it('keeps polling past what would have been the old default timeout when timeoutMs is absent, then succeeds', async () => {
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
    let t = 0;
    const now = () => t;
    let calls = 0;
    const readState = () => {
      calls += 1;
      t += 100_000;
      return calls < 5 ? { hasTokenCache: false } : { hasTokenCache: true, accountUuid: account };
    };

    const result = await runLogin(plan, {
      io,
      append: () => {},
      readState,
      now,
      sleep: async () => {},
    });

    expect(t).toBeGreaterThan(300_000);
    expect(result.outcome).toBe('signed-in');
    expect(result.restored).toBe(true);
  });

  it('keeps polling with no timeoutMs until aborted', async () => {
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
    let t = 0;
    const now = () => t;
    const controller = new AbortController();
    let ticks = 0;
    const sleep = async () => {
      ticks += 1;
      t += 100_000;
      if (ticks >= 4) controller.abort();
    };

    const result = await runLogin(plan, {
      io,
      append: () => {},
      readState: () => ({ hasTokenCache: false }),
      signal: controller.signal,
      now,
      sleep,
    });

    expect(t).toBeGreaterThan(300_000);
    expect(result.outcome).toBe('aborted');
    expect(result.restored).toBe(true);
  });

  it('fires onHeartbeat once per heartbeatMs while waiting', async () => {
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
    let t = 0;
    const now = () => t;
    const heartbeats: number[] = [];
    let ticks = 0;
    const sleep = async () => {
      ticks += 1;
      t += 20_000;
    };
    const readState = () =>
      ticks >= 10 ? { hasTokenCache: true, accountUuid: account } : { hasTokenCache: false };

    const result = await runLogin(plan, {
      io,
      append: () => {},
      readState,
      now,
      sleep,
      heartbeatMs: 60_000,
      onHeartbeat: (elapsed) => heartbeats.push(elapsed),
    });

    expect(result.outcome).toBe('signed-in');
    expect(heartbeats).toEqual([60_000, 120_000, 180_000]);
  });

  it('restores when aborted', async () => {
    const plan = basePlan();
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
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
    expect(io.readValue(OPEN_KEY, 'Parameters').value).toBe(PLAIN_PARAMETERS);
  });

  it('stops without writing the restore when the handler is rewritten underneath it', async () => {
    const plan = basePlan();
    const writes: string[] = [];
    let reads = 0;
    let value: string | undefined;
    const io: HandlerIo = {
      listSubkeys: () => [PROG_ID],
      keyExists: () => true,
      readValue: (key, name) => {
        if (key !== OPEN_KEY || name !== 'Parameters') return {};
        reads += 1;
        // The very next read after the arm-write is runLogin's own
        // verification that the write landed; only after that does this
        // fixture pretend the app restarted and rewrote the value.
        return { value: reads <= 1 ? value : 'rewritten-by-app' };
      },
      writeValue: (key, name, next) => {
        if (key === OPEN_KEY && name === 'Parameters') {
          writes.push(next);
          value = next;
        }
      },
      protocolProgId: () => undefined,
      searchData: () => [],
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
  it('says there is nothing to restore when no login is in flight', () => {
    const io = fakeIo({ parameters: PLAIN_PARAMETERS });
    const result = restoreHandler(project([]), io, () => {});

    expect(result).toEqual({ ok: false, message: expect.stringContaining('nothing to restore') });
  });

  it('restores from the ledger record', () => {
    const command = '--user-data-dir=D:\\Claude-Work "%1"';
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: 'D:\\Claude-Work',
        key: OPEN_KEY,
        previous: PLAIN_PARAMETERS,
        exe: EXE,
        armed: command,
      },
    ];
    const io = fakeIo({ parameters: command });
    const appended: LedgerEventInput[] = [];

    const result = restoreHandler(project(events), io, (e) => appended.push(e));

    expect(result.ok).toBe(true);
    expect(io.readValue(OPEN_KEY, 'Parameters').value).toBe(PLAIN_PARAMETERS);
    expect(appended).toEqual([
      { kind: 'handler_restored', root: 'D:\\Claude-Work', restored: true },
    ]);
  });

  it('reports failure when the write does not read back as expected', () => {
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: 'D:\\Claude-Work',
        key: OPEN_KEY,
        previous: PLAIN_PARAMETERS,
        exe: EXE,
        armed: '--user-data-dir=D:\\Claude-Work "%1"',
      },
    ];
    // A write that silently does nothing — the read-back never matches.
    const io: HandlerIo = {
      listSubkeys: () => [PROG_ID],
      keyExists: () => true,
      readValue: () => ({ value: 'stuck' }),
      writeValue: () => {},
      protocolProgId: () => undefined,
      searchData: () => [],
    };
    const appended: LedgerEventInput[] = [];

    const result = restoreHandler(project(events), io, (e) => appended.push(e));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not put the handler back');
    expect(appended).toEqual([
      { kind: 'handler_restored', root: 'D:\\Claude-Work', restored: false },
    ]);
  });
});

describe('inspectHandler', () => {
  it('reports the current parsed handler and nothing armed', () => {
    const state = inspectHandler(
      project([]),
      fakeIo({ parameters: PLAIN_PARAMETERS }),
      NO_ENV,
      () => [],
    );
    expect(state.key).toBe(OPEN_KEY);
    expect(state.progId).toBe(PROG_ID);
    expect(state.progIdSource).toBe('shell association');
    expect(state.current).toEqual({ raw: PLAIN_PARAMETERS });
    expect(state.armed).toBeUndefined();
    expect(state.virtualizedView).toBe(false);
  });

  it('reports the routed userDataDir when Parameters carries one', () => {
    const store = makePackagedStore();
    const command = `--user-data-dir="${store.root}" "%1"`;
    const state = inspectHandler(project([]), fakeIo({ parameters: command }), NO_ENV, () => []);
    expect(state.current).toEqual({ raw: command, userDataDir: store.root });
  });

  it('reports what the ledger says is armed', () => {
    const events: LedgerEvent[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        toolVersion: '0.0.0-test',
        kind: 'handler_armed',
        root: 'D:\\Claude-Work',
        key: OPEN_KEY,
        previous: PLAIN_PARAMETERS,
        exe: EXE,
        armed: '--user-data-dir=D:\\Claude-Work "%1"',
      },
    ];
    const state = inspectHandler(project(events), fakeIo(), NO_ENV, () => []);
    expect(state.armed).toEqual({
      root: 'D:\\Claude-Work',
      key: OPEN_KEY,
      previous: PLAIN_PARAMETERS,
      at: 1_700_000_000_000,
    });
  });

  it('flags a virtualized view from inside the app container', () => {
    const state = inspectHandler(
      project([]),
      fakeIo({ parameters: PLAIN_PARAMETERS }),
      { CLAUDE_CODE_HOST_SESSION_ID: 'session-1' },
      () => [],
    );
    expect(state.virtualizedView).toBe(true);
  });

  it('reports no key, and the AppUserModelID it looked for, when this install has no matching ProgID', () => {
    const state = inspectHandler(project([]), fakeIoNoProgId(), NO_ENV, () => [windowsAppsRow()]);
    expect(state.key).toBeUndefined();
    expect(state.current).toBeUndefined();
    expect(state.lookup).toEqual({ kind: 'not-found', aumid: APP_ID });
  });

  it('reports the ambiguous candidates when more than one ProgID carries the AppUserModelID', () => {
    const io = fakeIo({
      protocolProgId: undefined,
      searchLines: regSearchLines([
        { progId: PROG_ID, appUserModelId: APP_ID },
        { progId: PROG_ID_2, appUserModelId: APP_ID },
      ]),
    });
    const state = inspectHandler(project([]), io, NO_ENV, () => [windowsAppsRow()]);
    expect(state.key).toBeUndefined();
    expect(state.lookup?.kind).toBe('ambiguous');
    if (state.lookup?.kind === 'ambiguous') {
      expect(state.lookup.progIds.sort()).toEqual([PROG_ID, PROG_ID_2].sort());
    }
  });
});
