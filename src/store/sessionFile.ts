import { readFileSync } from 'node:fs';

/**
 * The conversation a session file points at, or nothing when the file cannot
 * be read as one. Unreadable means "do not conclude anything".
 */
export function readCliSessionId(file: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { cliSessionId?: unknown };
    return typeof data.cliSessionId === 'string' ? data.cliSessionId : undefined;
  } catch {
    return undefined;
  }
}
