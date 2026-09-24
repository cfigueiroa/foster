import { readFileSync } from 'node:fs';
import type { CodeSessionData } from '../domain/types.js';

/**
 * A session file is only usable when it names itself. Valid JSON without
 * `sessionId` is a neighbor, not a card — the app would not list it either.
 */
export function parseSessionData(raw: string): CodeSessionData | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined;
  return record as CodeSessionData;
}

export function readSessionFile(file: string): CodeSessionData | undefined {
  try {
    return parseSessionData(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Fields the app keeps on every card that nothing in foster ever reads.
 *
 * Measured 24/09/2026 on a real store: 25,174 cards, 1 GB of JSON, and
 * `remoteMcpServersConfig` alone was 35.6 KB of a card's ~38 KB. A sweep holds
 * every card of every account for its whole run, so carrying these kept about a
 * gigabyte alive on the heap — and half of an 85-second sweep was the garbage
 * collector walking it again and again. Left out of what a scan keeps; the one
 * write that copies a whole card puts them back from disk (`withBulkyFields`).
 */
export const BULKY_CARD_FIELDS: readonly string[] = [
  'remoteMcpServersConfig',
  'enabledMcpTools',
  'promptAppendSnapshot',
  'toolSurfaceSnapshot',
];

/**
 * A card as a scan keeps it: everything but `BULKY_CARD_FIELDS`. `slim` says
 * whether any of them was actually there to leave out.
 */
export function readSessionCard(
  file: string,
): { data: CodeSessionData; slim: boolean } | undefined {
  const data = readSessionFile(file);
  if (!data) return undefined;
  const record = data as unknown as Record<string, unknown>;
  let slim = false;
  for (const field of BULKY_CARD_FIELDS) {
    if (!(field in record)) continue;
    delete record[field];
    slim = true;
  }
  return { data, slim };
}

/**
 * The card a scan left slim, whole again — for a write that copies every field
 * across, which today is only the copy `executor.ts` writes.
 *
 * `data` wins for every field a scan keeps, so whatever the caller changed in
 * memory (a title, a deleted key) survives; only the bulky fields come from
 * disk, in the order the file holds them. A card that cannot be read any more
 * is written from what the scan kept rather than not at all — the same card,
 * minus fields the app fills in again the first time it opens it.
 */
export function withBulkyFields(session: {
  path: string;
  data: CodeSessionData;
  slim?: boolean;
}): CodeSessionData {
  if (!session.slim) return session.data;
  const full = readSessionFile(session.path) as unknown as Record<string, unknown> | undefined;
  if (!full) return session.data;
  const kept = session.data as unknown as Record<string, unknown>;
  const whole: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (BULKY_CARD_FIELDS.includes(key)) whole[key] = value;
    else if (key in kept) whole[key] = kept[key];
  }
  for (const [key, value] of Object.entries(kept)) if (!(key in whole)) whole[key] = value;
  return whole as unknown as CodeSessionData;
}

/**
 * The conversation a session file points at, or nothing when the file cannot
 * be read as one. Unreadable means "do not conclude anything".
 */
export function readCliSessionId(file: string): string | undefined {
  const data = readSessionFile(file);
  return typeof data?.cliSessionId === 'string' ? data.cliSessionId : undefined;
}
