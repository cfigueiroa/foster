import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { VERSION } from '../version.js';
import type { LedgerEvent, LedgerEventInput } from './types.js';

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FOSTER_HOME ?? path.join(homedir(), '.foster');
  return path.join(base, 'ledger.jsonl');
}

/**
 * Append-only event log. Kept outside the Claude Desktop store so that foster's
 * own bookkeeping can never be mistaken for app data.
 */
export class Ledger {
  private directoryEnsured = false;

  constructor(private readonly file: string = defaultLedgerPath()) {}

  get path(): string {
    return this.file;
  }

  /**
   * Records an operation that has already completed.
   *
   * Deliberately after the filesystem work, not before. A record of something
   * that did not happen cannot be detected later: a "fostered" event with no file
   * makes every future run skip that session as already done, and a "returned"
   * event with the copy still on disk orphans it where nothing will look again.
   * The opposite gap is self-healing — a copy written but not recorded still
   * carries its own _foster marker for the scanner to find, and a copy deleted
   * but not recorded is simply removed again, which succeeds.
   */
  append(event: LedgerEventInput): LedgerEvent {
    const full = {
      v: 1 as const,
      ts: event.ts ?? Date.now(),
      toolVersion: VERSION,
      ...event,
    } as LedgerEvent;

    // Once per instance rather than once per event: a batch appends one event per
    // session, and the directory cannot stop existing midway through.
    if (!this.directoryEnsured) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.directoryEnsured = true;
    }
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
