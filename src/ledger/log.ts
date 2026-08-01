import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { VERSION } from '../version.js';
import type { LedgerEvent } from './types.js';

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FOSTER_HOME ?? path.join(homedir(), '.foster');
  return path.join(base, 'ledger.jsonl');
}

/**
 * Append-only event log. Kept outside the Claude Desktop store so that foster's
 * own bookkeeping can never be mistaken for app data.
 */
export class Ledger {
  constructor(private readonly file: string = defaultLedgerPath()) {}

  get path(): string {
    return this.file;
  }

  /**
   * Records an event before the corresponding filesystem operation runs, so an
   * interrupted run leaves a trace of what was attempted.
   */
  append(event: Omit<LedgerEvent, 'v' | 'ts' | 'toolVersion'> & Partial<Pick<LedgerEvent, 'ts'>>) {
    const full = {
      v: 1 as const,
      ts: event.ts ?? Date.now(),
      toolVersion: VERSION,
      ...event,
    } as LedgerEvent;

    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  }

  read(): LedgerEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }

    const events: LedgerEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as LedgerEvent);
      } catch {
        // A torn final line (power loss mid-append) must not make the whole
        // ledger unreadable; skip it and keep the rest.
      }
    }
    return events;
  }
}
