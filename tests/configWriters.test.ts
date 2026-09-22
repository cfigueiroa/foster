import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoreLayout } from '../src/domain/types.js';
import { writeGroupScope } from '../src/store/groupScopes.js';
import { environmentsKey, writeEpitaxyPrefs } from '../src/store/viewPrefs.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT } from './helpers/store.js';

/**
 * `writeGroupScope` and `writeEpitaxyPrefs` both rewrite
 * `claude_desktop_config.json` by parsing it, changing one part of the tree,
 * and stringifying the whole thing back out. Their "did a neighbour move"
 * check compares two already-parsed trees, so it cannot see a number literal
 * that `JSON.parse` / `JSON.stringify` silently rewrote on the way through —
 * an integer past `Number.MAX_SAFE_INTEGER`, a trailing `.0`, exponent
 * notation. Both now refuse up front (`util/jsonNumbers.ts`) whenever the raw
 * file holds one, wherever in the document it sits.
 */

function writeRawConfig(store: StoreLayout, text: string): void {
  writeFileSync(store.desktopConfigFile, text, 'utf8');
}

/** Redirects backups into the test's own temp tree, never the real `~/.foster`. */
function testEnv(store: StoreLayout): NodeJS.ProcessEnv {
  return { ...process.env, FOSTER_HOME: path.join(store.root, '.foster-home') };
}

describe('writeGroupScope refuses on a lossy number literal', () => {
  it('refuses an integer past Number.MAX_SAFE_INTEGER, naming it', () => {
    const store = makeStore();
    const text = '{"preferences":{"epitaxyPrefs":{},"someId":12345678901234567890}}';
    writeRawConfig(store, text);

    expect(() =>
      writeGroupScope(store, OLD_ACCOUNT, { groups: [], assignments: {} }, { env: testEnv(store) }),
    ).toThrow(/12345678901234567890/);
    // Refused before anything was touched: no rewrite, no backup taken either.
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(text);
  });

  it('refuses a trailing .0, naming it', () => {
    const store = makeStore();
    const text = '{"preferences":{"epitaxyPrefs":{},"scale":1.0}}';
    writeRawConfig(store, text);

    expect(() =>
      writeGroupScope(store, OLD_ACCOUNT, { groups: [], assignments: {} }, { env: testEnv(store) }),
    ).toThrow(/1\.0/);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(text);
  });

  it('says nothing was written', () => {
    const store = makeStore();
    const text = '{"preferences":{"epitaxyPrefs":{},"scale":1.0}}';
    writeRawConfig(store, text);

    expect(() =>
      writeGroupScope(store, OLD_ACCOUNT, { groups: [], assignments: {} }, { env: testEnv(store) }),
    ).toThrow(/[Nn]othing was written/);
  });
});

describe('writeEpitaxyPrefs refuses on a lossy number literal', () => {
  it('refuses exponent notation, naming it', () => {
    const store = makeStore();
    const text = '{"preferences":{"epitaxyPrefs":{"someCount":1e3}}}';
    writeRawConfig(store, text);

    expect(() =>
      writeEpitaxyPrefs(
        store,
        { [environmentsKey(NEW_ACCOUNT)]: ['local'] },
        { env: testEnv(store) },
      ),
    ).toThrow(/1e3/);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(text);
  });

  it('refuses an integer past Number.MAX_SAFE_INTEGER, wherever it sits in the document', () => {
    const store = makeStore();
    // Outside preferences entirely, e.g. an mcpServers entry — still refused.
    const text = '{"mcpServers":{"id":12345678901234567890},"preferences":{"epitaxyPrefs":{}}}';
    writeRawConfig(store, text);

    expect(() =>
      writeEpitaxyPrefs(
        store,
        { [environmentsKey(NEW_ACCOUNT)]: ['local'] },
        { env: testEnv(store) },
      ),
    ).toThrow(/12345678901234567890/);
    expect(readFileSync(store.desktopConfigFile, 'utf8')).toBe(text);
  });

  it('ignores a number-shaped run of digits sitting inside a string', () => {
    const store = makeStore();
    const text = '{"preferences":{"epitaxyPrefs":{"note":"build 12345678901234567890, v1.0"}}}';
    writeRawConfig(store, text);

    // Does not throw: the offending-looking text is inside a JSON string, not
    // a number literal.
    const { backup } = writeEpitaxyPrefs(
      store,
      { [environmentsKey(NEW_ACCOUNT)]: ['local'] },
      { env: testEnv(store) },
    );
    expect(backup).toMatch(/backups/);
  });
});

describe('a normal config round-trips', () => {
  it('writeGroupScope: ordinary ints, floats and negatives elsewhere are preserved untouched', () => {
    const store = makeStore();
    writeRawConfig(
      store,
      JSON.stringify({
        mcpServers: { one: { retries: 3, timeoutMs: -1 } },
        preferences: {
          menuBarEnabled: true,
          ccWorktreeReapAfterHours: 24.5,
          epitaxyPrefs: {},
        },
      }),
    );

    const { backup } = writeGroupScope(
      store,
      OLD_ACCOUNT,
      { groups: [{ id: 'g1', name: 'Group' }], assignments: { 'code:local_a': 'g1' } },
      { env: testEnv(store) },
    );
    expect(backup).toMatch(/backups/);

    const after = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(after.mcpServers).toEqual({ one: { retries: 3, timeoutMs: -1 } });
    const preferences = after.preferences as Record<string, unknown>;
    expect(preferences.menuBarEnabled).toBe(true);
    expect(preferences.ccWorktreeReapAfterHours).toBe(24.5);
  });

  it('writeEpitaxyPrefs: a config with only canonical numbers writes cleanly', () => {
    const store = makeStore();
    writeRawConfig(
      store,
      JSON.stringify({
        preferences: { epitaxyPrefs: { keepThis: 42 } },
      }),
    );

    const { backup } = writeEpitaxyPrefs(
      store,
      { [environmentsKey(NEW_ACCOUNT)]: ['local', 'ssh'] },
      { env: testEnv(store) },
    );
    expect(backup).toMatch(/backups/);

    const epitaxy = (
      JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as {
        preferences: { epitaxyPrefs: Record<string, unknown> };
      }
    ).preferences.epitaxyPrefs;
    expect(epitaxy.keepThis).toBe(42);
    expect(epitaxy[environmentsKey(NEW_ACCOUNT)]).toEqual(['local', 'ssh']);
  });
});
