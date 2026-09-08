import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APP_PREFS,
  parsePrefValue,
  readAppPrefs,
  specOf,
  writeAppPref,
} from '../src/store/appPrefs.js';
import type { StoreLayout } from '../src/domain/types.js';
import { plannedChanges, resolve } from '../src/cli/appPrefCommand.js';
import { makeStore } from './helpers/store.js';

/**
 * The app's own settings, read and written where the app keeps them.
 *
 * What these pin down is mostly restraint: this file carries the MCP server list
 * and every other preference the app has, so a write that touches anything but
 * the one key asked for is the failure worth catching. See #92 for how the
 * reader found the right key in the wrong file twice before this existed.
 */

function storeWith(settings: Record<string, unknown>): StoreLayout {
  const store = makeStore();
  writeFileSync(store.desktopConfigFile, JSON.stringify(settings), 'utf8');
  return store;
}

function settingsOf(store: StoreLayout): Record<string, unknown> {
  return JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<string, unknown>;
}

describe('the table transcribed from the app', () => {
  it('holds every preference the build defines, each with a default', () => {
    // 90 in build 1.46388.4, and each one has an entry in the app's own defaults
    // object — that is what makes "absent" answerable without reading the app.
    const names = Object.keys(APP_PREFS);
    expect(names).toHaveLength(90);
    for (const name of names) expect(specOf(name)).toHaveProperty('fallback');
  });

  it('knows the three that decide what the app does to a Code session', () => {
    expect(APP_PREFS.ccBranchPrefix).toMatchObject({ kind: 'string', fallback: 'claude' });
    expect(APP_PREFS.ccMaxWarmWorktrees).toMatchObject({ kind: 'number', fallback: 3 });
    expect(APP_PREFS.ccWorktreeReapAfterHours).toMatchObject({ kind: 'number', fallback: 24 });
  });

  it('marks the settings the app guards, without refusing them', () => {
    // Flagged, never blocked: it is the user's machine. What the flag buys is a
    // sentence at the moment of writing.
    expect(APP_PREFS.bypassPermissionsModeEnabled.guard).toBe(true);
    expect(APP_PREFS.allowAllBrowserActions.guard).toBe(true);
    expect(APP_PREFS.localAgentModeTrustedFolders.guard).toBe(true);
    expect(specOf('menuBarEnabled')?.guard).toBeUndefined();
  });
});

describe('readAppPrefs', () => {
  it('lists what somebody has set, and says so', () => {
    const store = storeWith({ preferences: { menuBarEnabled: false } });
    const rows = readAppPrefs(store);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'menuBarEnabled', value: false, stored: true });
  });

  it('falls back to the app default for everything nobody has touched', () => {
    const store = storeWith({ preferences: {} });
    const rows = readAppPrefs(store, true);

    const branch = rows.find((r) => r.name === 'ccBranchPrefix');
    expect(branch).toMatchObject({ value: 'claude', stored: false });
    expect(rows).toHaveLength(90);
  });

  it('still lists a stored preference this build has never heard of', () => {
    // The app adds settings whenever it likes. Dropping one because the table
    // does not know it would make this a worse witness than the file itself.
    const store = storeWith({ preferences: { somethingNewInTheNextRelease: 7 } });
    const rows = readAppPrefs(store);

    expect(rows[0]).toMatchObject({ name: 'somethingNewInTheNextRelease', value: 7, stored: true });
  });

  it('reads nothing rather than throwing when the file is not there', () => {
    expect(readAppPrefs(makeStore())).toEqual([]);
  });
});

describe('parsePrefValue', () => {
  it('takes only true or false for a boolean', () => {
    expect(parsePrefValue(APP_PREFS.menuBarEnabled, 'false')).toEqual({ ok: true, value: false });
    expect(parsePrefValue(APP_PREFS.menuBarEnabled, 'no')).toMatchObject({ ok: false });
  });

  it('takes a number, and refuses what is not one', () => {
    expect(parsePrefValue(APP_PREFS.ccMaxWarmWorktrees, '8')).toEqual({ ok: true, value: 8 });
    expect(parsePrefValue(APP_PREFS.ccMaxWarmWorktrees, 'many')).toMatchObject({ ok: false });
  });

  it('holds an enum to the values the app accepts', () => {
    expect(parsePrefValue(APP_PREFS.sidebarMode, 'code')).toEqual({ ok: true, value: 'code' });
    const refused = parsePrefValue(APP_PREFS.sidebarMode, 'sidebar');
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.reason).toContain('chat');
  });

  it('takes JSON for the shapes a command line cannot spell', () => {
    expect(parsePrefValue(APP_PREFS.localAgentModeTrustedFolders, '["C:/work"]')).toEqual({
      ok: true,
      value: ['C:/work'],
    });
    expect(parsePrefValue(APP_PREFS.localAgentModeTrustedFolders, 'C:/work')).toMatchObject({
      ok: false,
    });
  });
});

describe('writeAppPref', () => {
  it('changes one preference and leaves every neighbour exactly as it was', () => {
    const store = storeWith({
      mcpServers: { one: { command: 'node' } },
      preferences: {
        menuBarEnabled: true,
        // The shape that a PowerShell round trip was measured mangling: an ISO
        // string reserialised as `...71Z`, in a key nobody asked to touch.
        someTimestamp: '2026-08-26T17:05:32.710Z',
        ccBranchPrefix: 'claude',
      },
    });

    const { write, backup } = writeAppPref(store, 'menuBarEnabled', false);

    expect(write).toMatchObject({ name: 'menuBarEnabled', from: true, to: false, unset: false });
    const after = settingsOf(store);
    expect(after.mcpServers).toEqual({ one: { command: 'node' } });
    expect((after.preferences as Record<string, unknown>).someTimestamp).toBe(
      '2026-08-26T17:05:32.710Z',
    );
    expect((after.preferences as Record<string, unknown>).ccBranchPrefix).toBe('claude');
    expect((after.preferences as Record<string, unknown>).menuBarEnabled).toBe(false);
    expect(readFileSync(backup, 'utf8')).toContain('"menuBarEnabled":true');
  });

  it('adds the preferences object when the file has none', () => {
    const store = storeWith({ mcpServers: {} });

    writeAppPref(store, 'ccMaxWarmWorktrees', 8);

    expect(settingsOf(store).preferences).toEqual({ ccMaxWarmWorktrees: 8 });
  });

  it('reports the app default as the value it came from, when nothing was stored', () => {
    const store = storeWith({ preferences: {} });

    const { write } = writeAppPref(store, 'ccWorktreeReapAfterHours', 72);

    expect(write).toMatchObject({ from: 24, to: 72 });
  });

  it('unsets by removing the key, so the app default takes over again', () => {
    const store = storeWith({ preferences: { ccBranchPrefix: 'mine', menuBarEnabled: false } });

    const { write } = writeAppPref(store, 'ccBranchPrefix', undefined, { unset: true });

    expect(write).toMatchObject({ from: 'mine', to: 'claude', unset: true });
    const after = settingsOf(store).preferences as Record<string, unknown>;
    expect('ccBranchPrefix' in after).toBe(false);
    expect(after.menuBarEnabled).toBe(false);
  });

  it('says a guarded preference is guarded, in the outcome', () => {
    const store = storeWith({ preferences: {} });

    expect(writeAppPref(store, 'allowAllBrowserActions', true).write.guard).toBe(true);
    expect(writeAppPref(store, 'menuBarEnabled', false).write.guard).toBe(false);
  });
});

describe('what a command line asks to change', () => {
  it('takes the positional pair', () => {
    expect(plannedChanges('sidebarMode', 'code', undefined, false)).toEqual([
      { name: 'sidebarMode', value: 'code', unset: false },
    ]);
  });

  it('takes several --set, so one stop of the app covers them all', () => {
    expect(
      plannedChanges(
        undefined,
        undefined,
        ['keepAwakeEnabled=true', 'ccMaxWarmWorktrees=6'],
        false,
      ),
    ).toEqual([
      { name: 'keepAwakeEnabled', value: 'true', unset: false },
      { name: 'ccMaxWarmWorktrees', value: '6', unset: false },
    ]);
  });

  it('keeps everything after the first = as the value', () => {
    // A branch prefix, a device name or a path can hold one.
    expect(plannedChanges(undefined, undefined, ['ccBranchPrefix=team=a/b'], false)).toEqual([
      { name: 'ccBranchPrefix', value: 'team=a/b', unset: false },
    ]);
  });

  it('reads a bare name with --unset as a change, not a read', () => {
    expect(plannedChanges('ccBranchPrefix', undefined, undefined, true)).toEqual([
      { name: 'ccBranchPrefix', unset: true },
    ]);
  });

  it('asks for nothing when the name is there to be read', () => {
    expect(plannedChanges('sidebarMode', undefined, undefined, false)).toEqual([]);
  });

  it('refuses a --set that is not name=value', () => {
    expect(() => plannedChanges(undefined, undefined, ['keepAwakeEnabled'], false)).toThrow(
      /name=value/,
    );
    expect(() => plannedChanges(undefined, undefined, ['=true'], false)).toThrow(/name=value/);
  });
});

describe('resolving a change before the app is touched', () => {
  it('refuses an unknown preference', () => {
    const store = storeWith({ preferences: {} });
    expect(() => resolve(store, { name: 'notAThing', value: '1', unset: false })).toThrow(
      /not a preference/,
    );
  });

  it('refuses a value the app would reject, naming what it takes', () => {
    // The reason this happens here rather than after the app is closed: a typo
    // in the third of three values must not be found with the app already down.
    const store = storeWith({ preferences: {} });
    expect(() => resolve(store, { name: 'sidebarMode', value: 'sidebar', unset: false })).toThrow(
      /chat/,
    );
  });

  it('carries the current value and the one it would land on', () => {
    const store = storeWith({ preferences: { ccMaxWarmWorktrees: 3 } });
    expect(resolve(store, { name: 'ccMaxWarmWorktrees', value: '6', unset: false })).toMatchObject({
      from: 3,
      to: 6,
      parsed: 6,
    });
  });
});
