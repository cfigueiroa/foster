import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import { AppRunningError } from '../src/engine/safety.js';
import { applyLayout, planLayout } from '../src/engine/layout.js';
import { Ledger } from '../src/ledger/log.js';
import { groupCardId, scopeKey, type GroupScopes } from '../src/store/groupScopes.js';
import type { ScheduledTask, ScheduledTasksFile } from '../src/store/routines.js';
import type { ProcessRow } from '../src/util/processes.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

const THIRD_ACCOUNT: AccountRef = {
  accountUuid: '22222222-2222-4222-8222-222222222222',
  organizationUuid: '22222222-2222-4222-8222-222222222223',
};

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

function writeTasksFile(
  store: StoreLayout,
  account: AccountRef,
  tasks: ScheduledTask[],
  extra: Record<string, unknown> = { recordedSkips: {} },
): string {
  const dir = accountDir(store, account);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'scheduled-tasks.json');
  const document: ScheduledTasksFile = { ...extra, scheduledTasks: tasks };
  writeFileSync(file, JSON.stringify(document), 'utf8');
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
    const result = applyLayout(plan, { store, ledger });
    expect(result.groupsTouched).toBe(1);
    expect(result.cardsAssigned).toBe(1);

    const written = readDesktopConfig(store);
    const scope = (
      (written.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>
    )['dframe-group-scopes'] as GroupScopes;
    const targetScope = scope[scopeKey(NEW_ACCOUNT)]!;
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

    const ledger = ledgerAt(store);
    applyLayout(plan, { store, ledger });

    const scope = readDesktopConfig(store);
    const groups = (
      ((scope.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>)[
        'dframe-group-scopes'
      ] as GroupScopes
    )[scopeKey(NEW_ACCOUNT)]!;
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

    const ledger = ledgerAt(store);
    const result = applyLayout(plan, { store, ledger });
    expect(result.cardsAssigned).toBe(0);

    const scope = readDesktopConfig(store);
    const targetScope = (
      ((scope.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>)[
        'dframe-group-scopes'
      ] as GroupScopes
    )[scopeKey(NEW_ACCOUNT)]!;
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

  it('plans nothing on a second run — idempotent', () => {
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
    applyLayout(planLayout({ store, target: NEW_ACCOUNT }), { store, ledger });

    const again = planLayout({ store, target: NEW_ACCOUNT });
    const pending = again.groups.items.reduce((n, item) => n + item.assign.length, 0);
    expect(pending).toBe(0);
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

    const ledger = ledgerAt(store);
    applyLayout(plan, { store, ledger });
    const scope = readDesktopConfig(store);
    const targetScope = (
      ((scope.preferences as Record<string, unknown>).epitaxyPrefs as Record<string, unknown>)[
        'dframe-group-scopes'
      ] as GroupScopes
    )[scopeKey(NEW_ACCOUNT)]!;
    expect(targetScope.order?.[item.groupId]).toEqual([
      groupCardId('local_tgt2'),
      groupCardId('local_tgt1'),
    ]);
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
    const ledger = ledgerAt(store);
    const result = applyLayout(plan, { store, ledger, now });
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

    const ledger = ledgerAt(store);
    applyLayout(planLayout({ store, target: NEW_ACCOUNT, now: 9_999 }), { store, ledger });

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
