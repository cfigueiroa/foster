import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import type { AccountRef, StoreLayout } from '../src/domain/types.js';
import { AppRunningError } from '../src/engine/safety.js';
import {
  applyLayout,
  LayoutWriteError,
  layoutPlanSummary,
  pendingLayoutCounts,
  planLayout,
  syncPendingMigrateValue,
  totalLayoutPending,
} from '../src/engine/layout.js';
import { Ledger } from '../src/ledger/log.js';
import { project } from '../src/ledger/project.js';
import { encodeBatch, encodeVarint32, frameRecords } from '../src/store/format/leveldb.js';
import { groupCardId, scopeKey, type GroupScopes } from '../src/store/groupScopes.js';
import {
  localStorageDir,
  localStorageKey,
  readLocalStorageText,
  readLocalStorageValue,
} from '../src/store/localStorage.js';
import type { ScheduledTasksFile } from '../src/store/routines.js';
import { ScanCache, scanStore } from '../src/store/scanner.js';
import type { ProcessRow } from '../src/util/processes.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

const THIRD_ACCOUNT: AccountRef = {
  accountUuid: '22222222-2222-4222-8222-222222222222',
  organizationUuid: '22222222-2222-4222-8222-222222222223',
};

/** A second organization of `OLD_ACCOUNT` — same account uuid, different org. */
const OLD_ACCOUNT_SECOND_ORG: AccountRef = {
  accountUuid: OLD_ACCOUNT.accountUuid,
  organizationUuid: '00000000-0000-4000-8000-000000000099',
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

/**
 * A synthetic Local Storage database, optionally pre-seeded with a document per
 * key — or, for a string, the bare text the page stores under a key like
 * `ccd-sync-pending:*`.
 */
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
    value: Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(typeof document === 'string' ? document : JSON.stringify(document), 'latin1'),
    ]),
  }));
  writeFileSync(
    logPath,
    entries.length > 0 ? frameRecords(encodeBatch(1n, entries), 0) : Buffer.alloc(0),
  );
}

/**
 * A synthetic Local Storage database holding one record under `scriptKey`
 * tagged with a DOM Storage string tag foster does not recognise (Chromium
 * only ever writes `0x00` or `0x01`) — `readLocalStorageValue` throws
 * `LocalStorageError` on this record rather than decoding it, the case
 * `applyLayout`'s Local Storage pre-check (#R3/#R4) exists to catch.
 */
function makeMachineStoreWithCorruptEntry(store: StoreLayout, scriptKey: string): void {
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
  const entries = [
    {
      key: localStorageKey(scriptKey),
      value: Buffer.concat([Buffer.from([0x02]), Buffer.from('whatever this is', 'latin1')]),
    },
  ];
  writeFileSync(logPath, frameRecords(encodeBatch(1n, entries), 0));
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

  it("finding #10 / #A5: never appends a card to another group's order when it is filed elsewhere", () => {
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

  it('finding #14/(a): "Groups (from N other accounts)" counts distinct account uuids, not account/org directories', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_s1', cliSessionId: 'c1' }));
    writeDesktopConfig(store, {
      // Two organizations of the *same* account, each offering a group.
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-a', name: 'A' }],
        assignments: { [groupCardId('local_s1')]: 'cg-a' },
      },
      [scopeKey(OLD_ACCOUNT_SECOND_ORG)]: {
        groups: [{ id: 'cg-b', name: 'B' }],
        assignments: {},
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    // One account offered these, from two of its organizations — the header
    // must say "1 other account", not 2.
    expect(plan.groups.sources).toBe(1);
  });
});

describe('planLayout — brand-new groups are appended in the most recently active source scope’s own order', () => {
  it('orders new groups by the most recently active source, not discovery order', () => {
    const store = makeStore();
    // OLD_ACCOUNT is less recently active than THIRD_ACCOUNT, and lists its
    // own two groups in the opposite order ("Beta" before "Alpha").
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: 'local_o1', cliSessionId: 'conv-o1', lastActivityAt: 1_000 }),
    );
    writeSession(
      store,
      THIRD_ACCOUNT,
      session({ sessionId: 'local_t1', cliSessionId: 'conv-t1', lastActivityAt: 9_000 }),
    );
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [
          { id: 'cg-beta', name: 'Beta' },
          { id: 'cg-alpha', name: 'Alpha' },
        ],
        assignments: { [groupCardId('local_o1')]: 'cg-beta' },
      },
      [scopeKey(THIRD_ACCOUNT)]: {
        groups: [
          { id: 'cg-t-alpha', name: 'Alpha' },
          { id: 'cg-t-beta', name: 'Beta' },
        ],
        assignments: { [groupCardId('local_t1')]: 'cg-t-alpha' },
      },
    });
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_o1x', cliSessionId: 'conv-o1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_t1x', cliSessionId: 'conv-t1' }));

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    // THIRD_ACCOUNT is the most recently active source, and lists Alpha
    // before Beta — the target's brand-new groups follow that order, not the
    // order `Object.entries` happened to walk the source scopes in.
    expect(plan.groups.items.map((item) => item.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('planLayout / applyLayout — moving a card between groups (local change wins)', () => {
  it('moves a target card to a new group when its current filing is foster’s own', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_s1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_t1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'New Home' }],
        assignments: { [groupCardId('local_s1')]: 'cg-src' },
      },
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-old', name: 'Old Home' }],
        assignments: { [groupCardId('local_t1')]: 'cg-old' },
      },
    });

    const ledger = ledgerAt(store);
    // A previous `applyLayout` run is what put this card in "Old Home".
    ledger.append({
      kind: 'layout_assigned',
      account: NEW_ACCOUNT,
      assignments: [{ cardId: groupCardId('local_t1'), groupName: 'Old Home' }],
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT, ledgerEvents: ledger.read() });
    const item = plan.groups.items.find((entry) => entry.name === 'New Home')!;
    expect(item.assign).toEqual([
      { cardId: groupCardId('local_t1'), title: 'Sample session', movedFrom: 'Old Home' },
    ]);

    const result = applyLayout(plan, applyOpts(store, ledger));
    expect(result.cardsAssigned).toBe(1);
    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetScope.assignments[groupCardId('local_t1')]).toBe(
      targetScope.groups.find((g) => g.name === 'New Home')?.id,
    );

    // The move itself is now on record, so a later run can tell it apart
    // from a filing the user made by hand.
    const events = ledger.read();
    expect(events.some((event) => event.kind === 'layout_assigned')).toBe(true);
  });

  it('leaves a card filed by hand alone, and reports why', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_s1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_t1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'New Home' }],
        assignments: { [groupCardId('local_s1')]: 'cg-src' },
      },
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-old', name: "User's Own" }],
        assignments: { [groupCardId('local_t1')]: 'cg-old' },
      },
    });

    // No `layout_assigned` event at all — the user filed this card by hand.
    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items.find((entry) => entry.name === 'New Home')!;
    expect(item.assign).toEqual([]);
    expect(item.skipped).toEqual([
      { title: 'Sample session', reason: 'filed-by-hand', currentGroup: "User's Own" },
    ]);

    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));
    expect(result.cardsAssigned).toBe(0);
    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetScope.assignments[groupCardId('local_t1')]).toBe('cg-old');
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

    const otherScopeKey =
      '00000000-0000-4000-8000-000000000771/00000000-0000-4000-8000-000000000772';
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

  it('finding #14/(a): "Routines (from N other accounts)" counts distinct account uuids, not account/org directories', () => {
    const store = makeStore();
    const skill = skillFile(store, 'routine');
    // Two organizations of the *same* account, each offering a routine.
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'From org 1',
        enabled: true,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);
    writeTasksFile(store, OLD_ACCOUNT_SECOND_ORG, [
      {
        id: 'r2',
        displayName: 'From org 2',
        enabled: true,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    // The old bug keyed sources on `accountUuid/organizationUuid`, so this
    // counted 2 — one account, wearing two organizations, must count as 1.
    expect(plan.routines.sources).toBe(1);
    expect(plan.routines.bring.map((item) => item.id).sort()).toEqual(['r1', 'r2']);
  });

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

  it("finding #8 / #A7: a null entry in another account's scheduledTasks is skipped, not thrown", () => {
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
            {
              id: 'mine',
              displayName: 'mine',
              enabled: false,
              filePath: skill,
              createdAt: 1,
              cwd: store.root,
            },
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

  it(
    'refuses before writing anything when the target routines file cannot be parsed ' +
      '(finding #3, superseded by #R3: checkable refusals are all-or-nothing)',
    () => {
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
        {
          id: 'r1',
          displayName: 'r1',
          enabled: true,
          filePath: skill,
          createdAt: 1,
          cwd: store.root,
        },
      ]);
      // The target's routines file is unreadable — checkable without writing
      // anything, so #R3 requires this to be caught before the groups write
      // (a different file) is even attempted, not after.
      mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
      writeFileSync(
        path.join(accountDir(store, NEW_ACCOUNT), 'scheduled-tasks.json'),
        '{ not json',
        'utf8',
      );
      const before = readFileSync(store.desktopConfigFile, 'utf8');

      const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
      let thrown: unknown;
      try {
        applyLayout(plan, applyOpts(store, ledgerAt(store)));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LayoutWriteError);
      const message = (thrown as Error).message;
      expect(message).toContain('routines');
      expect(message).toContain('before anything else was written');
      // Old behaviour: the groups write landed first and only the routines
      // write refused. Fixed (#R3): the routines file's own unreadability is
      // checkable without writing, so it is caught up front and nothing —
      // groups included — is written at all.
      expect(readTargetScope(store, NEW_ACCOUNT)).toBeUndefined();
      expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(before);
    },
  );

  it(
    'a genuinely later write failure (not checkable up front) still reports exactly ' +
      'what landed, and logs it to the ledger before throwing (#R3, #R4)',
    () => {
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
        {
          id: 'r1',
          displayName: 'r1',
          enabled: true,
          filePath: skill,
          createdAt: 1,
          cwd: store.root,
        },
      ]);
      // The target's routines "file" is a directory. `readScheduledTasks`
      // treats a read error as "missing" — an ordinary, plannable case — so
      // this is invisible to the up-front check in Phase 1, and only the real
      // write (`backupFile`'s `copyFileSync` on a directory) discovers it.
      mkdirSync(path.join(accountDir(store, NEW_ACCOUNT), 'scheduled-tasks.json'), {
        recursive: true,
      });

      const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
      const ledger = ledgerAt(store);
      let thrown: unknown;
      try {
        applyLayout(plan, applyOpts(store, ledger));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LayoutWriteError);
      const message = (thrown as Error).message;
      expect(message).toContain('groups (config)');
      expect(message).toContain('routines');
      // The groups write really did land, even though the run as a whole failed.
      expect(readTargetScope(store, NEW_ACCOUNT)).toBeDefined();
      // ...and the ledger records exactly that partial landing, before the throw.
      const applied = ledger.read().find((event) => event.kind === 'layout_applied');
      expect(applied).toMatchObject({
        groups: 1,
        groupsCreated: 1,
        routines: 0,
        viewKeysCarried: 0,
      });
    },
  );
});

describe('pendingLayoutCounts / applyLayout agreement, and the layout_applied ledger event (finding #14/(c) and (e))', () => {
  it('a run mixing every kind of write matches pendingLayoutCounts exactly and the ledger records all five counts', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src2', cliSessionId: 'conv-2' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt2', cliSessionId: 'conv-2' }));
    writeDesktopConfig(
      store,
      {
        [scopeKey(OLD_ACCOUNT)]: {
          groups: [{ id: 'cg-src', name: 'Ordered' }],
          assignments: {
            [groupCardId('local_src1')]: 'cg-src',
            [groupCardId('local_src2')]: 'cg-src',
          },
          order: { 'cg-src': [groupCardId('local_src2'), groupCardId('local_src1')] },
        },
      },
      // A view-prefs key OLD_ACCOUNT has and NEW_ACCOUNT does not — carried.
      { epitaxy: { [`code-sessions-show-empty-projects.${OLD_ACCOUNT.accountUuid}`]: true } },
    );
    const skill = path.join(store.root, 'routine.md');
    writeFileSync(skill, '# skill', 'utf8');
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

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 9_999 });
    const preview = pendingLayoutCounts(plan);
    // One new group ("Ordered"), both its cards assigned, both order entries
    // appended, one routine, one view-prefs key — every kind of write at once.
    expect(preview).toEqual({
      groupsCreated: 1,
      cardsAssigned: 2,
      orderEntriesAdded: 2,
      pinsMoved: 0,
      marksBack: 0,
      routinesBrought: 1,
      viewKeysCarried: 1,
      pinsToPin: 0,
      pinsToUnpin: 0,
      machineViewKeysCarried: 0,
      accountPrefsCarried: 0,
    });
    expect(totalLayoutPending(preview)).toBe(7);

    const now = () => new Date(9_999);
    const ledger = ledgerAt(store);
    const result = applyLayout(plan, applyOpts(store, ledger, { now }));

    // What `layout --yes` actually wrote matches what the preview promised —
    // the "pending" line and the real run never disagree.
    expect(result.groupsCreated).toBe(preview.groupsCreated);
    expect(result.cardsAssigned).toBe(preview.cardsAssigned);
    expect(result.orderEntriesAdded).toBe(preview.orderEntriesAdded);
    expect(result.routinesBrought).toBe(preview.routinesBrought);
    expect(result.viewKeysCarried).toBe(preview.viewKeysCarried);

    const applied = ledger.read().find((event) => event.kind === 'layout_applied');
    expect(applied).toMatchObject({
      target: NEW_ACCOUNT,
      groups: 2, // cards assigned, the original field's own meaning
      groupsCreated: 1,
      orderEntriesAdded: 2,
      routines: 1,
      viewKeysCarried: 1,
    });
  });

  it('an event written before groupsCreated/orderEntriesAdded/viewKeysCarried existed still reads and projects', () => {
    const store = makeStore();
    const ledgerPath = path.join(store.root, 'old-ledger.jsonl');
    // Shaped exactly like an event an older build wrote: only the original
    // two fields, none of the three added alongside them.
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        v: 1,
        ts: 1,
        toolVersion: '0.0.0',
        kind: 'layout_applied',
        target: NEW_ACCOUNT,
        groups: 3,
        routines: 2,
      })}\n`,
      'utf8',
    );

    const ledger = new Ledger(ledgerPath);
    const events = ledger.read();
    expect(events).toHaveLength(1);
    expect(() => project(events)).not.toThrow();
  });
});

describe('applyLayout — clearing every section leaves nothing to write (finding #14/(d), "foster layout --no-groups --no-routines --no-view")', () => {
  it('writes nothing and appends no ledger event once every section is cleared the way the CLI flags do', () => {
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
    const skill = path.join(store.root, 'r.md');
    writeFileSync(skill, '# skill', 'utf8');
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

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    // Sanity: there really was something pending before clearing anything.
    expect(totalLayoutPending(pendingLayoutCounts(plan))).toBeGreaterThan(0);

    // What `foster layout --no-groups --no-routines --no-view` does to the
    // plan before handing it to applyLayout — see src/cli/index.ts.
    plan.groups.items = [];
    plan.routines = { ...plan.routines, bring: [] };
    plan.viewPrefs = { changes: [], account: {} };
    expect(totalLayoutPending(pendingLayoutCounts(plan))).toBe(0);

    const ledger = ledgerAt(store);
    const result = applyLayout(plan, applyOpts(store, ledger));

    expect(result.written).toEqual([]);
    expect(result.backups).toEqual([]);
    expect(ledger.read()).toEqual([]);
  });
});

describe('routines: "already here" is decided by idsOnDisk, not the filtered file (#R1)', () => {
  it('planning treats an id on disk as already-here even when the entry itself does not validate', () => {
    const store = makeStore();
    const skill = path.join(store.root, 'routine.md');
    writeFileSync(skill, '# skill', 'utf8');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'From source',
        enabled: true,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);
    // The target already has an entry claiming id 'r1' — but it is missing
    // fields `isScheduledTask` requires, so `readScheduledTasks` drops it
    // from `scheduledTasks` entirely. The id still belongs to something the
    // app shows; `idsOnDisk` sees it regardless of shape.
    writeTasksFile(store, NEW_ACCOUNT, [{ id: 'r1', someOtherShape: true }]);

    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    // Old behaviour: `targetIds` came from the filtered `scheduledTasks`
    // list, which dropped the malformed entry along with its id — so 'r1'
    // looked brand new and was brought in as a duplicate under the same id.
    expect(plan.routines.bring).toEqual([]);
    expect(plan.routines.skipped).toEqual([
      { id: 'r1', displayName: 'From source', reason: 'already-here' },
    ]);
  });

  it('apply rechecks idsOnDisk fresh, so an id the target gains between plan and apply is never duplicated', () => {
    const store = makeStore();
    const skill = path.join(store.root, 'routine.md');
    writeFileSync(skill, '# skill', 'utf8');
    writeTasksFile(store, OLD_ACCOUNT, [
      {
        id: 'r1',
        displayName: 'From source',
        enabled: true,
        filePath: skill,
        createdAt: 1,
        cwd: store.root,
      },
    ]);
    // Target starts with nothing — the plan brings 'r1'.
    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000 });
    expect(plan.routines.bring.map((item) => item.id)).toEqual(['r1']);

    // Something else — the app, or another `foster` run — writes 'r1' to the
    // target in the gap between plan and apply, e.g. across a `--restart`.
    // Even a shape this module cannot validate still claims the id.
    writeTasksFile(store, NEW_ACCOUNT, [{ id: 'r1', someOtherShape: true }]);

    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));
    expect(result.routinesBrought).toBe(0);
    expect(result.written).not.toContain('routines');

    const after = readTasksFile(store, NEW_ACCOUNT);
    expect(after.scheduledTasks).toEqual([{ id: 'r1', someOtherShape: true }]);
  });
});

describe('groups: apply rechecks against fresh disk state (#R2)', () => {
  it('reuses a group of the same NAME created on disk since the plan was taken, instead of minting a duplicate', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items[0]!;
    // At plan time, the target had no "Wanted" group at all.
    expect(item.created).toBe(true);

    // Between plan and apply, the app (or another `foster` run) creates a
    // group of the very same name on disk, under a different id.
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-made-by-app', name: 'Wanted' }],
        assignments: {},
      },
    });

    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));
    // Reused, not minted a second time under the plan's own (now stale) id.
    expect(result.groupsCreated).toBe(0);
    expect(result.cardsAssigned).toBe(1);

    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetScope.groups).toEqual([{ id: 'cg-made-by-app', name: 'Wanted' }]);
    expect(targetScope.assignments[groupCardId('local_tgt1')]).toBe('cg-made-by-app');
  });

  it('leaves a card alone if the disk shows it already assigned somewhere by the time this runs', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const item = plan.groups.items[0]!;
    // At plan time, nothing owned this card yet.
    expect(item.assign).toHaveLength(1);

    // Between plan and apply, the same card gets filed under a different,
    // pre-existing group — the user's own filing, or the app's.
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

    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));
    // Nothing left to do for "Wanted" once the only card it had is dropped —
    // #9's rule, rechecked against fresh disk state: no group is created
    // for zero rows to show.
    expect(result.groupsTouched).toBe(0);
    expect(result.cardsAssigned).toBe(0);
    expect(result.written).toEqual([]);

    const targetScope = readTargetScope(store, NEW_ACCOUNT)!;
    expect(targetScope.assignments[groupCardId('local_tgt1')]).toBe('cg-mine');
    expect(targetScope.groups).toEqual([{ id: 'cg-mine', name: "User's own group" }]);
  });
});

describe('applyLayout — a Local Storage decode failure never succeeds silently (#R4)', () => {
  it('throws LayoutWriteError instead of recording "... FAILED" and returning success', () => {
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
    makeMachineStoreWithCorruptEntry(store, 'LSS-persisted.dframe-group-scopes');

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    let thrown: unknown;
    try {
      applyLayout(plan, applyOpts(store, ledgerAt(store)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LayoutWriteError);
    const message = (thrown as Error).message;
    // Old behaviour: swallowed into `written` as "groups (Local Storage)
    // FAILED: ..." and returned as an ordinary, successful result.
    expect(message).not.toContain('FAILED');
    expect(message).toContain('groups (Local Storage)');
    // Caught before any write lands at all (#R3) — the config file this run
    // also had a valid plan for is untouched.
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(before);
  });
});

describe('groups written to all three places — seeding a document that has never existed (#R5)', () => {
  it('seeds a missing LSS-persisted / dframe-store document from every scope in config, not just the target', () => {
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
      [scopeKey(THIRD_ACCOUNT)]: {
        groups: [{ id: 'cg-third', name: "Third account's own group" }],
        assignments: {},
      },
    });
    // A Local Storage database exists (the sidebar's filter menu was opened
    // once) but neither key has ever been written — the common case for a
    // store nothing has ever grouped through the sidebar yet.
    makeMachineStore(store, {});

    const now = () => new Date(5_000_000);
    const plan = planLayout({ store, target: NEW_ACCOUNT, now: 5_000_000 });
    applyLayout(plan, applyOpts(store, ledgerAt(store), { now }));

    const configScope = readTargetScope(store, NEW_ACCOUNT)!;
    const everyScopeKey = [
      scopeKey(OLD_ACCOUNT),
      scopeKey(THIRD_ACCOUNT),
      scopeKey(NEW_ACCOUNT),
    ].sort();

    const lss = readLocalStorageValue(store, 'LSS-persisted.dframe-group-scopes')!;
    const lssValue = lss.document.value as Record<string, unknown>;
    // Seeded from the full config, not only the target's own merged scope.
    expect(Object.keys(lssValue).sort()).toEqual(everyScopeKey);
    expect(lssValue[scopeKey(THIRD_ACCOUNT)]).toEqual({
      groups: [{ id: 'cg-third', name: "Third account's own group" }],
      assignments: {},
    });
    expect(lssValue[scopeKey(NEW_ACCOUNT)]).toEqual(configScope);
    expect(lss.document.tabId).toBe('');
    expect(lss.document.timestamp).toBe(5_000_000);

    const dframe = readLocalStorageValue(store, 'dframe-store')!;
    // Set only because this document had nothing to inherit it from.
    expect(dframe.document.version).toBe(1);
    const state = dframe.document.state as Record<string, unknown>;
    const customGroups = state.customGroupsByScope as Record<string, unknown>;
    expect(Object.keys(customGroups).sort()).toEqual(everyScopeKey);
    expect(customGroups[scopeKey(NEW_ACCOUNT)]).toEqual(configScope);
  });
});

describe("groups outlive the app's server sync — the page's own sync-pending marker", () => {
  const PENDING = 'ccd-sync-pending:ccd/dframe-store';

  /** One source card grouped as "Wanted", and the target's copy of it. */
  function groupedStore(): StoreLayout {
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
    return store;
  }

  it('marks the target as a pending migration in the same batch, and reports what it filed', () => {
    const store = groupedStore();
    makeMachineStore(store, {});

    const plan = planLayout({ store, target: NEW_ACCOUNT });
    const result = applyLayout(plan, applyOpts(store, ledgerAt(store)));

    expect(readLocalStorageText(store, PENDING)).toBe(`${scopeKey(NEW_ACCOUNT)}|migrate`);
    expect(syncPendingMigrateValue(NEW_ACCOUNT)).toBe(`${scopeKey(NEW_ACCOUNT)}|migrate`);
    expect(result.syncPendingMarked).toBe(true);
    const groupId = readTargetScope(store, NEW_ACCOUNT)!.groups[0]!.id;
    expect(result.assigned).toEqual([
      { cardId: groupCardId('local_tgt1'), groupId, groupName: 'Wanted' },
    ]);
  });

  it("replaces a marker left for another identity — the page would clear it under the target's", () => {
    const store = groupedStore();
    makeMachineStore(store, { [PENDING]: `${scopeKey(OLD_ACCOUNT)}|migrate` });

    const result = applyLayout(
      planLayout({ store, target: NEW_ACCOUNT }),
      applyOpts(store, ledgerAt(store)),
    );

    expect(readLocalStorageText(store, PENDING)).toBe(`${scopeKey(NEW_ACCOUNT)}|migrate`);
    expect(result.syncPendingMarked).toBe(true);
  });

  it.each([
    ['the edit-mode value naming the target', () => scopeKey(NEW_ACCOUNT)],
    ["the page's wildcard", () => '1'],
  ])('leaves %s alone: it already uploads the local state', (_label, value) => {
    const store = groupedStore();
    makeMachineStore(store, { [PENDING]: value() });

    const result = applyLayout(
      planLayout({ store, target: NEW_ACCOUNT }),
      applyOpts(store, ledgerAt(store)),
    );

    expect(readLocalStorageText(store, PENDING)).toBe(value());
    expect(result.syncPendingMarked).toBe(true);
    expect(result.written).toContain('groups (Local Storage)');
  });

  it('cannot mark anything without a Local Storage database, and says so', () => {
    const store = groupedStore();

    const result = applyLayout(
      planLayout({ store, target: NEW_ACCOUNT }),
      applyOpts(store, ledgerAt(store)),
    );

    expect(result.written).toEqual(['groups (config)']);
    expect(result.syncPendingMarked).toBe(false);
    expect(result.assigned).toHaveLength(1);
  });

  it('marks nothing and files nothing when there were no groups to write', () => {
    const store = makeStore();
    writeDesktopConfig(store, {});
    makeMachineStore(store, {});

    const result = applyLayout(
      planLayout({ store, target: NEW_ACCOUNT }),
      applyOpts(store, ledgerAt(store)),
    );

    expect(readLocalStorageText(store, PENDING)).toBeUndefined();
    expect(result.syncPendingMarked).toBe(false);
    expect(result.assigned).toEqual([]);
  });
});

describe('layoutPlanSummary (#R2)', () => {
  it('agrees across two plans against an unchanged store, and disagrees once the store changes', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: 'local_src1', cliSessionId: 'conv-1' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: 'local_tgt1', cliSessionId: 'conv-1' }));
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
    });

    const first = layoutPlanSummary(planLayout({ store, target: NEW_ACCOUNT }));
    const second = layoutPlanSummary(planLayout({ store, target: NEW_ACCOUNT }));
    expect(second).toEqual(first);
    expect(first.cardsAssigned).toBe(1);

    // Something else assigns this same card on disk in the meantime — the
    // plan the CLI showed the user no longer matches what re-planning finds.
    writeDesktopConfig(store, {
      [scopeKey(OLD_ACCOUNT)]: {
        groups: [{ id: 'cg-src', name: 'Wanted' }],
        assignments: { [groupCardId('local_src1')]: 'cg-src' },
      },
      [scopeKey(NEW_ACCOUNT)]: {
        groups: [{ id: 'cg-mine', name: "User's own" }],
        assignments: { [groupCardId('local_tgt1')]: 'cg-mine' },
      },
    });
    const third = layoutPlanSummary(planLayout({ store, target: NEW_ACCOUNT }));
    expect(third).not.toEqual(first);
    expect(third.cardsAssigned).toBe(0);
  });
});

/**
 * `planLayout`'s `cache` option — a sweep's own `ScanCache`, reused instead of
 * reading the store from disk a second time (`ops/sweep.ts`). Plans with and
 * without it must agree exactly, and a card a write touches after the cache
 * already holds it must still be read fresh — the cache is keyed by
 * `mtime`/`size`, never trusted past the moment either one moves.
 */
describe('planLayout — the sweep’s scan cache', () => {
  function twoAccountFixture(): StoreLayout {
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
    return store;
  }

  it('plans exactly the same with a cache as without one', () => {
    const store = twoAccountFixture();

    const withoutCache = planLayout({ store, target: NEW_ACCOUNT });
    const withCache = planLayout({ store, target: NEW_ACCOUNT, cache: new ScanCache() });

    // `groupId` is a fresh `randomUUID()` each time a group is minted, so two
    // independent plans never agree on it even with nothing else different —
    // everything else about the plan must still match exactly.
    const strip = (plan: typeof withoutCache.groups) => ({
      ...plan,
      items: plan.items.map(({ groupId: _groupId, ...rest }) => rest),
    });
    expect(strip(withCache.groups)).toEqual(strip(withoutCache.groups));
  });

  it('reuses a cache already populated by an earlier scan of the same store', () => {
    const store = twoAccountFixture();
    const cache = new ScanCache();

    // Simulates the sweep's own initial whole-store scan, taken before
    // `planLayout` is ever called.
    scanStore(store, undefined, { slim: true, cache });

    const plan = planLayout({ store, target: NEW_ACCOUNT, cache });
    expect(plan.groups.items[0]!.assign).toEqual([
      { cardId: groupCardId('local_tgt1'), title: 'Target row' },
    ]);
  });

  it('still sees a card fresh after a write, even though the cache already held it', () => {
    const store = twoAccountFixture();
    const cache = new ScanCache();

    // Pre-populate the cache — the sweep's own scan, taken at the start of a
    // run, before any pass has written anything.
    scanStore(store, undefined, { slim: true, cache });

    // A write lands on the target card in between — the same shape a
    // fostering pass or a retitle leaves behind mid-sweep.
    const targetFile = path.join(accountDir(store, NEW_ACCOUNT), 'local_tgt1.json');
    const data = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(targetFile, JSON.stringify({ ...data, title: 'Renamed mid-run' }), 'utf8');

    const plan = planLayout({ store, target: NEW_ACCOUNT, cache });
    expect(plan.groups.items[0]!.assign).toEqual([
      { cardId: groupCardId('local_tgt1'), title: 'Renamed mid-run' },
    ]);
  });
});
