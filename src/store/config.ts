import { readFileSync } from 'node:fs';
import type { StoreLayout } from '../domain/types.js';

/**
 * The settings this reader returns. It is deliberately narrow: it hands back the
 * handful of plain settings the tool needs and never the credential material in
 * the same file. That used to be the whole of foster's relationship with
 * config.json — the token was off-limits, full stop. It no longer is: `usage`
 * reads and decrypts the OAuth token through `credential.ts`, for the API calls
 * documented in the README's safety section. This reader stays narrow anyway,
 * because most of the tool has no business with the token and the one place that
 * does should be the only place that reaches for it.
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
   *
   * Read from `preferences.menuBarEnabled` in **`claude_desktop_config.json`**,
   * which is where the app keeps it. Two corrections deep, so both are worth
   * stating: #89 found that the preference sits inside a `preferences` object
   * rather than at the top level, and #92 found that the object is in the app's
   * own settings file — the one holding the MCP server list — not in the
   * `config.json` that holds the account cache and the OAuth token. Measured by
   * switching the tray off in the app's own UI and watching which file changed.
   *
   * Both older readings stay as fallbacks, in that order. They cost nothing and
   * cover a build that kept the setting somewhere else; what they must not do is
   * come first. Read from the wrong file, this answered "tray on" for everyone —
   * right for the default, and wrong for exactly the people who turned the tray
   * off, who were told to `--terminate` an app that would have closed politely.
   */
  menuBarEnabled?: boolean;
  /**
   * Whether the config file carries an OAuth token cache entry — the current
   * `oauth:tokenCacheV2` key or the older `oauth:tokenCache`. Presence only: the
   * value itself, whichever key holds it, is never read out of `parsed`, so this
   * says a credential was cached here at some point, not which account it
   * belongs to or whether it still works. Undefined, like the other optional
   * fields here, means "no" — no config to check, or neither key present.
   */
  hasTokenCache?: boolean;
}

/**
 * Read the handful of non-sensitive settings foster needs. Credential material
 * (oauth token caches and friends) is never returned, logged or copied.
 */
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The app's settings object, when the file holds one. */
function preferencesIn(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const preferences = parsed?.preferences;
  return preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : undefined;
}

export function readConfig(store: StoreLayout): StoreConfig {
  // Two files, read independently: a store can have one and not the other, and
  // the tray preference lives in the second — refusing to look at it because the
  // first is missing would be the same class of mistake this reader just made.
  const settings = readJson(store.desktopConfigFile);
  const parsed = readJson(store.configFile) ?? {};

  const out: StoreConfig = {};
  for (const key of READABLE_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'string') continue;
    if (key === 'lastKnownAccountUuid') out.lastKnownAccountUuid = value;
    if (key === 'locale') out.locale = value;
    if (key === 'updaterLastSeenVersion') out.updaterLastSeenVersion = value;
  }
  // The app's own settings file first, then the two older readings of this one.
  const tray =
    preferencesIn(settings)?.menuBarEnabled ??
    preferencesIn(parsed)?.menuBarEnabled ??
    parsed.menuBarEnabled;
  if (typeof tray === 'boolean') out.menuBarEnabled = tray;
  // Presence only, checked directly against the parsed keys — the blob itself is
  // never assigned to `out` and never leaves this function, whichever of the two
  // names it is filed under.
  if ('oauth:tokenCacheV2' in parsed || 'oauth:tokenCache' in parsed) out.hasTokenCache = true;
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
