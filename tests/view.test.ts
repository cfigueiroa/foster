import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import { AppRunningError } from '../src/engine/safety.js';
import {
  applyViewCopy,
  applyViewSet,
  ENV_STORED_TO_WORD,
  ENV_WORDS,
  GROUP_BY_STORED_TO_WORD,
  GROUP_BY_WORDS,
  planLayoutViewCarry,
  planViewCopy,
  planViewSet,
  readViewState,
  SORT_STORED_TO_WORD,
  SORT_WORDS,
} from '../src/engine/view.js';
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
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

const LOG_NUMBER = 4;
const SCRIPT_KEY = 'dframe-store';

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

/** A synthetic Local Storage database carrying the sidebar filter menu's `state`. */
function makeMachineStore(store: StoreLayout, state: Record<string, unknown> = {}): void {
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
    frameRecords(encodeBatch(1n, [{ key: localStorageKey(SCRIPT_KEY), value }]), 0),
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
  accountUuid: '33333333-3333-4333-8333-333333333333',
  organizationUuid: '33333333-3333-4333-8333-333333333334',
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

    expect(() =>
      applyViewSet(plan, { store, list: () => desktopRunningOn(store.root) }),
    ).toThrow(AppRunningError);
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

    expect(() =>
      applyViewCopy(plan, { store, list: () => desktopRunningOn(store.root) }),
    ).toThrow(AppRunningError);
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
});

describe('readEpitaxyPrefs (sanity: the config reader survives a missing file)', () => {
  it('returns {} rather than throwing when the file does not exist', () => {
    const store = makeStore();
    expect(readEpitaxyPrefs(store)).toEqual({});
  });
});
