import { readFileSync } from 'node:fs';
import type { StoreLayout } from '../domain/types.js';

/**
 * Keys in config.json that hold credentials. foster never reads their values —
 * the whitelist below is what it is allowed to look at, and everything else in
 * the file is ignored rather than parsed out.
 */
const READABLE_KEYS = ['lastKnownAccountUuid', 'locale', 'updaterLastSeenVersion'] as const;

export interface StoreConfig {
  /** The account whose directory the sidebar is currently populated from. */
  lastKnownAccountUuid?: string;
  locale?: string;
  /**
   * The release the app's updater last saw. Not necessarily the running build —
   * after an update is staged but before relaunch it runs ahead of it.
   */
  updaterLastSeenVersion?: string;
  /**
   * Whether the app keeps a tray icon. This decides what closing the window does:
   * the window's close handler quits the app only when the tray is off, and
   * otherwise cancels the close and hides the window instead. Absent means on,
   * which is the default and the case that matters — see engine/desktop.ts.
   */
  menuBarEnabled?: boolean;
}

/**
 * Read the handful of non-sensitive settings foster needs. Credential material
 * (oauth token caches and friends) is never returned, logged or copied.
 */
export function readConfig(store: StoreLayout): StoreConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(store.configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }

  const out: StoreConfig = {};
  for (const key of READABLE_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'string') continue;
    if (key === 'lastKnownAccountUuid') out.lastKnownAccountUuid = value;
    if (key === 'locale') out.locale = value;
    if (key === 'updaterLastSeenVersion') out.updaterLastSeenVersion = value;
  }
  if (typeof parsed.menuBarEnabled === 'boolean') out.menuBarEnabled = parsed.menuBarEnabled;
  return out;
}

/**
 * Whether asking the main window to close will actually end the app.
 *
 * The window's close handler quits only when the tray is disabled; with the tray
 * on it cancels the close and hides the window instead. The setting is absent by
 * default, and absent means on — so for almost everyone, politely asking the
 * window to close hides it and changes nothing else.
 */
export function closingWindowQuits(store: StoreLayout): boolean {
  return readConfig(store).menuBarEnabled === false;
}
