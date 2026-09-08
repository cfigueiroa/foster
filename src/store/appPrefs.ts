import { copyFileSync, readFileSync } from 'node:fs';
import type { StoreLayout } from '../domain/types.js';
import { writeFileAtomic } from '../util/fsatomic.js';

/**
 * The Claude Desktop preferences, as the app itself defines them.
 *
 * They live in `claude_desktop_config.json` — the file that also carries the MCP
 * server list — under a top-level `preferences` object, and the app reads them
 * with its own defaults underneath (#92). A preference that has never been
 * changed is simply absent, so "what is this set to" and "what has somebody set"
 * are two different questions, and both are worth answering separately.
 *
 * The table below is transcribed from the app's own defaults object and its
 * validation schema, build 1.46388.4: 90 preferences, every one present in both.
 * `kind` and `choices` come from the schema, `fallback` from the defaults. It is
 * generated rather than typed by hand, because ninety entries copied by eye is
 * ninety chances to introduce a value the app would reject.
 *
 * Two things this table is not. It is not a promise that the app still honours a
 * given preference — the app is free to drop one and leave the default behind —
 * and it is not a list of what is safe: see `guard`.
 */

export type PrefKind = 'boolean' | 'string' | 'number' | 'enum' | 'list' | 'map' | 'object';

export interface PrefSpec {
  kind: PrefKind | 'unknown';
  /** What the app uses when the preference is absent. */
  fallback: unknown;
  /** The closed set of values, where the schema defines one. */
  choices?: string[];
  /**
   * Loosens a guard the app puts in the way on purpose — permission bypasses,
   * trusted folder lists, private-network allowances, full computer control.
   *
   * Not a refusal. This is the user's machine and the user's tool, and a flag
   * that reads "you cannot change your own settings" is a worse answer than the
   * change itself. What it buys is a sentence at the moment of writing, so
   * nobody relaxes one of these believing it was an ordinary toggle.
   */
  guard?: boolean;
}

export const APP_PREFS = {
  allowAllBrowserActions: { kind: 'boolean', fallback: false, guard: true },
  bypassPermissionsGateByAccount: { kind: 'map', fallback: {}, guard: true },
  bypassPermissionsModeEnabled: { kind: 'boolean', fallback: false, guard: true },
  bypassPermissionsOptInByAccount: { kind: 'map', fallback: {}, guard: true },
  ccAutoArchiveInactiveDays: { kind: 'number', fallback: 0 },
  ccAutoArchiveOnPrClose: { kind: 'boolean', fallback: false },
  ccBranchPrefix: { kind: 'string', fallback: 'claude' },
  ccKeepAwakeOnBattery: { kind: 'boolean', fallback: true },
  ccKeepAwakeWhileWorking: { kind: 'boolean', fallback: true },
  ccMaxWarmWorktrees: { kind: 'number', fallback: 3 },
  ccRemoteControlDefaultEnabled: { kind: 'boolean', fallback: null },
  ccWorktreeReapAfterHours: { kind: 'number', fallback: 24 },
  ccdScheduledTasksEnabled: { kind: 'boolean', fallback: false },
  chicagoAutoUnhide: { kind: 'boolean', fallback: true },
  chicagoBackgroundIntroSeen: { kind: 'boolean', fallback: false },
  chicagoEnabled: { kind: 'boolean', fallback: false, guard: true },
  chicagoPreferredMode: {
    kind: 'enum',
    fallback: 'background',
    choices: ['background', 'full_control'],
    guard: true,
  },
  chicagoUserDeniedBundleIds: { kind: 'list', fallback: [] },
  chillingSlothLocation: { kind: 'unknown', fallback: 'default' },
  chromeExtension: { kind: 'object', fallback: {} },
  chromeExtensionEnabled: { kind: 'boolean', fallback: true },
  claudeAndroidEmulatorAccessEnabled: { kind: 'boolean', fallback: true },
  claudeIosSimulatorAccessEnabled: { kind: 'boolean', fallback: true },
  coworkBrowserToolsEnabled: { kind: 'boolean', fallback: true },
  coworkDisabledTools: { kind: 'list', fallback: [] },
  coworkHipaaRestricted: { kind: 'boolean', fallback: false },
  coworkLegacyRootGrantsPruned: { kind: 'boolean', fallback: false },
  coworkModelAutoFallbackByAccount: { kind: 'map', fallback: {} },
  coworkOnboardingResumeStep: { kind: 'object', fallback: null },
  coworkPreferredBrowser: { kind: 'enum', fallback: 'built_in', choices: ['built_in', 'chrome'] },
  coworkProjectsToolProvenFor: { kind: 'string', fallback: null },
  coworkScheduledTasksEnabled: { kind: 'boolean', fallback: false },
  coworkSpaceContextEnabled: { kind: 'boolean', fallback: false },
  coworkWebSearchEnabled: { kind: 'boolean', fallback: true },
  dispatchCodeTasksPermissionMode: {
    kind: 'enum',
    fallback: 'acceptEdits',
    choices: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    guard: true,
  },
  dispatchTrustedCodeWorkspaces: { kind: 'list', fallback: [], guard: true },
  dockBounceEnabled: { kind: 'boolean', fallback: false },
  earlyWindowShowLatched: { kind: 'boolean', fallback: false },
  epitaxyPrefs: { kind: 'map', fallback: {} },
  folderTccProbeResults: { kind: 'object', fallback: {} },
  growthBookHybridAuthedOrigins: { kind: 'list', fallback: [] },
  hardwareBuddyEnabled: { kind: 'boolean', fallback: false },
  hybridDetectLatched: { kind: 'boolean', fallback: false },
  installSourceLanding: { kind: 'unknown', fallback: null },
  keepAwakeEnabled: { kind: 'boolean', fallback: false },
  launchChromeImportPrompt: {
    kind: 'enum',
    fallback: 'pending',
    choices: ['pending', 'dismissed', 'done'],
  },
  launchEnabled: { kind: 'boolean', fallback: true },
  launchPreviewAllowedDomainTransitions: { kind: 'list', fallback: [], guard: true },
  launchPreviewAllowedOrigins: { kind: 'list', fallback: [], guard: true },
  launchPreviewPersistedWorkspaces: { kind: 'list', fallback: [] },
  launchPreviewPrivateNetworkReadOrigins: { kind: 'list', fallback: [], guard: true },
  launchPreviewPrivateNetworkReadPins: { kind: 'map', fallback: {}, guard: true },
  launchPreviewPrivateNetworkTrustPins: { kind: 'map', fallback: {}, guard: true },
  launchPreviewPrivateNetworkTrustedOrigins: { kind: 'list', fallback: [], guard: true },
  launchPreviewSessionScopedSessions: { kind: 'list', fallback: [] },
  launchPreviewStorage: {
    kind: 'enum',
    fallback: 'none',
    choices: ['none', 'shared', 'session'],
  },
  legacyQuickEntryEnabled: { kind: 'boolean', fallback: true },
  localAgentModeTrustedFolders: { kind: 'list', fallback: [], guard: true },
  louderPenguinEnabled: { kind: 'boolean', fallback: false },
  menuBarEnabled: { kind: 'boolean', fallback: true },
  notificationLevels: { kind: 'object', fallback: {} },
  notificationSound: { kind: 'enum', fallback: 'system', choices: ['system', 'none'] },
  orgWorkAcrossAppsDisabled: { kind: 'boolean', fallback: false },
  plushRaccoonEnabled: { kind: 'boolean', fallback: false },
  plushRaccoonOption1: { kind: 'unknown', fallback: 'off' },
  plushRaccoonOption2: { kind: 'unknown', fallback: 'off' },
  plushRaccoonOption3: { kind: 'unknown', fallback: 'off' },
  previewJitlessKillSwitchEngaged: { kind: 'boolean', fallback: false, guard: true },
  quickEntryDictationShortcut: { kind: 'unknown', fallback: 'off' },
  quickEntryShortcut: { kind: 'unknown', fallback: 'double-tap-option' },
  quietPenguinEnabled: { kind: 'boolean', fallback: false },
  remoteControlExcludedFolders: { kind: 'list', fallback: [] },
  remoteControlPinnedFolders: { kind: 'list', fallback: [] },
  remoteControlSpawnMode: { kind: 'enum', fallback: 'same-dir', choices: ['same-dir', 'worktree'] },
  remoteControlStayReachable: { kind: 'boolean', fallback: false },
  remoteFolderConsentMemory: { kind: 'list', fallback: [], guard: true },
  remoteSessionFolderGrants: { kind: 'map', fallback: {}, guard: true },
  remoteToolsDeviceName: { kind: 'string', fallback: '' },
  routineFolderGrants: { kind: 'map', fallback: {}, guard: true },
  rubberDuckEnabled: { kind: 'boolean', fallback: false },
  secureVmFeaturesEnabled: { kind: 'boolean', fallback: true, guard: true },
  sidebarMode: {
    kind: 'enum',
    fallback: 'chat',
    choices: ['chat', 'code', 'task', 'epitaxy'],
  },
  simulatorDeviceConsent: { kind: 'map', fallback: {}, guard: true },
  vmCpuCount: { kind: 'number', fallback: 0 },
  vmMemoryGB: { kind: 'number', fallback: 0 },
  wakeSchedulerApprovedThisCycle: { kind: 'boolean', fallback: false },
  wakeSchedulerCourtesyFlippedKeepAwake: { kind: 'boolean', fallback: false },
  wakeSchedulerDisableEmitted: { kind: 'boolean', fallback: false },
  wakeSchedulerEnabled: { kind: 'boolean', fallback: false },
  wakeSchedulerRegisteredAtVersion: { kind: 'string', fallback: '' },
} satisfies Record<string, PrefSpec>;

/**
 * The spec for a name that came from outside — a command line, or the file.
 *
 * `APP_PREFS` keeps its literal keys so that `APP_PREFS.ccBranchPrefix` is a
 * spec rather than a maybe; a lookup by arbitrary string is the other question,
 * and it answers `undefined` for a preference this build has never heard of.
 */
export function specOf(name: string): PrefSpec | undefined {
  return (APP_PREFS as Record<string, PrefSpec | undefined>)[name];
}

export interface PrefReading {
  name: string;
  /** What the app will use: the stored value, or the default when none is stored. */
  value: unknown;
  /** True when somebody has set this — the file carries it. */
  stored: boolean;
  spec: PrefSpec;
}

function settingsOf(store: StoreLayout): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(store.desktopConfigFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const preferences = parsed.preferences;
    return preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? (preferences as Record<string, unknown>)
      : {};
  } catch {
    return undefined;
  }
}

/**
 * Every preference, or only the ones somebody has set.
 *
 * A name the table does not know is still listed when it is stored: the app can
 * add one at any release, and silently dropping it would make this reader a
 * worse witness than the file it is reading.
 */
export function readAppPrefs(store: StoreLayout, all = false): PrefReading[] {
  const stored = settingsOf(store) ?? {};
  const names = all
    ? [...new Set([...Object.keys(APP_PREFS), ...Object.keys(stored)])].sort()
    : Object.keys(stored).sort();

  return names.map((name) => {
    const spec = specOf(name) ?? { kind: 'unknown' as const, fallback: undefined };
    const has = Object.hasOwn(stored, name);
    return { name, value: has ? stored[name] : spec.fallback, stored: has, spec };
  });
}

export type PrefParse = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * The typed value behind what somebody typed on a command line.
 *
 * Strict on purpose, and against the app's own schema: a preference written with
 * the wrong type is not a foster problem, it is a file the app may reject or
 * read as something else. `unknown` kinds — a union the schema builds out of
 * literals and objects both — take JSON and nothing else, because guessing which
 * half was meant is exactly the kind of help that corrupts a setting.
 */
export function parsePrefValue(spec: PrefSpec, text: string): PrefParse {
  switch (spec.kind) {
    case 'boolean': {
      if (text === 'true') return { ok: true, value: true };
      if (text === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'expects true or false' };
    }
    case 'number': {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, reason: 'expects a number' };
      return { ok: true, value: n };
    }
    case 'string':
      return { ok: true, value: text };
    case 'enum': {
      if (spec.choices?.includes(text)) return { ok: true, value: text };
      return { ok: false, reason: `expects one of: ${spec.choices?.join(', ') ?? '(unknown)'}` };
    }
    default: {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, reason: 'expects JSON' };
      }
    }
  }
}

export interface PrefWrite {
  name: string;
  from: unknown;
  to: unknown;
  /** True when the write removes the key, letting the app's default take over. */
  unset: boolean;
  guard: boolean;
}

export interface PrefWriteResult {
  write: PrefWrite;
  backup: string;
}

/**
 * Write one preference, and nothing else.
 *
 * The neighbours are the point. This file holds the MCP server list and every
 * other preference the app has ever been given, so the write goes through
 * `JSON.parse`/`stringify` — never a round trip through a shell's JSON support,
 * which was measured turning `"...710Z"` into `"...71Z"` in untouched keys — and
 * the result is compared key by key against what was read before it is allowed
 * to replace the original. Anything else moved, and the write is refused with
 * the file untouched.
 *
 * A backup is written first regardless, named with the moment, because the one
 * failure this cannot check for is the one nobody predicted.
 */
export function writeAppPref(
  store: StoreLayout,
  name: string,
  value: unknown,
  options: { unset?: boolean; now?: () => Date } = {},
): PrefWriteResult {
  const raw = readFileSync(store.desktopConfigFile, 'utf8');
  const before = JSON.parse(raw) as Record<string, unknown>;
  const preferences: Record<string, unknown> =
    before.preferences &&
    typeof before.preferences === 'object' &&
    !Array.isArray(before.preferences)
      ? (before.preferences as Record<string, unknown>)
      : {};

  const from = Object.hasOwn(preferences, name) ? preferences[name] : specOf(name)?.fallback;

  const after = JSON.parse(raw) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...preferences };
  if (options.unset) delete next[name];
  else next[name] = value;
  after.preferences = next;

  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backup = `${store.desktopConfigFile}.bak-${stamp}`;
  copyFileSync(store.desktopConfigFile, backup);

  const text = JSON.stringify(after, null, 2);
  const back = JSON.parse(text) as Record<string, unknown>;
  const moved = neighboursThatMoved(before, back, name);
  if (moved.length > 0) {
    throw new Error(
      `refusing to write: ${moved.join(', ')} would have changed too. Nothing was written; the backup is at ${backup}`,
    );
  }

  writeFileAtomic(store.desktopConfigFile, text);
  return {
    write: {
      name,
      from,
      to: options.unset ? specOf(name)?.fallback : value,
      unset: Boolean(options.unset),
      guard: Boolean(specOf(name)?.guard),
    },
    backup,
  };
}

/** Every key, at both levels, that is not the one being written and changed anyway. */
function neighboursThatMoved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  name: string,
): string[] {
  const moved: string[] = [];
  const top = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of top) {
    if (key === 'preferences') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) moved.push(key);
  }

  const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const wasPrefs = asObject(before.preferences);
  const nowPrefs = asObject(after.preferences);
  for (const key of new Set([...Object.keys(wasPrefs), ...Object.keys(nowPrefs)])) {
    if (key === name) continue;
    if (JSON.stringify(wasPrefs[key]) !== JSON.stringify(nowPrefs[key])) {
      moved.push(`preferences.${key}`);
    }
  }
  return moved;
}
