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
  appVersion?: string;
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
    if (key === 'updaterLastSeenVersion') out.appVersion = value;
  }
  return out;
}
