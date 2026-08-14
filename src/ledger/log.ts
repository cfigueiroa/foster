import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { VERSION } from '../version.js';
import type { LedgerEvent, LedgerEventInput } from './types.js';

const EVENT_KINDS = new Set<string>([
  'account_labelled',
  'account_identity_seen',
  'account_identity_forgotten',
  'account_switched',
  'fostered',
  'returned',
  'conversation_purged',
  'failed',
]);

/**
 * A ledger line is only an event when it names a kind we fold. Valid JSON
 * without that discriminant is a neighbor, not history — skip it, keep the rest.
 */
export function parseLedgerEvent(raw: string): LedgerEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !EVENT_KINDS.has(record.kind)) return undefined;
  return record as unknown as LedgerEvent;
}

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
      const event = parseLedgerEvent(trimmed);
      if (event) events.push(event);
    }
    return events;
  }
}
