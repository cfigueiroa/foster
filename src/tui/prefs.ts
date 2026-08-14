import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ThemeName } from './theme.js';

/**
 * UI-only preferences. The ledger is a record of what foster did to sessions;
 * which theme the TUI is wearing does not belong there.
 */

export interface UiPrefs {
  theme: ThemeName;
}

export function prefsPath(home: string = homedir()): string {
  return path.join(home, '.foster', 'ui.json');
}

export function loadPrefs(home: string = homedir()): UiPrefs {
  try {
    const raw = JSON.parse(readFileSync(prefsPath(home), 'utf8')) as { theme?: string };
    return { theme: raw.theme === 'day' ? 'day' : 'night' };
  } catch {
    return { theme: 'night' };
  }
}

export function savePrefs(prefs: UiPrefs, home: string = homedir()): void {
  const file = prefsPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
}
