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
 * The conversation a session file points at, or nothing when the file cannot
 * be read as one. Unreadable means "do not conclude anything".
 */
export function readCliSessionId(file: string): string | undefined {
  const data = readSessionFile(file);
  return typeof data?.cliSessionId === 'string' ? data.cliSessionId : undefined;
}
