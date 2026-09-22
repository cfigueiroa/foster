import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoreLayout } from '../src/domain/types.js';
import {
  readGroupScopes,
  readGroupScopesReport,
  scopeKey,
  writeGroupScope,
} from '../src/store/groupScopes.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

/**
 * `readGroupScopes` used to drop a whole scope the moment one entry in it was
 * malformed (a `null` assignment being the case measured on a real store, see
 * CLAUDE.md), and `writeGroupScope` used to replace a scope wholesale rather
 * than merge into it. Together, a layout write aimed at a target scope with
 * one bad assignment wiped every other group and assignment the account
 * actually had. These tests exercise the fix: reading tolerates a bad entry
 * without losing its siblings, and writing merges onto whatever the file
 * holds right now rather than overwriting it.
 */

const TARGET = OLD_ACCOUNT;
const OTHER = NEW_ACCOUNT;
const targetKey = scopeKey(TARGET);
const otherKey = scopeKey(OTHER);

function writeRawConfig(store: StoreLayout, scopes: Record<string, unknown>): void {
  writeFileSync(
    store.desktopConfigFile,
    JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': scopes } } }),
    'utf8',
  );
}

function rawScopes(store: StoreLayout): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as {
    preferences: { epitaxyPrefs: { 'dframe-group-scopes': Record<string, unknown> } };
  };
  return parsed.preferences.epitaxyPrefs['dframe-group-scopes'];
}

/** Redirects backups into the test's own temp tree, never the real `~/.foster`. */
function testEnv(store: StoreLayout): NodeJS.ProcessEnv {
  return { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') };
}

describe('readGroupScopesReport / readGroupScopes: a bad entry does not sink its scope', () => {
  it('keeps every other assignment when one is null, and counts it', () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: {
        groups: [{ id: 'g1', name: 'Keep' }],
        assignments: { 'code:local_a': 'g1', 'code:local_bad': null },
      },
    });

    const report = readGroupScopesReport(store);
    expect(report.scopes[targetKey]).toEqual({
      groups: [{ id: 'g1', name: 'Keep' }],
      assignments: { 'code:local_a': 'g1' },
    });
    expect(report.skippedEntries[targetKey]).toBe(1);

    // The plain, backward-compatible view agrees.
    expect(readGroupScopes(store)[targetKey]?.assignments).toEqual({ 'code:local_a': 'g1' });
  });

  it('keeps every other group when one is malformed, and counts it', () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: {
        groups: [{ id: 'g1', name: 'Keep' }, { id: 'g2' }, 'not-even-an-object'],
        assignments: {},
      },
    });

    const report = readGroupScopesReport(store);
    expect(report.scopes[targetKey]?.groups).toEqual([{ id: 'g1', name: 'Keep' }]);
    expect(report.skippedEntries[targetKey]).toBe(2);
  });

  it('keeps every other order list when one is malformed, and counts it', () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: {
        groups: [
          { id: 'g1', name: 'A' },
          { id: 'g2', name: 'B' },
        ],
        assignments: {},
        order: { g1: ['code:local_a', 'code:local_b'], g2: 'not-a-list' },
      },
    });

    const report = readGroupScopesReport(store);
    expect(report.scopes[targetKey]?.order).toEqual({ g1: ['code:local_a', 'code:local_b'] });
    expect(report.skippedEntries[targetKey]).toBe(1);
  });
});

describe('writeGroupScope merges into the scope on disk instead of replacing it', () => {
  it('a null assignment in the target scope survives a write that adds one', () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: {
        groups: [{ id: 'g1', name: 'Keep' }],
        assignments: { 'code:local_a': 'g1', 'code:local_bad': null },
      },
    });

    writeGroupScope(
      store,
      TARGET,
      { groups: [{ id: 'g2', name: 'New' }], assignments: { 'code:local_new': 'g2' } },
      { env: testEnv(store) },
    );

    const scope = rawScopes(store)[targetKey] as {
      groups: unknown[];
      assignments: Record<string, unknown>;
    };
    // The pre-existing group and assignment are still there...
    expect(scope.groups).toContainEqual({ id: 'g1', name: 'Keep' });
    expect(scope.assignments['code:local_a']).toBe('g1');
    // ...the malformed entry the caller never mentioned rode along too...
    expect(scope.assignments['code:local_bad']).toBeNull();
    // ...and the new group/assignment this call asked for landed.
    expect(scope.groups).toContainEqual({ id: 'g2', name: 'New' });
    expect(scope.assignments['code:local_new']).toBe('g2');
  });

  it('keeps a scope-level key this codebase does not model', () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: {
        groups: [],
        assignments: {},
        somethingFutureAppKeeps: { nested: true },
      },
    });

    writeGroupScope(
      store,
      TARGET,
      { groups: [{ id: 'g1', name: 'New' }], assignments: {} },
      { env: testEnv(store) },
    );

    const scope = rawScopes(store)[targetKey] as Record<string, unknown>;
    expect(scope.somethingFutureAppKeeps).toEqual({ nested: true });
    expect(scope.groups).toContainEqual({ id: 'g1', name: 'New' });
  });

  it('keeps another order list when the write only touches one group', () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: {
        groups: [
          { id: 'g1', name: 'A' },
          { id: 'g2', name: 'B' },
        ],
        assignments: {},
        order: { g1: ['code:local_a'], g2: 'not-a-list' },
      },
    });

    writeGroupScope(
      store,
      TARGET,
      {
        groups: [
          { id: 'g1', name: 'A' },
          { id: 'g2', name: 'B' },
        ],
        assignments: {},
        order: { g1: ['code:local_a', 'code:local_c'] },
      },
      { env: testEnv(store) },
    );

    const scope = rawScopes(store)[targetKey] as { order: Record<string, unknown> };
    expect(scope.order.g1).toEqual(['code:local_a', 'code:local_c']);
    // g2's malformed raw list was never mentioned by this write, so it rides along untouched.
    expect(scope.order.g2).toBe('not-a-list');
  });

  it("never touches another account's scope", () => {
    const store = makeStore();
    writeRawConfig(store, {
      [targetKey]: { groups: [], assignments: {} },
      [otherKey]: {
        groups: [{ id: 'o1', name: 'Other' }],
        assignments: { 'code:local_x': 'o1' },
      },
    });

    writeGroupScope(
      store,
      TARGET,
      { groups: [{ id: 'g1', name: 'New' }], assignments: { 'code:local_new': 'g1' } },
      { env: testEnv(store) },
    );

    expect(rawScopes(store)[otherKey]).toEqual({
      groups: [{ id: 'o1', name: 'Other' }],
      assignments: { 'code:local_x': 'o1' },
    });
  });

  it('still refuses on a lossy number literal before merging anything', () => {
    const store = makeStore();
    const text =
      '{"preferences":{"epitaxyPrefs":{"dframe-group-scopes":{"' +
      targetKey +
      '":{"groups":[],"assignments":{"code:local_bad":null}}},"scale":1.0}}}';
    writeFileSync(store.desktopConfigFile, text, 'utf8');

    expect(() =>
      writeGroupScope(
        store,
        TARGET,
        { groups: [{ id: 'g1', name: 'New' }], assignments: {} },
        { env: testEnv(store) },
      ),
    ).toThrow(/1\.0/);
    // Nothing was written: the file is byte-for-byte what it was before.
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(text);
  });
});
