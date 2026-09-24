import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CodeSessionData } from '../../domain/types.js';
import { writeFileAtomic } from '../../util/fsatomic.js';
import { VERSION } from '../../version.js';
import { BULKY_CARD_FIELDS, readSessionCard } from '../sessionFile.js';
import { CACHE_SCHEMA } from './schema.js';

interface CardEntry {
  size: number;
  mtimeMs: number;
  slim: boolean;
  data: CodeSessionData;
}

interface CardHeader {
  schema: number;
  fosterVersion: string;
  bulky: readonly string[];
}

/**
 * `readSessionCard` results, kept across runs.
 *
 * A card's slim reading is deterministic in everything that can change it: the
 * file's bytes (proxied by size and mtime, the same key `readSessionCard`'s
 * caller would otherwise re-derive by reading it), foster's own `VERSION` and
 * `BULKY_CARD_FIELDS` (what "slim" leaves out). The header carries the last
 * two; either one differing from what is running now means every entry in the
 * file answers a question that no longer means what it used to, so the whole
 * file is treated as empty rather than partially trusted. The same header
 * fields double as the schema check `CACHE_SCHEMA` exists for: a build old
 * enough to predate a header field parses it as `undefined`, which already
 * fails the equality check below.
 *
 * Storage is newline-delimited JSON — a header line, then one line per card —
 * rather than one file-sized `JSON.parse`: a store with 25,000 cards makes
 * that call proportional to the whole cache, not to what one damaged line
 * would cost.
 *
 * Residual risk, stated once here rather than at every call site: a file
 * rewritten with the exact same size inside the same millisecond as its
 * previous write reads as unchanged. Nothing keyed on size and mtime alone can
 * tell that apart from no change at all.
 */
export class SlimCardCache {
  private readonly entries = new Map<string, CardEntry>();
  private dirty = false;
  private loaded = false;

  constructor(private readonly file: string) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }

    const lines = raw.split('\n');
    const headerLine = lines[0];
    if (!headerLine) return;

    let header: Partial<CardHeader> | undefined;
    try {
      header = JSON.parse(headerLine) as Partial<CardHeader>;
    } catch {
      return;
    }
    if (!headerMatches(header)) return;

    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { path?: unknown } & Partial<CardEntry>;
        if (
          typeof record.path !== 'string' ||
          typeof record.size !== 'number' ||
          typeof record.mtimeMs !== 'number' ||
          typeof record.slim !== 'boolean' ||
          record.data === undefined
        ) {
          continue;
        }
        this.entries.set(record.path, {
          size: record.size,
          mtimeMs: record.mtimeMs,
          slim: record.slim,
          data: record.data,
        });
      } catch {
        // One damaged line does not cost the rest of the cache.
      }
    }
  }

  get(
    filePath: string,
    size: number,
    mtimeMs: number,
  ): { data: CodeSessionData; slim: boolean } | undefined {
    this.ensureLoaded();
    const entry = this.entries.get(filePath);
    if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) return undefined;
    return { data: entry.data, slim: entry.slim };
  }

  set(filePath: string, size: number, mtimeMs: number, slim: boolean, data: CodeSessionData): void {
    this.ensureLoaded();
    this.entries.set(filePath, { size, mtimeMs, slim, data });
    this.dirty = true;
  }

  /** Nothing was read or written this run — saving would just rewrite what is already there. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  save(): void {
    this.ensureLoaded();
    if (!this.dirty) return;
    const header: CardHeader = {
      schema: CACHE_SCHEMA,
      fosterVersion: VERSION,
      bulky: BULKY_CARD_FIELDS,
    };
    const lines = [JSON.stringify(header)];
    for (const [entryPath, entry] of this.entries) {
      lines.push(JSON.stringify({ path: entryPath, ...entry }));
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, `${lines.join('\n')}\n`);
      this.dirty = false;
    } catch {
      // A cache that failed to save costs the next run its head start, not
      // this one its answers — nothing above this has anything to undo.
    }
  }
}

function headerMatches(header: Partial<CardHeader> | undefined): boolean {
  if (!header || header.schema !== CACHE_SCHEMA || header.fosterVersion !== VERSION) return false;
  if (!Array.isArray(header.bulky) || header.bulky.length !== BULKY_CARD_FIELDS.length)
    return false;
  return header.bulky.every((field, index) => field === BULKY_CARD_FIELDS[index]);
}

/**
 * `readSessionCard`, consulting and then filling the cache.
 *
 * With no cache passed — `--no-cache`, or a caller that never asked for one —
 * this is exactly `readSessionCard`, so the cache is never in the way of a
 * correct answer, only ever a shortcut to one already known.
 */
export function readSessionCardCached(
  filePath: string,
  cache: SlimCardCache | undefined,
): { data: CodeSessionData; slim: boolean } | undefined {
  if (!cache) return readSessionCard(filePath);

  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return undefined;
  }

  const hit = cache.get(filePath, size, mtimeMs);
  if (hit) return hit;

  const card = readSessionCard(filePath);
  if (card) cache.set(filePath, size, mtimeMs, card.slim, card.data);
  return card;
}
