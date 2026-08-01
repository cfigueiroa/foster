import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';

/**
 * Claude Desktop rewrites session files while it runs — it normalises them on
 * open and updates focus timestamps. Writing underneath a live app therefore
 * risks a lost update in either direction, so every mutating command refuses to
 * proceed unless the app is closed.
 */

export interface AppState {
  running: boolean;
  /** How it was detected, for an honest message to the user. */
  evidence: string[];
}

/**
 * Electron holds an exclusive handle on `lockfile` in userData for as long as it
 * runs. Renaming the file to itself fails while that handle is open and succeeds
 * once it is released — a real check, unlike trying to open the file for writing,
 * which Windows permits through its sharing modes.
 */
function lockfileHeld(store: StoreLayout): boolean {
  const lockfile = path.join(store.root, 'lockfile');
  if (!existsSync(lockfile)) return false;
  try {
    renameSync(lockfile, lockfile);
    return false;
  } catch {
    return true;
  }
}

/**
 * Process names alone are unreliable (Electron spawns helpers, the updater has
 * its own name, and packaging changes them), so this is a corroborating signal
 * rather than the primary one.
 */
function desktopProcessRunning(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.toLowerCase().includes('claude.exe');
  } catch {
    return false;
  }
}

export function inspectApp(store: StoreLayout): AppState {
  const evidence: string[] = [];
  if (lockfileHeld(store)) evidence.push('userData lockfile is held by a running app');
  if (desktopProcessRunning()) evidence.push('a Claude.exe process is running');
  return { running: evidence.length > 0, evidence };
}

export class AppRunningError extends Error {
  constructor(state: AppState) {
    super(
      `Claude Desktop appears to be running (${state.evidence.join('; ')}).\n` +
        'Quit it completely — closing the window is not enough, use the app menu or the tray icon — then run this again.',
    );
    this.name = 'AppRunningError';
  }
}

/**
 * Called immediately before each batch of writes rather than once at startup:
 * the user may launch the app between the check and the write.
 */
export function assertAppClosed(store: StoreLayout): void {
  const state = inspectApp(store);
  if (state.running) throw new AppRunningError(state);
}
