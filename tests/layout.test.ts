import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import { AppRunningError } from '../src/engine/safety.js';
import { applyLayout, LayoutWriteError, planLayout } from '../src/engine/layout.js';
import { Ledger } from '../src/ledger/log.js';
import { encodeBatch, encodeVarint32, frameRecords } from '../src/store/format/leveldb.js';
import { groupCardId, scopeKey, type GroupScopes } from '../src/store/groupScopes.js';
import { localStorageDir, localStorageKey, readLocalStorageValue } from '../src/store/localStorage.js';
import type { ScheduledTask, ScheduledTasksFile } from '../src/store/routines.js';
import type { ProcessRow } from '../src/util/processes.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

const THIRD_ACCOUNT: AccountRef = {
  accountUuid: '22222222-2222-4222-8222-222222222222',
  organizationUuid: '22222222-2222-4222-8222-222222222223',
};

/** No process ever reported running — the app is always "closed" to these tests. */
const closed = (): ProcessRow[] => [];

/** Redirects every backup this run takes into the test's own temp tree. */
function testEnv(store: StoreLayout): NodeJS.ProcessEnv {
  return { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') };
}

/** The options every `applyLayout` call in this file needs: closed app, isolated backups. */
function applyOpts(
  store: StoreLayout,
  ledger: Ledger,
  extra: { now?: () => Date } = {},
): Parameters<typeof applyLayout>[1] {
  return { store, ledger, list: closed, env: testEnv(store), ...extra };
}

function writeDesktopConfig(
  store: StoreLayout,
  scopes: GroupScopes,
  extra: {
    topLevel?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    epitaxy?: Record<string, unknown>;
  } = {},
): void {
  writeFileSync(
    store.desktopConfigFile,
    JSON.stringify({
      ...extra.topLevel,
      preferences: {
        ...extra.preferences,
        epitaxyPrefs: {
          ...extra.epitaxy,
          'dframe-group-scopes': scopes,
        },
      },
    }),
    'utf8',
  );
}

function readDesktopConfig(store: StoreLayout): Record<string, unknown> {
  return JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<string, unknown>;
}

function readTargetScope(store: StoreLayout, account: AccountRef): GroupScopes[string] | undefined {
  const scope = readDesktopConfig(store);
  const scopes = (
    (scope.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>
  )['dframe-group-scopes'] as GroupScopes | undefined;
  return scopes?.[scopeKey(account)];
}

function writeTasksFile(
  store: StoreLayout,
  account: AccountRef,
  tasks: unknown[],
  extra: Record<string, unknown> = { recordedSkips: {} },
): string {
  const dir = accountDir(store, account);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'scheduled-tasks.json');
  writeFileSync(file, JSON.stringify({ ...extra, scheduledTasks: tasks }), 'utf8');
  return file;
}

function readTasksFile(store: StoreLayout, account: AccountRef): ScheduledTasksFile {
  return JSON.parse(
    readFileSync(path.join(accountDir(store, account), 'scheduled-tasks.json'), 'utf8'),
  ) as ScheduledTasksFile;
}

function ledgerAt(store: StoreLayout): Ledger {
  return new Ledger(path.join(store.root, 'foster-ledger.jsonl'));
}

/** A ProcessLister reporting Claude Desktop running on this store's root. */
function desktopRunningOn(root: string): ProcessRow[] {
  const exe =
    'C:\\home\\AppData\\Local\\Packages\\Claude_0.0.0.0_x64__test\\LocalCache\\Roaming\\Claude\\app\\Claude.exe';
  return [
    {
      pid: 600,
      parentPid: 9,
      name: 'claude.exe',
      path: exe,
      commandLine: `"${exe}" --user-data-dir="${root}"`,
    },
  ];
}

const MACHINE_LOG_NUMBER = 4;

/** A synthetic Local Storage database, optionally pre-seeded with a document per key. */
function makeMachineStore(store: StoreLayout, seed: Record<string, unknown> = {}): void {
  const dir = localStorageDir(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  const edit = Buffer.concat([
    encodeVarint32(1),
    encodeVarint32(8),
    Buffer.from('idb_cmp1'),
    encodeVarint32(2),
    encodeVarint32(MACHINE_LOG_NUMBER),
  ]);
  writeFileSync(path.join(dir, 'MANIFEST-000001'), frameRecords(edit, 0));

  const logPath = path.join(dir, `${String(MACHINE_LOG_NUMBER).padStart(6, '0')}.log`);
  const entries = Object.entries(seed).map(([scriptKey, document]) => ({
    key: localStorageKey(scriptKey),
    value: Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(document), 'latin1')]),
  }));
  writeFileSync(logPath, entries.length > 0 ? frameRecords(encodeBatch(1n, entries), 0) : Buffer.alloc(0));
}

describe('planLayout / applyLayout — groups', () => {
  it('creates a fresh group by name when the target has none of it', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1', title: 'Target row' }),
    );
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Código & CI' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(plan.groups.sources).toBe(1);
    expect(plan.groups.items).toHaveLength(1);
    const item = plan.groups.items[0]!;
    expect(item.name).toBe('Código & CI');
    expect(item.created).toBe(true);
    expect(item.assign).toEqual([{ cardId: groupCardId('local_tgt1'), title: 'Target row' }]);

    const ledger = ledgerAt(store);
    const result = applyLayout(plan, applyOpts(store, ledger));
    expect(result.groupsTouched).toBe(1);
    expect(result.cardsAssigned).toBe(1);
    expect(result.written).toContain('groups (config)');
    // No Local Storage database exists in this fixture — the triple-write is
    // best-effort and skips gracefully rather than failing the run.
    expect(result.written).not.toContain('groups (Local Storage)');

    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetScope.groups).toEqual([{ id: item.groupId, name: 'Código & CI' }]);
    expect(targetScope.assignments[groupCardId('local_tgt1')]).toBe(item.groupId);
  });

  it('reuses a group the target already has, by name', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Existing' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-existing', name: 'Existing' }],
        assignments: {},
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items[0]!;
    expect(item.created).toBe(false);
    expect(item.groupId).toBe('cg-existing');

    applyLayout(plan, applyOpts(store, ledgerAt(store)));

    const groups = readTargetScope(store, NEW_ACCOUNT)!;
    // Still exactly one group of that name — no duplicate was minted.
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]!.id).toBe('cg-existing');
  });

  it('leaves a target card that already has an assignment alone', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-mine', name: "User's own group" }],
        assignments: { [groupCardId('local_tgt1')]: 'cg-mine' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items.find((entry) => entry.name === 'Wanted')!;
    expect(item.assign).toEqual([]);

    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));
    expect(result.cardsAssigned).toBe(0);

    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    // The user's own filing is untouched.
    expect(targetScope.assignments[groupCardId('local_tgt1')]).toBe('cg-mine');
  });

  it('skips an archived target card, and reports it', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'local_src1', cliSessionId: 'conv-1', title: 'Workflow consolidation' }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: 'local_tgt1',
        cliSessionId: 'conv-1',
        isArchived: true,
        title: 'Old work',
      }),
    );
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items[0]!;
    expect(item.assign).toEqual([]);
    // Named the way the conversation is known at its source — the title
    // `resolveTarget` could not use, since the only candidate is archived.
    expect(item.skipped).toEqual([{ title: 'Workflow consolidation', reason: 'archived' }]);
  });

  it('finding #9 / #A4: never creates a group in the target with nothing assigned to it', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'c1' }));
    // No target card anywhere names this conversation — the only candidate
    // for "Ghost" is missing entirely.
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_other', cliSessionId: 'zzz' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-a', name: 'Ghost' }],
        assignments: { [groupCardId('local_src1')]: 'cg-a' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));

    expect(result.cardsAssigned).toBe(0);
    expect(result.groupsTouched).toBe(0);
    expect(result.written).toEqual([]);
    // The old bug wrote an empty "Ghost" group into the target regardless —
    // there is nothing here for the sidebar to show for it, so nothing is
    // written at all.
    expect(readTargetScope(store, NEW_ACCOUNT)).toBeUndefined();
  });

  it('reports a source card with no target counterpart as missing', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'local_src1', cliSessionId: 'conv-only-there' }),
    );
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items[0]!;
    expect(item.skipped[0]).toMatchObject({ reason: 'missing' });
  });

  it('plans and writes nothing on a second run — idempotent at the file level', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const ledger = ledgerAt(store);
    applyLayout(planLayout({ store, target: NEW_ACCOUNT }), applyOpts(store, ledger));

    const again = planLayout({ store, target: NEW_ACCOUNT });
    const pending = again.groups.items.reduce((n, item) => n + item.assign.length, 0);
    expect(pending).toBe(0);

    // Applying the second, empty plan must not touch the file at all — same
    // bytes, same mtime, not merely "the same JSON value".
    const beforeBytes = readFileSync(store.desktopConfigFile);
    const beforeMtime = statSync(store.desktopConfigFile).mtimeMs;
    const result = applyLayout(again, applyOpts(store, ledger));
    expect(result.written).toEqual([]);
    expect(readFileSync(store.desktopConfigFile)).toEqual(beforeBytes);
    expect(statSync(store.desktopConfigFile).mtimeMs).toBe(beforeMtime);
  });

  it('resolves a naming conflict by the source card with the latest activity, and reports it', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'local_src1', cliSessionId: 'conv-1', lastActivityAt: 1_000 }),
    );
    writeSession(
      store,
      THIRD_ACCOUNT,
      session({ sessionId: 'local_src2', cliSessionId: 'conv-1', lastActivityAt: 2_000 }),
    );
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-old', name: 'Older claim' }],
        assignments: { [groupCardId('local_src1')]: 'cg-old' },
      },
      [scopeKey(THIRD_ACCOUNT)]: {
        groups: [{ id: 'cg-new', name: 'Newer claim' }],
        assignments: { [groupCardId('local_src2')]: 'cg-new' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(plan.groups.conflicts).toHaveLength(1);
    expect(plan.groups.conflicts[0]).toMatchObject({
      chosen: 'Newer claim',
      others: ['Older claim'],
    });
    const winning = plan.groups.items.find((item) => item.name === 'Newer claim')!;
    expect(winning.assign).toHaveLength(1);
    const losing = plan.groups.items.find((item) => item.name === 'Older claim');
    expect(losing?.assign ?? []).toHaveLength(0);
  });

  it('carries a partial manual order', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src2', cliSessionId: 'conv-2' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt2', cliSessionId: 'conv-2' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Ordered' }],
        assignments: {
          [groupCardId('local_src1')]: 'cg-src',
          [groupCardId('local_src2')]: 'cg-src',
        },
        order: { 'cg-src': [groupCardId('local_src2'), groupCardId('local_src1')] },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items[0]!;
    expect(item.order).toEqual([groupCardId('local_tgt2'), groupCardId('local_tgt1')]);

    applyLayout(plan, applyOpts(store, ledgerAt(store)));
    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetScope.order?.[item.groupId]).toEqual([
      groupCardId('local_tgt2'),
      groupCardId('local_tgt1'),
    ]);
  });

  it('finding #10 / #A5: never appends a card to another group\'s order when it is filed elsewhere', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_s', cliSessionId: 'c1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_t', cliSessionId: 'c1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-y', name: 'Y' }],
        assignments: { [groupCardId('local_s')]: 'cg-y' },
        order: { 'cg-y': [groupCardId('local_s')] },
      },
      // The target already filed this card in "X" by hand.
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-x', name: 'X' }],
        assignments: { [groupCardId('local_t')]: 'cg-x' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const y = plan.groups.items.find((item) => item.name === 'Y')!;
    // "Y" gets created (a group of that name did not exist), but nothing is
    // assigned to it — the card the source proposed for it is already filed
    // in "X" here — and the old bug still appended it to Y's order anyway.
    expect(y.assign).toEqual([]);
    expect(y.appendedOrder).toEqual([]);

    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));
    // Nothing to write for "Y" at all — see finding #9.
    expect(result.written).toEqual([]);
    const targetX = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetX.assignments[groupCardId('local_t')]).toBe('cg-x');
  });

  it('finding #8 / #A6: a source scope with groups but no assignments is skipped, not thrown', () => {
    const store = makeStore();
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: { groups: [] } as unknown as GroupScopes[string],
    });

    expect(() => planLayout({ store, target: NEW_ACCOUNT })).not.toThrow();
    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(plan.groups.items).toEqual([]);
    expect(plan.groups.sources).toBe(0);
  });
});

describe('planLayout / applyLayout — groups written to all three places (finding #2)', () => {
  it('writes the config scope, LSS-persisted.dframe-group-scopes and dframe-store.state.customGroupsByScope together', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1', title: 'Row' }),
    );
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const otherScopeKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    makeMachineStore(store, {
      'LSS-persisted.dframe-group-scopes': {
        value: { [otherScopeKey]: { groups: [{ id: 'cg-z', name: 'Kept' }], assignments: {} } },
        tabId: '',
        timestamp: 1,
      },
      'dframe-store': {
        state: {
          sidebarWidth: 420,
          customGroupsByScope: {
            [otherScopeKey]: { groups: [{ id: 'cg-z', name: 'Kept' }], assignments: {} },
          },
        },
        version: 1,
      },
    });

    const now = () => new Date(5_000_000);
    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000_000 });
    const result = applyLayout(plan, applyOpts(store, ledgerAt(store), { now }));
    expect(result.written).toContain('groups (config)');
    expect(result.written).toContain('groups (Local Storage)');

    const targetKey = scopeKey(NEW_ACCOUNT);
    const configScope = readTargetScope(store, NEW_ACCOUNT)!;

    const lss = readLocalStorageValue(store, 'LSS-persisted.dframe-group-scopes')!;
    const lssValue = lss.document.value as Record<string, unknown>;
    expect(lssValue[targetKey]).toEqual(configScope);
    // The other scope already there survives.
    expect(lssValue[otherScopeKey]).toBeDefined();
    expect(lss.document.timestamp).toBe(5_000_000);

    const dframe = readLocalStorageValue(store, 'dframe-store')!;
    const state = dframe.document.state as Record<string, unknown>;
    const customGroups = state.customGroupsByScope as Record<string, unknown>;
    expect(customGroups[targetKey]).toEqual(configScope);
    expect(customGroups[otherScopeKey]).toBeDefined();
    // A neighbour of `state` outside `customGroupsByScope` survives too.
    expect(state.sidebarWidth).toBe(420);
  });
});

describe('planLayout / applyLayout — routines', () => {
  function skillFile(store: StoreLayout, name: string): string {
    const file = path.join(store.root, `${name}.md`);
    writeFileSync(file, '# skill', 'utf8');
    return file;
  }

  it('dedups by id, keeping the copy with the latest createdAt', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'Older copy',
        cronExpression: '0 9 * * 1',
        enabled: true,
        filePath: skill,
        createdAt: 1_000,
        cwd: store.root,
      },
    ]);
    writeTasksFile(store, THIRD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'Newer copy',
        cronExpression: '0 9 * * 2',
        enabled: true,
        filePath: skill,
        createdAt: 2_000,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 3_000 });
    expect(plan.routines.bring).toHaveLength(1);
    expect(plan.routines.bring[0]).toMatchObject({ id: 'r1', displayName: 'Newer copy' });
  });

  it('finding #1: dedups across ALL sources first, then drops the id if its newest copy is disabled', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    // The newest copy of this id has since been disabled on purpose.
    writeTasksFile(store, THIRD_ACCOUNT, [
      {
        id: 'vigia-launchd-instalar-apos-merge',
        displayName: 'Newest, now disabled',
        cronExpression: '20 */2 * * *',
        enabled: false,
        filePath: skill,
        createdAt: 2_000,
        cwd: store.root,
      },
    ]);
    // An older account still has it enabled.
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'vigia-launchd-instalar-apos-merge',
        displayName: 'Older, still enabled',
        cronExpression: '20 */2 * * *',
        enabled: true,
        filePath: skill,
        createdAt: 1_000,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 3_000 });
    // The old (buggy) order asked "enabled?" per source before dedup, so the
    // older *enabled* copy won the id outright and was brought back to life
    // in the target. Fixed: the newest copy wins the id regardless of its
    // enabled flag, and only then is "enabled" asked — of that winner alone.
    expect(plan.routines.bring).toEqual([]);
    expect(plan.routines.skipped).toEqual([
      {
        id: 'vigia-launchd-instalar-apos-merge',
        displayName: 'Newest, now disabled',
        reason: 'disabled',
      },
    ]);
  });

  it('skips a routine the target already has, enabled or not', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      { id: 'r1', displayName: 'X', enabled: true, filePath: skill, createdAt: 1, cwd: store.root },
    ]);
    writeTasksFile(store, NEW_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'X',
        enabled: false,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(plan.routines.bring).toHaveLength(0);
    expect(plan.routines.skipped).toEqual([{ id: 'r1', displayName: 'X', reason: 'already-here' }]);
  });

  it('skips a one-shot whose moment has already passed', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'Once',
        enabled: true,
        filePath: skill,
        fireAt: 1_000,
        createdAt: 1,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(plan.routines.bring).toHaveLength(0);
    expect(plan.routines.skipped[0]).toMatchObject({
      id: 'r1',
      reason: 'missed-one-shot',
      firedAt: 1_000,
    });
  });

  it('brings a one-shot still in the future', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'Once',
        enabled: true,
        filePath: skill,
        fireAt: 9_000,
        createdAt: 1,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(plan.routines.bring).toHaveLength(1);
    expect(plan.routines.bring[0]).toMatchObject({ id: 'r1', fireAt: 9_000 });
  });

  it('skips a routine whose SKILL.md is gone', () => {
    const store = makeStore();
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'Ghost',
        enabled: true,
        filePath: path.join(store.root, 'nowhere', 'SKILL.md'),
        createdAt: 1,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(plan.routines.bring).toHaveLength(0);
    expect(plan.routines.skipped[0]).toMatchObject({ id: 'r1', reason: 'missing-skill' });
  });

  it('finding #8 / #A7: a null entry in another account\'s scheduledTasks is skipped, not thrown', () => {
    const store = makeStore();
    writeTasksFile(store, OLD_ACCOUNT, [null]);

    expect(() => planLayout({ store, target: NEW_ACCOUNT, now: 5_000 })).not.toThrow();
    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(plan.routines.bring).toEqual([]);
  });

  it('finding #5: strips a UTF-8 BOM before parsing, and merges rather than replacing', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'r1',
        cronExpression: '0 9 * * 1',
        enabled: true,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);
    mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
    const targetFile = path.join(accountDir(store, NEW_ACCOUNT), 'scheduled-tasks.json');
    writeFileSync(
      targetFile,
      '\uFEFF' +
        JSON.stringify({
          scheduledTasks: [
            { id: 'mine', displayName: 'mine', enabled: false, filePath: skill, createdAt: 1, cwd: store.root },
          ],
          recordedSkips: { a: 1 },
        }),
      'utf8',
    );

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    applyLayout(plan, applyOpts(store, ledgerAt(store)));

    const after = readTasksFile(store, NEW_ACCOUNT);
    expect(after.scheduledTasks.map((t) => t.id).sort()).toEqual(['mine', 'r1']);
    expect(after.recordedSkips).toEqual({ a: 1 });
  });

  it('finding #5: a genuinely unreadable target scheduled-tasks.json is refused, not replaced', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'r1',
        enabled: true,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);
    mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
    const targetFile = path.join(accountDir(store, NEW_ACCOUNT), 'scheduled-tasks.json');
    writeFileSync(targetFile, '{ this is not JSON', 'utf8');
    const before = readFileSync(targetFile, 'utf8');

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(() => applyLayout(plan, applyOpts(store, ledgerAt(store)))).toThrow(LayoutWriteError);
    // Untouched — never replaced wholesale on the strength of the plan alone.
    expect(readFileSync(targetFile, 'utf8')).toBe(before);
  });

  it('resets createdAt and drops lastRunAt, lastScheduledFor and notifySessionId', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'Carrying history',
        cronExpression: '0 9 * * 1',
        enabled: true,
        filePath: skill,
        createdAt: 1_000,
        cwd: store.root,
        lastRunAt: 1_500,
        lastScheduledFor: 1_600,
        notifySessionId: 'local_somewhere',
      },
    ]);

    const now = () => new Date(9_999);
    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 9_999 });
    const result = applyLayout(plan, applyOpts(store, ledgerAt(store), { now }));
    expect(result.routinesBrought).toBe(1);

    const written = readTasksFile(store, NEW_ACCOUNT).scheduledTasks[0]!;
    expect(written.createdAt).toBe(9_999);
    expect(written.lastRunAt).toBeUndefined();
    expect(written.lastScheduledFor).toBeUndefined();
    expect(written.notifySessionId).toBeUndefined();
    expect(written.enabled).toBe(true);
  });
});

describe('applyLayout — preserving what it does not own', () => {
  it('preserves unrelated keys of claude_desktop_config.json and of scheduled-tasks.json', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(
      store,
      {
        [scopeKey(OLD_ACCOUNT)]: {
          groups: [{ id: 'cg-src', name: 'Wanted' }],
          assignments: { [groupCardId('local_src1')]: 'cg-src' },
        },
      },
      {
        topLevel: { mcpServers: { thing: { command: 'x' } } },
        preferences: { menuBarEnabled: true },
        epitaxy: { someOtherEpitaxyKey: 'kept' },
      },
    );
    const skill = path.join(store.root, 'routine.md');
    writeFileSync(skill, '# skill', 'utf8');
    writeTasksFile(
      store,
      OLD_ACCOUNT,
      [
        {
          id: 'r1',
          displayName: 'X',
          cronExpression: '0 9 * * 1',
          enabled: true,
          filePath: skill,
          createdAt: 1,
          cwd: store.root,
        },
      ],
      { recordedSkips: { foo: 'bar' }, sundayAliasBoundaryStamped: true },
    );

    applyLayout(
      planLayout({ store, target: NEW_ACCOUNT, now: 9_999 }),
      applyOpts(store, ledgerAt(store)),
    );

    const written = readDesktopConfig(store);
    expect(written.mcpServers).toEqual({ thing: { command: 'x' } });
    expect((written.preferences as Record<string, unknown>).menuBarEnabled).toBe(true);
    expect(
      ((written.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>)
        .someOtherEpitaxyKey,
    ).toBe('kept');

    const tasksFile = readTasksFile(store, NEW_ACCOUNT);
    expect(tasksFile.scheduledTasks).toHaveLength(1);
  });
});

describe('applyLayout — refuses while the app is running', () => {
  it('throws instead of writing', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const before = readFileSync(store.desktopConfigFile, 'utf8');
    const ledger = ledgerAt(store);
    const plan = planLayout({ store, target: NEW_ACCOUNT });

    expect(() =>
      applyLayout(plan, { store, ledger, list: () => desktopRunningOn(store.root) }),
    ).toThrow(AppRunningError);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(before);
  });
});

describe('applyLayout — backups (findings #3 and #4)', () => {
  it('a run touching config twice (groups, then the view carry) takes two distinct backups, the first the true original', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_s', cliSessionId: 'c1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_t', cliSessionId: 'c1' }));
    writeDesktopConfig(
      store,
      {
        [scopeKey(OLD_ACCOUNT)]: {
          groups: [{ id: 'cg-a', name: 'G' }],
          assignments: { [groupCardId('local_s')]: 'cg-a' },
        },
      },
      { epitaxy: { [`code-sessions-show-empty-projects.${OLD_ACCOUNT.accountUuid}`]: true } },
    );
    const originalText = readFileSync(store.desktopConfigFile, 'utf8');

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    expect(Object.keys(plan.viewPrefs.account).length).toBeGreaterThan(0);

    const now = () => new Date('2026-09-22T12:34:56.000Z');
    const result = applyLayout(plan, applyOpts(store, ledgerAt(store), { now }));

    expect(result.backups.length).toBe(2);
    // The old bug: both writes computed the same second-resolution backup
    // name, so the second write's "backup" silently overwrote the first,
    // losing the true pre-run original.
    expect(result.backups[0]).not.toBe(result.backups[1]);
    expect(readFileSync(result.backups[0]!, 'utf8')).toBe(originalText);
  });

  it('reports exactly which files were written before a later one fails (finding #3)', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_s', cliSessionId: 'c1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_t', cliSessionId: 'c1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-a', name: 'G' }],
        assignments: { [groupCardId('local_s')]: 'cg-a' },
      },
    });
    const skill = path.join(store.root, 'r.md');
    writeFileSync(skill, '# skill', 'utf8');
    writeTasksFile(store, OLD_ACCOUNT, [
      { id: 'r1', displayName: 'r1', enabled: true, filePath: skill, createdAt: 1, cwd: store.root },
    ]);
    // The target's routines file is unreadable, so the routines write must
    // refuse — after the groups write (a different file) already landed.
    mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
    writeFileSync(
      path.join(accountDir(store, NEW_ACCOUNT), 'scheduled-tasks.json'),
      '{ not json',
      'utf8',
    );

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    let thrown: unknown;
    try {
      applyLayout(plan, applyOpts(store, ledgerAt(store)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LayoutWriteError);
    const message = (thrown as Error).message;
    expect(message).toContain('groups (config)');
    expect(message).toContain('routines');
    // The groups write really did land, even though the run as a whole failed.
    expect(readTargetScope(store, NEW_ACCOUNT)).toBeDefined();
  });
});
