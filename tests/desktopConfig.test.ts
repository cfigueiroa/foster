import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoreLayout } from '../src/domain/types.js';
import { layoutFor } from '../src/domain/paths.js';
import { asObject, rewriteDesktopConfig } from '../src/store/desktopConfig.js';

/**
 * The one rewrite path `appPrefs.ts`, `groupScopes.ts` and `viewPrefs.ts` all
 * now share. Each of those three files has its own tests exercising it
 * end to end through its own shape; these pin down the shared mechanics
 * directly — `allowedPaths` as a chain of keys, exact vs. prefix, and the
 * lossy-number guard — so a change here that breaks one caller's assumptions
 * is caught close to the code that would explain why.
 */

function storeWith(contents: Record<string, unknown>): StoreLayout {
  const root = mkdtempSync(path.join(tmpdir(), 'foster-desktopConfig-test-'));
  const store = layoutFor(root);
  writeFileSync(store.desktopConfigFile, JSON.stringify(contents), 'utf8');
  return store;
}

function envFor(store: StoreLayout): { env: NodeJS.ProcessEnv } {
  return { env: { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') } };
}

function readConfig(store: StoreLayout): Record<string, unknown> {
  return JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<string, unknown>;
}

describe('rewriteDesktopConfig', () => {
  it('writes what mutate changes along an allowed path, and nothing else', () => {
    const store = storeWith({ mcpServers: { one: {} }, preferences: { a: 1, b: 2 } });

    rewriteDesktopConfig(
      store,
      'test',
      [['preferences', 'a']],
      (after) => {
        (after.preferences as Record<string, unknown>).a = 99;
      },
      envFor(store),
    );

    expect(readConfig(store)).toEqual({ mcpServers: { one: {} }, preferences: { a: 99, b: 2 } });
  });

  it('refuses when mutate touches a key outside every allowed path, leaving the file untouched', () => {
    const store = storeWith({ preferences: { a: 1, b: 2 } });
    const original = readFileSync(store.desktopConfigFile, 'utf8');

    expect(() =>
      rewriteDesktopConfig(
        store,
        'test',
        [['preferences', 'a']],
        (after) => {
          const prefs = after.preferences as Record<string, unknown>;
          prefs.a = 99;
          prefs.b = 999; // not allowed — must trip the refusal
        },
        envFor(store),
      ),
    ).toThrow(/preferences\.b.*would have changed too/);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(original);
  });

  it('accepts several allowed paths sharing a prefix — one call, several leaf keys', () => {
    const store = storeWith({ preferences: { epitaxyPrefs: { keep: 1 } } });

    rewriteDesktopConfig(
      store,
      'test',
      [
        ['preferences', 'epitaxyPrefs', 'x'],
        ['preferences', 'epitaxyPrefs', 'y'],
      ],
      (after) => {
        const epitaxy = asObject((after.preferences as Record<string, unknown>).epitaxyPrefs);
        epitaxy.x = 1;
        epitaxy.y = 2;
        (after.preferences as Record<string, unknown>).epitaxyPrefs = epitaxy;
      },
      envFor(store),
    );

    expect(readConfig(store)).toEqual({
      preferences: { epitaxyPrefs: { keep: 1, x: 1, y: 2 } },
    });
  });

  it('creates a container the file does not have yet, along the allowed path', () => {
    const store = storeWith({});

    rewriteDesktopConfig(
      store,
      'test',
      [['preferences', 'epitaxyPrefs', 'deep', 'key']],
      (after) => {
        const preferences = asObject(after.preferences);
        const epitaxy = asObject(preferences.epitaxyPrefs);
        const deep = asObject(epitaxy.deep);
        deep.key = 'value';
        epitaxy.deep = deep;
        preferences.epitaxyPrefs = epitaxy;
        after.preferences = preferences;
      },
      envFor(store),
    );

    expect(readConfig(store)).toEqual({
      preferences: { epitaxyPrefs: { deep: { key: 'value' } } },
    });
  });

  it('refuses up front on a lossy number literal, before mutate has any effect', () => {
    const store = storeWith({});
    writeFileSync(store.desktopConfigFile, '{"preferences":{"a":1},"scale":1.0}', 'utf8');
    const original = readFileSync(store.desktopConfigFile, 'utf8');

    expect(() =>
      rewriteDesktopConfig(
        store,
        'test',
        [['preferences', 'a']],
        (after) => {
          (after.preferences as Record<string, unknown>).a = 2;
        },
        envFor(store),
      ),
    ).toThrow(/1\.0/);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(original);
  });

  it('backs up before refusing, so the "would have changed too" message points at a real copy', () => {
    const store = storeWith({ preferences: { a: 1, b: 2 } });

    let backupPath: string | undefined;
    try {
      rewriteDesktopConfig(
        store,
        'test',
        [['preferences', 'a']],
        (after) => {
          (after.preferences as Record<string, unknown>).b = 999;
        },
        envFor(store),
      );
    } catch (error) {
      backupPath = /backup is at (.+)$/.exec((error as Error).message)?.[1];
    }

    expect(backupPath).toBeDefined();
    expect(JSON.parse(readFileSync(backupPath!, 'utf8'))).toEqual({
      preferences: { a: 1, b: 2 },
    });
  });
});

describe('asObject', () => {
  it('reads a plain object as itself, and everything else as empty', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toEqual({});
    expect(asObject(undefined)).toEqual({});
    expect(asObject([1, 2])).toEqual({});
    expect(asObject('x')).toEqual({});
  });
});
