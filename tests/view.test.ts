import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsAtomic from '../src/util/fsatomic.js';
import { buildFosterCopy } from '../src/domain/fostering.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import { AppRunningError } from '../src/engine/safety.js';
import { encodeBatch, encodeVarint32, frameRecords } from '../src/store/format/leveldb.js';
import { localStorageDir, localStorageKey } from '../src/store/localStorage.js';
import {
  activityDaysKey,
  emptyProjectsKey,
  environmentsKey,
  legacyViewKeysPresent,
  prStatusKey,
  readEpitaxyPrefs,
  readViewAccountPrefs,
  statusKey,
  writeEpitaxyPrefs,
} from '../src/store/viewPrefs.js';
import type { ProcessRow } from '../src/util/processes.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';
import { Ledger } from '../src/ledger/log.js';

const LOG_NUMBER = 4;
const SCRIPT_KEY = 'dframe-store';

/**
 * Flipped per test to make the next Local Storage append fail, without
 * touching the real implementation — same pattern as `failed-write.test.ts`,
 * one level lower: `writeLocalStorageValue` appends through `appendSynced`,
 * never `writeFileAtomic`, so that is the call this test file needs to hook.
 */
let failNextAppend = false;

vi.mock('../src/util/fsatomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FsAtomic>();
  return {
    ...actual,
    appendSynced: (target: string, contents: Buffer) => {
      if (failNextAppend) throw new Error('simulated disk failure');
      return actual.appendSynced(target, contents);
    },
  };
});

const {
  applyViewCopy,
  applyViewSet,
  ENV_STORED_TO_WORD,
  ENV_WORDS,
  GROUP_BY_STORED_TO_WORD,
  GROUP_BY_WORDS,
  planLayoutViewCarry,
  planMachineViewCarry,
  planViewCopy,
  planViewSet,
  readViewState,
  recordSignedInViewSighting,
  recordViewSeen,
  SORT_STORED_TO_WORD,
  SORT_WORDS,
  viewCarriedFor,
  viewSeenFor,
} = await import('../src/engine/view.js');

beforeEach(() => {
  failNextAppend = false;
});

/** No process ever reported running — the app is always "closed" to these tests. */
const closed = (): ProcessRow[] => [];

/** Redirects backups into the test's own temp tree, never the real `~/.foster`. */
function testEnv(store: StoreLayout): NodeJS.ProcessEnv {
  return { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') };
}

/** The same, shaped for a direct `write*` call rather than an `Apply*Options`. */
function backupOpts(store: StoreLayout): { env: NodeJS.ProcessEnv } {
  return { env: testEnv(store) };
}

/**
 * A synthetic Local Storage database carrying the sidebar filter menu's
 * `state`. `scriptKey` defaults to `dframe-store` itself; a caller that wants
 * a database that exists but has never recorded that key at all — the #8
 * precondition `applyViewSet` now checks up front — passes a different one.
 */
function makeMachineStore(
  store: StoreLayout,
  state: Record<string, unknown> = {},
  scriptKey: string = SCRIPT_KEY,
): void {
  const dir = localStorageDir(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  const edit = Buffer.concat([
    encodeVarint32(1),
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2),
    encodeVarint32(LOG_NUMBER),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));

  const document = { state, version: 1 };
  const value = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(JSON.stringify(document), 'latin1'),
  ]);
  writeFileSync(
    path.join(dir, `${String(LOG_NUMBER).padStart(6, '0')}.log`),
    frameRecords(encodeBatch(1n, [{ key: localStorageKey(scriptKey), value }]), 0),
  );
}

function writeDesktopConfig(store: StoreLayout, epitaxy: Record<string, unknown> = {}): void {
  writeFileSync(
    store.desktopConfigFile,
    JSON.stringify({ preferences: { epitaxyPrefs: epitaxy } }),
    'utf8',
  );
}

function desktopRunningOn(root: string): ProcessRow[] {
  const exe =
    'C:\\home\\AppData\\Local\\Packages\\Claude_0.0.0.0_x64__test\\LocalCache\\Roaming\\Claude\\app\\Claude.exe';
  return [
    {
      pid: 601,
      parentPid: 9,
      name: 'claude.exe',
      path: exe,
      commandLine: `"${exe}" --user-data-dir="${root}"`,
    },
  ];
}

const THIRD_ACCOUNT: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-000000000773',
  organizationUuid: '00000000-0000-4000-8000-000000000774',
};

describe('CLI word <-> stored value mapping', () => {
  it('is a lossless round trip in both directions', () => {
    for (const [word, stored] of Object.entries(GROUP_BY_WORDS)) {
      expect(GROUP_BY_STORED_TO_WORD[stored]).toBe(word);
    }
    for (const [word, stored] of Object.entries(SORT_WORDS)) {
      expect(SORT_STORED_TO_WORD[stored]).toBe(word);
    }
    for (const [word, stored] of Object.entries(ENV_WORDS)) {
      expect(ENV_STORED_TO_WORD[stored]).toBe(word);
    }
  });

  it('uses the words the spec gives, not invented ones', () => {
    expect(GROUP_BY_WORDS.folder).toBe('project');
    expect(GROUP_BY_WORDS.state).toBe('state');
    expect(SORT_WORDS.activity).toBe('recency');
    expect(SORT_WORDS.name).toBe('alpha');
    expect(ENV_WORDS.cloud).toBe('remote');
    expect(ENV_WORDS['remote-control']).toBe('bridge');
  });
});

describe('store/viewPrefs: the five per-account keys (22/09/2026 re-measurement)', () => {
  it('reads and writes status and the activity window per account, not machine-wide', () => {
    const store = makeStore();
    writeDesktopConfig(store);

    const { backup } = writeEpitaxyPrefs(
      store,
      {
        [environmentsKey(NEW_ACCOUNT)]: ['local', 'ssh'],
        [emptyProjectsKey(NEW_ACCOUNT)]: true,
        [prStatusKey(NEW_ACCOUNT)]: false,
        [statusKey(NEW_ACCOUNT)]: 'active',
        [activityDaysKey(NEW_ACCOUNT)]: 7,
      },
      backupOpts(store),
    );
    expect(backup).toMatch(/backups/);

    const prefs = readViewAccountPrefs(store, NEW_ACCOUNT);
    expect(prefs).toEqual({
      environments: ['local', 'ssh'],
      showEmptyProjects: true,
      showPrStatus: false,
      status: 'active',
      activityDays: 7,
    });

    // A different account's keys — and the unsuffixed legacy ones — are untouched.
    expect(readViewAccountPrefs(store, OLD_ACCOUNT)).toEqual({});
  });

  it('reports the unsuffixed status and activity-days keys as legacy, never as the real setting', () => {
    const store = makeStore();
    writeDesktopConfig(store, {
      'code-sessions-status-filter': 'all',
      'code-sessions-state-activity-days': 30,
      [statusKey(NEW_ACCOUNT)]: 'active',
    });
    // Measured on a real account: the two disagreed (unsuffixed said `all`,
    // the per-account key said `active`, and the sidebar showed `active`).
    expect(legacyViewKeysPresent(store).sort()).toEqual(
      ['code-sessions-state-activity-days', 'code-sessions-status-filter'].sort(),
    );
    expect(readViewAccountPrefs(store, NEW_ACCOUNT).status).toBe('active');
  });

  it('inventories an unrecognised account-suffixed epitaxyPrefs key, without touching a known one', () => {
    const store = makeStore();
    writeDesktopConfig(store, {
      [statusKey(NEW_ACCOUNT)]: 'active',
      [`some-future-setting.${NEW_ACCOUNT.accountUuid}`]: true,
    });
    const state = readViewState(store, NEW_ACCOUNT);
    expect(state.unknownAccountKeys).toEqual([`some-future-setting.${NEW_ACCOUNT.accountUuid}`]);
  });

  it('preserves unrelated epitaxyPrefs and preferences keys on write', () => {
    const store = makeStore();
    writeFileSync(
      store.desktopConfigFile,
      JSON.stringify({
        mcpServers: { thing: 1 },
        preferences: { menuBarEnabled: true, epitaxyPrefs: { untouched: 'x' } },
      }),
      'utf8',
    );
    writeEpitaxyPrefs(store, { [environmentsKey(NEW_ACCOUNT)]: ['local'] }, backupOpts(store));

    const after = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(after.mcpServers).toEqual({ thing: 1 });
    expect((after.preferences as Record<string, unknown>).menuBarEnabled).toBe(true);
    expect(
      ((after.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>)
        .untouched,
    ).toBe('x');
  });

  it('backs up under ~/.foster/backups (FOSTER_HOME-aware), never as a sibling of the file it copies (finding #4)', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    // FOSTER_HOME is nested under the store root here purely so the temp
    // directory this test runs in cleans up in one piece — the backup still
    // has to land under it, not next to `claude_desktop_config.json` the way
    // the old `<file>.bak-<stamp>` convention did.
    const env = testEnv(store);
    const { backup } = writeEpitaxyPrefs(store, { [statusKey(NEW_ACCOUNT)]: 'active' }, { env });
    expect(backup.startsWith(path.join(env.FOSTER_HOME!, 'backups'))).toBe(true);
    expect(path.dirname(backup)).not.toBe(path.dirname(store.desktopConfigFile));
    expect(path.basename(backup)).not.toMatch(/^claude_desktop_config\.json\.bak-/);
    expect(readFileSync(backup, 'utf8')).not.toContain(statusKey(NEW_ACCOUNT));
  });
});

describe('planViewSet / applyViewSet', () => {
  it('status is per-account: group-by state sets it in the account map, not machine', () => {
    const store = makeStore();
    makeMachineStore(store, {});
    writeDesktopConfig(store, { [statusKey(NEW_ACCOUNT)]: 'archived' });

    const plan = planViewSet(store, NEW_ACCOUNT, { groupBy: 'state' });
    expect(plan.impliedStatusActive).toBe(true);
    expect(plan.machine).not.toHaveProperty('status');
    expect(plan.account[statusKey(NEW_ACCOUNT)]).toBe('active');
    expect(plan.changes.map((c) => c.field).sort()).toEqual(['group-by', 'status']);
  });

  it('writes the machine half (group-by, sort) and the account half in one call, leaving neighbours alone', () => {
    const store = makeStore();
    makeMachineStore(store, {
      sidebarWidth: 400,
      groupByByMode: { chat: 'date' },
    });
    writeDesktopConfig(store, { untouched: 'kept' });

    const plan = planViewSet(store, NEW_ACCOUNT, {
      status: 'archived',
      sort: 'name',
      env: ['local', 'cloud'],
      prStatus: false,
      activityDays: 7,
    });
    applyViewSet(plan, { store, list: closed, env: testEnv(store) });

    const state = readViewState(store, NEW_ACCOUNT);
    expect(state.account.status).toBe('archived');
    expect(state.sort).toBe('alpha');
    expect(state.account.environments).toEqual(['local', 'remote']);
    expect(state.account.showPrStatus).toBe(false);
    expect(state.account.activityDays).toBe(7);

    // Neighbours of the machine-wide state, and the code-only mode, survive.
    const record = state.machineRecord!;
    expect((record.document.state as Record<string, unknown>).sidebarWidth).toBe(400);
    expect(
      ((record.document.state as Record<string, unknown>).groupByByMode as Record<string, unknown>)
        .chat,
    ).toBe('date');
    // dframe-store never carries status — see the 22/09/2026 re-measurement.
    expect((record.document.state as Record<string, unknown>).recentsStatusFilter).toBeUndefined();

    const desktopConfig = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const epitaxy = (desktopConfig.preferences as Record<string, unknown>).epitaxyPrefs as Record<
      string,
      unknown
    >;
    expect(epitaxy.untouched).toBe('kept');
  });

  it('refuses to write while Claude Desktop is running', () => {
    const store = makeStore();
    makeMachineStore(store, {});
    writeDesktopConfig(store);
    const plan = planViewSet(store, NEW_ACCOUNT, { status: 'archived' });

    expect(() => applyViewSet(plan, { store, list: () => desktopRunningOn(store.root) })).toThrow(
      AppRunningError,
    );
  });

  it('#13: refuses --group-by state together with an explicit --status other than active, with a clear message', () => {
    const store = makeStore();
    makeMachineStore(store, {});
    writeDesktopConfig(store);

    for (const status of ['all', 'archived'] as const) {
      expect(() => planViewSet(store, NEW_ACCOUNT, { groupBy: 'state', status })).toThrow(
        /grouping by state only shows active sessions; drop --status or use --status active/,
      );
    }

    // --status active paired explicitly with --group-by state agrees with the
    // implied value, so it is not a conflict.
    const plan = planViewSet(store, NEW_ACCOUNT, { groupBy: 'state', status: 'active' });
    expect(plan.impliedStatusActive).toBe(true);
  });

  it('#8: checks the Local Storage record exists before writing the per-account half, not after', () => {
    const store = makeStore();
    // A Local Storage database that exists but has never recorded the
    // `dframe-store` key — the same shape as an installation whose sidebar
    // filter menu was never opened. `readLocalStorageValue` returns
    // `undefined` for this, rather than throwing the way a missing database
    // entirely would.
    makeMachineStore(store, {}, 'some-other-key');
    writeDesktopConfig(store);

    const plan = planViewSet(store, NEW_ACCOUNT, { prStatus: false, sort: 'name' });
    expect(plan.account[prStatusKey(NEW_ACCOUNT)]).toBe(false);

    expect(() => applyViewSet(plan, { store, list: closed, env: testEnv(store) })).toThrow(
      /Local Storage has never recorded the sidebar filters/,
    );

    // The bug: this used to write the per-account half before checking the
    // machine-wide half's own precondition, so by the time the error above
    // was thrown the config file already carried pr-status off.
    expect(readEpitaxyPrefs(store)[prStatusKey(NEW_ACCOUNT)]).toBeUndefined();
  });

  it('#8: names the per-account half as already written when the machine-wide append fails afterward', () => {
    const store = makeStore();
    makeMachineStore(store, {});
    writeDesktopConfig(store);

    const plan = planViewSet(store, NEW_ACCOUNT, { prStatus: false, sort: 'name' });

    failNextAppend = true;
    expect(() => applyViewSet(plan, { store, list: closed, env: testEnv(store) })).toThrow(
      /the per-account half was already written \(backup at .*\); the machine-wide half failed: simulated disk failure/,
    );

    // The per-account half really did land — only the Local Storage append
    // (a real, unpredictable failure the up-front checks cannot rule out)
    // failed afterward, and the error above has to say so.
    expect(readEpitaxyPrefs(store)[prStatusKey(NEW_ACCOUNT)]).toBe(false);
  });
});

describe('#15: view surfaces localStorage.ts\'s "read a different log" notice as a dim line', () => {
  it('carries the notice through readViewState on state.machineRecord.notices', () => {
    const store = makeStore();
    const dir = localStorageDir(store);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
    const edit = Buffer.concat([
      encodeVarint32(1),
      encodeVarint32(8),
      Buffer.from('idb_cmp1'),
      encodeVarint32(2),
      encodeVarint32(LOG_NUMBER),
    ]);
    writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));

    const document = { state: {}, version: 1 };
    const value = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(JSON.stringify(document), 'latin1'),
    ]);
    const namedLogPath = path.join(dir, `${String(LOG_NUMBER).padStart(6, '0')}.log`);
    writeFileSync(
      namedLogPath,
      frameRecords(encodeBatch(1n, [{ key: localStorageKey(SCRIPT_KEY), value }]), 0),
    );
    // Same "manifest's log number is a floor, not an address" case
    // `localStorage.test.ts` covers directly — here the point is only that
    // `readViewState` does not drop the notice on the way through.
    const newer = path.join(dir, '000009.log');
    renameSync(namedLogPath, newer);

    const state = readViewState(store, NEW_ACCOUNT);
    expect(state.machineRecord?.notices).toHaveLength(1);
    expect(state.machineRecord?.notices[0]).toMatch(/read 000009\.log instead/);
  });
});

describe('planViewCopy / applyViewCopy', () => {
  it('copies only the per-account half (all five keys), and is idempotent', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    writeEpitaxyPrefs(
      store,
      {
        [environmentsKey(OLD_ACCOUNT)]: ['local'],
        [emptyProjectsKey(OLD_ACCOUNT)]: true,
        [statusKey(OLD_ACCOUNT)]: 'active',
        [activityDaysKey(OLD_ACCOUNT)]: 30,
      },
      backupOpts(store),
    );

    const first = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);
    expect(first.changes.length).toBeGreaterThan(0);
    const applied = applyViewCopy(first, { store, list: closed, env: testEnv(store) });
    expect(applied.backups).toHaveLength(1);

    expect(readViewAccountPrefs(store, NEW_ACCOUNT)).toEqual({
      environments: ['local'],
      showEmptyProjects: true,
      status: 'active',
      activityDays: 30,
    });

    // Idempotent: the second plan has nothing left to change, and applying it
    // writes nothing — no backup, and the file's bytes are unchanged.
    const before = readFileSync(store.desktopConfigFile, 'utf8');
    const second = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);
    expect(second.changes).toEqual([]);
    const result = applyViewCopy(second, { store, list: closed, env: testEnv(store) });
    expect(result.backups).toEqual([]);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(before);
  });

  it('#A2 / finding #7: when the source has never set a key the target has, the copy deletes the target key and says so', () => {
    const store = makeStore();
    writeDesktopConfig(store, { [emptyProjectsKey(NEW_ACCOUNT)]: true });

    const plan = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);
    expect(plan.changes).toEqual([{ field: 'empty-groups', from: true, to: false }]);

    const result = applyViewCopy(plan, { store, list: closed, env: testEnv(store) });
    // The old bug: the plan reported this change but applyViewCopy wrote
    // nothing for it (guarded on `source !== undefined`), so the target kept
    // showing `true` after a copy that claimed to have changed it.
    expect(result.backups).toHaveLength(1);
    expect(readViewAccountPrefs(store, NEW_ACCOUNT).showEmptyProjects).toBeUndefined();
  });

  it('refuses to write while Claude Desktop is running', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    writeEpitaxyPrefs(store, { [environmentsKey(OLD_ACCOUNT)]: ['local'] }, backupOpts(store));
    const plan = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);

    expect(() => applyViewCopy(plan, { store, list: () => desktopRunningOn(store.root) })).toThrow(
      AppRunningError,
    );
  });
});

describe('planLayoutViewCarry (finding #6: status and activity-days are carried too)', () => {
  it('carries the whole per-account half, status and activity window included, from the only other account that has any of it', () => {
    const store = makeStore();
    // `listAccountDirs` walks the code-sessions directory, so every account it
    // is to consider needs a directory there — writing a session is the
    // ordinary way one comes to exist.
    for (const account of [NEW_ACCOUNT, OLD_ACCOUNT, THIRD_ACCOUNT]) {
      mkdirSync(path.join(store.codeSessionsDir, account.accountUuid, account.organizationUuid), {
        recursive: true,
      });
    }
    writeDesktopConfig(store);
    writeEpitaxyPrefs(
      store,
      {
        [emptyProjectsKey(OLD_ACCOUNT)]: true,
        [environmentsKey(OLD_ACCOUNT)]: ['ssh'],
        [statusKey(OLD_ACCOUNT)]: 'archived',
        [activityDaysKey(OLD_ACCOUNT)]: 1,
      },
      backupOpts(store),
    );

    const carry = planLayoutViewCarry(store, NEW_ACCOUNT);
    expect(carry.from).toEqual(OLD_ACCOUNT);
    expect(carry.account).toEqual({
      [environmentsKey(NEW_ACCOUNT)]: ['ssh'],
      [emptyProjectsKey(NEW_ACCOUNT)]: true,
      [statusKey(NEW_ACCOUNT)]: 'archived',
      [activityDaysKey(NEW_ACCOUNT)]: 1,
    });
    expect(carry.changes.map((c) => c.field).sort()).toEqual(
      ['activity-days', 'empty-groups', 'env', 'status'].sort(),
    );
  });

  it('carries nothing when the target already has any of the five set', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    writeEpitaxyPrefs(
      store,
      {
        [activityDaysKey(NEW_ACCOUNT)]: 3,
        [emptyProjectsKey(OLD_ACCOUNT)]: true,
      },
      backupOpts(store),
    );

    const carry = planLayoutViewCarry(store, NEW_ACCOUNT);
    expect(carry.changes).toEqual([]);
    expect(carry.account).toEqual({});
  });

  it("#9c: reports nothing-to-do when the only other account's sole account pref is an empty environments array", () => {
    const store = makeStore();
    for (const account of [NEW_ACCOUNT, OLD_ACCOUNT]) {
      mkdirSync(path.join(store.codeSessionsDir, account.accountUuid, account.organizationUuid), {
        recursive: true,
      });
    }
    writeDesktopConfig(store);
    // `environments: []` reads back as `environments !== undefined` (an
    // empty array, not absence), so `hasAnyAccountPref` still treats this
    // account as having something set — but `[]` and "never set" mean the
    // same thing per `ViewAccountPrefs`'s own contract, and the target here
    // starts with nothing, so carrying it changes nothing at all.
    writeEpitaxyPrefs(store, { [environmentsKey(OLD_ACCOUNT)]: [] }, backupOpts(store));

    const carry = planLayoutViewCarry(store, NEW_ACCOUNT);
    // The bug (#9c): this used to return `{ from: OLD_ACCOUNT, changes: [{field: 'env', ...}], account: { [envKey]: undefined } }`
    // — a plan `layout.ts` read as "one key to carry" (`Object.keys(...).length`
    // counts a key present with value `undefined`), so every run wrote,
    // backed up and logged a no-op.
    expect(carry.changes).toEqual([]);
    expect(carry.account).toEqual({});
    expect(carry.from).toBeUndefined();
  });

  it("#9c: skips a source whose only pref is the empty-environments no-op and carries a later source's real setting", () => {
    const store = makeStore();
    for (const account of [NEW_ACCOUNT, OLD_ACCOUNT, THIRD_ACCOUNT]) {
      mkdirSync(path.join(store.codeSessionsDir, account.accountUuid, account.organizationUuid), {
        recursive: true,
      });
    }
    writeDesktopConfig(store);
    writeEpitaxyPrefs(
      store,
      {
        [environmentsKey(OLD_ACCOUNT)]: [],
        [statusKey(THIRD_ACCOUNT)]: 'archived',
      },
      backupOpts(store),
    );

    const carry = planLayoutViewCarry(store, NEW_ACCOUNT);
    expect(carry.from).toEqual(THIRD_ACCOUNT);
    expect(carry.changes).toEqual([{ field: 'status', from: undefined, to: 'archived' }]);
    expect(carry.account).toEqual({ [statusKey(NEW_ACCOUNT)]: 'archived' });
  });
});

describe('readEpitaxyPrefs (sanity: the config reader survives a missing file)', () => {
  it('returns {} rather than throwing when the file does not exist', () => {
    const store = makeStore();
    expect(readEpitaxyPrefs(store)).toEqual({});
  });
});

function newLedger(store: StoreLayout): Ledger {
  return new Ledger(path.join(store.root, '.foster-home', 'ledger.jsonl'));
}

describe('recordViewSeen / viewSeenFor', () => {
  it('appends a sighting the first time, and never repeats an unchanged one', () => {
    const store = makeStore();
    makeMachineStore(store, { groupByByMode: { code: 'date' }, sortByByMode: { code: 'alpha' } });
    const ledger = newLedger(store);

    recordViewSeen(ledger, store, OLD_ACCOUNT);
    expect(viewSeenFor(ledger.read(), OLD_ACCOUNT)).toEqual({ groupBy: 'date', sortBy: 'alpha' });
    expect(ledger.read().filter((e) => e.kind === 'view_seen')).toHaveLength(1);

    // Same value again — no second event.
    recordViewSeen(ledger, store, OLD_ACCOUNT);
    expect(ledger.read().filter((e) => e.kind === 'view_seen')).toHaveLength(1);
  });

  it('appends a new sighting once the value actually changes', () => {
    const store = makeStore();
    makeMachineStore(store, { groupByByMode: { code: 'date' } });
    const ledger = newLedger(store);
    recordViewSeen(ledger, store, OLD_ACCOUNT);

    makeMachineStore(store, { groupByByMode: { code: 'custom' } });
    recordViewSeen(ledger, store, OLD_ACCOUNT);
    expect(ledger.read().filter((e) => e.kind === 'view_seen')).toHaveLength(2);
    expect(viewSeenFor(ledger.read(), OLD_ACCOUNT)?.groupBy).toBe('custom');
  });
});

describe('recordSignedInViewSighting', () => {
  it('calls recordViewSeen with whichever account resolve() says is signed in', () => {
    const store = makeStore();
    const ledger = newLedger(store);
    const record = vi.fn();

    recordSignedInViewSighting(store, ledger, {
      resolve: () => OLD_ACCOUNT,
      record,
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(ledger, store, OLD_ACCOUNT);
  });

  it('never calls recordViewSeen when nothing is signed in', () => {
    const store = makeStore();
    const ledger = newLedger(store);
    const record = vi.fn();

    recordSignedInViewSighting(store, ledger, {
      resolve: () => undefined,
      record,
    });

    expect(record).not.toHaveBeenCalled();
  });

  it('resolves the real signed-in account by default, and actually appends a sighting', () => {
    const store = makeStore();
    // `currentAccount` reads `lastKnownAccountUuid` off the config file the
    // app itself writes — nothing in this test doubles it, so this exercises
    // the real default `resolve`.
    writeFileSync(
      store.configFile,
      JSON.stringify({ lastKnownAccountUuid: OLD_ACCOUNT.accountUuid }),
      'utf8',
    );
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'x1', cliSessionId: 'conv-x' }));
    makeMachineStore(store, { groupByByMode: { code: 'custom' } });
    const ledger = newLedger(store);

    recordSignedInViewSighting(store, ledger);

    expect(viewSeenFor(ledger.read(), OLD_ACCOUNT)?.groupBy).toBe('custom');
  });
});

describe('viewCarriedFor', () => {
  it('folds to the latest value foster wrote for one account/key', () => {
    const store = makeStore();
    const ledger = newLedger(store);
    ledger.append({ kind: 'view_carried', account: NEW_ACCOUNT, key: 'groupBy', value: 'date' });
    ledger.append({ kind: 'view_carried', account: NEW_ACCOUNT, key: 'groupBy', value: 'custom' });
    expect(viewCarriedFor(ledger.read(), NEW_ACCOUNT, 'groupBy')).toBe('custom');
    expect(viewCarriedFor(ledger.read(), NEW_ACCOUNT, 'sortBy')).toBeUndefined();
    expect(viewCarriedFor(ledger.read(), OLD_ACCOUNT, 'groupBy')).toBeUndefined();
  });
});

describe('planMachineViewCarry', () => {
  it('carries groupBy/sort from the most recently active other account’s sighting', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'src1', cliSessionId: 'conv-1', lastActivityAt: 5_000 }),
    );
    makeMachineStore(store, {}); // target has never set either key
    const ledger = newLedger(store);
    ledger.append({ kind: 'view_seen', account: OLD_ACCOUNT, groupBy: 'custom', sortBy: 'alpha' });

    const carry = planMachineViewCarry(store, NEW_ACCOUNT, ledger.read());
    expect(carry).toEqual({ from: OLD_ACCOUNT, groupBy: 'custom', sortBy: 'alpha' });
  });

  it('picks the account by its own cards, never by a foster copy that inherited a newer activity', () => {
    const store = makeStore();
    const COPY_ACCOUNT = {
      accountUuid: '00000000-0000-4000-8000-0000000000c1',
      organizationUuid: '00000000-0000-4000-8000-0000000000c2',
    };
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'src1', cliSessionId: 'conv-1', lastActivityAt: 5_000 }),
    );
    // A copy of a newer conversation sits in another account; it says nothing
    // about which account was used last.
    writeSession(
      store,
      COPY_ACCOUNT,
      buildFosterCopy(session({ sessionId: 'cp', cliSessionId: 'conv-2', lastActivityAt: 9_000 }), {
        origin: OLD_ACCOUNT,
      }),
    );
    makeMachineStore(store, {});
    const ledger = newLedger(store);
    ledger.append({ kind: 'view_seen', account: OLD_ACCOUNT, groupBy: 'custom', sortBy: 'alpha' });
    ledger.append({ kind: 'view_seen', account: COPY_ACCOUNT, groupBy: 'date', sortBy: 'recency' });

    const carry = planMachineViewCarry(store, NEW_ACCOUNT, ledger.read());
    expect(carry).toEqual({ from: OLD_ACCOUNT, groupBy: 'custom', sortBy: 'alpha' });
  });

  it('never overwrites a value the user (or the app) set, only foster’s own earlier carry', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'src1', cliSessionId: 'conv-1', lastActivityAt: 5_000 }),
    );
    // The target already shows something else, by hand.
    makeMachineStore(store, { groupByByMode: { code: 'date' } });
    const ledger = newLedger(store);
    ledger.append({
      kind: 'view_seen',
      account: OLD_ACCOUNT,
      groupBy: 'custom',
      sortBy: 'recency',
    });

    const carry = planMachineViewCarry(store, NEW_ACCOUNT, ledger.read());
    expect(carry.groupBy).toBeUndefined();
  });

  it('carries a value foster itself wrote before, when the source has since changed', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'src1', cliSessionId: 'conv-1', lastActivityAt: 5_000 }),
    );
    makeMachineStore(store, { groupByByMode: { code: 'date' } });
    const ledger = newLedger(store);
    ledger.append({ kind: 'view_carried', account: NEW_ACCOUNT, key: 'groupBy', value: 'date' });
    ledger.append({
      kind: 'view_seen',
      account: OLD_ACCOUNT,
      groupBy: 'custom',
      sortBy: 'recency',
    });

    const carry = planMachineViewCarry(store, NEW_ACCOUNT, ledger.read());
    expect(carry.groupBy).toBe('custom');
  });
});
