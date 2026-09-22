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
  emptyProjectsKey,
  environmentsKey,
  legacyViewKeysPresent,
  prStatusKey,
  readEpitaxyPrefs,
  readViewAccountPrefs,
  writeEpitaxyPrefs,
} from '../src/store/viewPrefs.js';
import type { ProcessRow } from '../src/util/processes.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

const LOG_NUMBER = 4;
const SCRIPT_KEY = 'dframe-store';

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

describe('store/viewPrefs: the per-account half', () => {
  it('reads and writes the three account-suffixed keys and the shared activity-days key', () => {
    const store = makeStore();
    writeDesktopConfig(store);

    const { backup } = writeEpitaxyPrefs(store, {
      [environmentsKey(NEW_ACCOUNT)]: ['local', 'ssh'],
      [emptyProjectsKey(NEW_ACCOUNT)]: true,
      [prStatusKey(NEW_ACCOUNT)]: false,
      'code-sessions-state-activity-days': 7,
    });
    expect(backup).toMatch(/\.bak-/);

    const prefs = readViewAccountPrefs(store, NEW_ACCOUNT);
    expect(prefs).toEqual({
      environments: ['local', 'ssh'],
      showEmptyProjects: true,
      showPrStatus: false,
    });
    expect(readEpitaxyPrefs(store)['code-sessions-state-activity-days']).toBe(7);

    // A different account's keys are untouched by another account's write.
    expect(readViewAccountPrefs(store, OLD_ACCOUNT)).toEqual({});
  });

  it('reports legacy keys without ever writing them', () => {
    const store = makeStore();
    writeDesktopConfig(store, {
      'code-sessions-status-filter': 'all',
      'code-sessions-selected-environments': ['local'],
    });
    expect(legacyViewKeysPresent(store).sort()).toEqual(
      ['code-sessions-selected-environments', 'code-sessions-status-filter'].sort(),
    );
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
    writeEpitaxyPrefs(store, { [environmentsKey(NEW_ACCOUNT)]: ['local'] });

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
});

describe('planViewSet / applyViewSet', () => {
  it('group-by state also sets status to active, and says so', () => {
    const store = makeStore();
    makeMachineStore(store, { recentsStatusFilter: 'archived' });
    writeDesktopConfig(store);

    const plan = planViewSet(store, NEW_ACCOUNT, { groupBy: 'state' });
    expect(plan.impliedStatusActive).toBe(true);
    expect(plan.machine.status).toBe('active');
    expect(plan.changes.map((c) => c.field).sort()).toEqual(['group-by', 'status']);
  });

  it('writes the machine half and the account half in one call, leaving neighbours alone', () => {
    const store = makeStore();
    makeMachineStore(store, {
      recentsStatusFilter: 'active',
      sidebarWidth: 400,
      groupByByMode: { chat: 'date' },
    });
    writeDesktopConfig(store, { untouched: 'kept' });

    const plan = planViewSet(store, NEW_ACCOUNT, {
      status: 'archived',
      sort: 'name',
      env: ['local', 'cloud'],
      prStatus: false,
    });
    applyViewSet(plan, { store });

    const state = readViewState(store, NEW_ACCOUNT);
    expect(state.status).toBe('archived');
    expect(state.sort).toBe('alpha');
    expect(state.account.environments).toEqual(['local', 'remote']);
    expect(state.account.showPrStatus).toBe(false);

    // Neighbours of the machine-wide state, and the code-only mode, survive.
    const record = state.machineRecord!;
    expect((record.document.state as Record<string, unknown>).sidebarWidth).toBe(400);
    expect(
      ((record.document.state as Record<string, unknown>).groupByByMode as Record<string, unknown>)
        .chat,
    ).toBe('date');

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
});

describe('planViewCopy / applyViewCopy', () => {
  it('copies only the per-account half, and is idempotent', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    writeEpitaxyPrefs(store, {
      [environmentsKey(OLD_ACCOUNT)]: ['local'],
      [emptyProjectsKey(OLD_ACCOUNT)]: true,
    });

    const first = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);
    expect(first.changes.length).toBeGreaterThan(0);
    applyViewCopy(first, { store });

    expect(readViewAccountPrefs(store, NEW_ACCOUNT)).toEqual({
      environments: ['local'],
      showEmptyProjects: true,
    });

    const second = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);
    expect(second.changes).toEqual([]);
    const result = applyViewCopy(second, { store });
    expect(result.backups).toEqual([]);
  });

  it('refuses to write while Claude Desktop is running', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    writeEpitaxyPrefs(store, { [environmentsKey(OLD_ACCOUNT)]: ['local'] });
    const plan = planViewCopy(store, OLD_ACCOUNT, NEW_ACCOUNT);

    expect(() => applyViewCopy(plan, { store, list: () => desktopRunningOn(store.root) })).toThrow(
      AppRunningError,
    );
  });
});

describe('planLayoutViewCarry', () => {
  it('carries the whole per-account half from the only other account that has any of it', () => {
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
    writeEpitaxyPrefs(store, {
      [emptyProjectsKey(OLD_ACCOUNT)]: true,
      [environmentsKey(OLD_ACCOUNT)]: ['ssh'],
    });

    const carry = planLayoutViewCarry(store, NEW_ACCOUNT);
    expect(carry.from).toEqual(OLD_ACCOUNT);
    expect(carry.account).toEqual({
      [environmentsKey(NEW_ACCOUNT)]: ['ssh'],
      [emptyProjectsKey(NEW_ACCOUNT)]: true,
    });
    expect(carry.changes.map((c) => c.field).sort()).toEqual(['empty-groups', 'env']);
  });

  it('carries nothing when the target already has any of the three set', () => {
    const store = makeStore();
    writeDesktopConfig(store);
    writeEpitaxyPrefs(store, {
      [emptyProjectsKey(NEW_ACCOUNT)]: false,
      [emptyProjectsKey(OLD_ACCOUNT)]: true,
    });

    const carry = planLayoutViewCarry(store, NEW_ACCOUNT);
    expect(carry.changes).toEqual([]);
    expect(carry.account).toEqual({});
  });
});
