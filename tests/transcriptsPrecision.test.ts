import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conversationRoot,
  idsMentionedIn,
  lastAnswer,
  type RecordIdCache,
} from '../src/store/transcripts.js';

/**
 * Precision fixes to the transcript readers in `src/store/transcripts.ts`:
 *
 * - `idsMentionedIn` used to alias on any occurrence of `"uuid":"…"`,
 *   including one quoted inside a nested `toolUseResult` — this pins it to a
 *   record's own top-level id.
 * - `idsMentionedIn` and `conversationRoot` used to read the whole file, or a
 *   fixed head, as one string — this pins both to streaming, which a file
 *   past V8's string-length ceiling used to fail silently on, and which used
 *   to hide a root sitting past 64 KB of bookkeeping.
 * - `lastAnswer` used to give up after one fixed-size tail read — this pins
 *   the widening retry that a real store measured missing 22 of 7,721
 *   answers over.
 */

function tmpFile(records: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'foster-prec-'));
  const file = path.join(dir, 't.jsonl');
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

function toSorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

const OWN = '00000000-0000-4000-8000-000000001001';
const NESTED = '00000000-0000-4000-8000-000000001002';
const ROOT = '00000000-0000-4000-8000-000000001003';

describe('idsMentionedIn', () => {
  it('ignores a uuid quoted inside a nested tool result, not written as the record’s own', () => {
    const file = tmpFile([
      { uuid: OWN, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' },
      {
        uuid: '00000000-0000-4000-8000-000000001004',
        type: 'user',
        timestamp: '2026-09-24T00:00:01.000Z',
        // The shape a structured MCP result takes: another conversation's
        // head quoted well inside the record, at depth greater than 1. A
        // scan that matched the pattern anywhere used to alias this whole
        // conversation onto whatever NESTED's own root turned out to be.
        toolUseResult: { content: [{ type: 'text', text: 'ok' }], result: { uuid: NESTED } },
      },
    ]);

    expect(idsMentionedIn(file, new Set([NESTED]))).toEqual([]);
  });

  it('still finds a uuid that really is a record’s own', () => {
    const file = tmpFile([{ uuid: OWN, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' }]);

    expect(idsMentionedIn(file, new Set([OWN, NESTED]))).toEqual([OWN]);
  });

  it('finds a match on either side of a chunked read, in a file bigger than one chunk', () => {
    // Bigger than the 1 MiB chunk `streamLines` reads at a time, so the
    // record carrying OWN straddles more than one read.
    const padding = 'x'.repeat(2 * 1024 * 1024);
    const file = tmpFile([
      { uuid: OWN, type: 'user', timestamp: '2026-09-24T00:00:00.000Z', text: padding },
      {
        uuid: '00000000-0000-4000-8000-000000001005',
        type: 'user',
        timestamp: '2026-09-24T00:00:01.000Z',
      },
    ]);

    expect(idsMentionedIn(file, new Set([OWN]))).toEqual([OWN]);
  });

  it('answers nothing rather than throwing for a file that is not there', () => {
    expect(idsMentionedIn(path.join(tmpdir(), 'no-such-transcript.jsonl'), new Set([OWN]))).toEqual(
      [],
    );
  });
});

/**
 * `RecordIdCache`: `Lineage.deepen` asks the same file about a different,
 * usually smaller `wanted` set on every sweep round. Without a cache that
 * means reading and pattern-matching the whole file again for each round —
 * measured against a real store (2,523 conversations): an initial full
 * deepen ~17 s, a next round adding exactly one new id ~13 s uncached,
 * against effectively free once the file is cached from the first pass.
 */
describe('idsMentionedIn with a RecordIdCache', () => {
  it('answers the same as without one', () => {
    const file = tmpFile([
      { uuid: OWN, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' },
      {
        uuid: '00000000-0000-4000-8000-000000001004',
        type: 'user',
        timestamp: '2026-09-24T00:00:01.000Z',
        toolUseResult: { content: [{ type: 'text', text: 'ok' }], result: { uuid: NESTED } },
      },
    ]);
    const cache: RecordIdCache = new Map();

    expect(idsMentionedIn(file, new Set([OWN, NESTED]), cache)).toEqual([OWN]);
    // A second call, same wanted set, reuses the cached scan rather than
    // reading the file again — and still answers the same.
    expect(idsMentionedIn(file, new Set([OWN, NESTED]), cache)).toEqual([OWN]);
  });

  it('merges an id already searched for with a genuinely new one, in the same call', () => {
    // `idsMentionedIn` splits `wanted` into what a file's cache entry has
    // already been searched for and what it has not, on every call — this
    // is the split itself, not just the two ends of it: one call naming both
    // an already-known id and a never-asked one must answer both correctly,
    // the known one from the cache and the new one from the one extra pass
    // that call pays for.
    const OTHER = '00000000-0000-4000-8000-000000001098';
    const file = tmpFile([
      { uuid: OWN, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' },
      { uuid: OTHER, type: 'user', timestamp: '2026-09-24T00:00:01.000Z' },
    ]);
    const cache: RecordIdCache = new Map();

    // First call only ever asks about OWN.
    expect(idsMentionedIn(file, new Set([OWN]), cache)).toEqual([OWN]);

    // Second call asks about OWN again (already searched for) and OTHER
    // (never searched for in this file before) together.
    expect(toSorted(idsMentionedIn(file, new Set([OWN, OTHER]), cache))).toEqual(
      toSorted([OWN, OTHER]),
    );
  });

  it('scans again for an id this file has never been asked about, even once cached', () => {
    // The regression this guards: an earlier version cached a file's whole
    // occurrence map the first time any id was asked about it (building a
    // Map entry for every "uuid":"…" the pattern found, not just `wanted`'s),
    // so a later call for a genuinely different id answered from that first
    // scan's leftovers instead of ever reading the file again — silently
    // wrong whenever the new id was one the first scan had not recorded.
    // `RecordIdCache` now remembers which ids a file has actually been
    // searched for, per id, and pays one more filtered pass only for ids not
    // in that set yet — this is `Lineage.deepen`'s own "new id this round"
    // shape, one file asked about a different `wanted` set call to call.
    const REPLACED = '00000000-0000-4000-8000-000000001099';
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-prec-cache-2-'));
    const file = path.join(dir, 't.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({ uuid: OWN, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' })}\n`,
      'utf8',
    );
    const cache: RecordIdCache = new Map();

    // First call only ever asks about OWN — REPLACED has never been
    // searched for in this file yet.
    expect(idsMentionedIn(file, new Set([OWN]), cache)).toEqual([OWN]);

    writeFileSync(
      file,
      `${JSON.stringify({ uuid: REPLACED, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' })}\n`,
      'utf8',
    );

    // REPLACED is a new id for this file's cache entry, so this pays one
    // more filtered scan and finds it — never answered from OWN's leftover
    // scan, and never silently empty the way a whole-file-once cache would.
    expect(idsMentionedIn(file, new Set([REPLACED]), cache)).toEqual([REPLACED]);
  });
});

describe('conversationRoot', () => {
  it('finds the root past the old 64 KB head cutoff', () => {
    const file = tmpFile([
      // No uuid, and alone bigger than the old 64 KB head read.
      { type: 'custom-title', customTitle: 'x'.repeat(100 * 1024) },
      { uuid: ROOT, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' },
    ]);

    expect(conversationRoot(file)).toBe(ROOT);
  });

  it('gives up past its own cap rather than reading the whole file', () => {
    const file = tmpFile([
      // No uuid, and bigger than the 4 MiB cap this hunts within.
      { type: 'custom-title', customTitle: 'x'.repeat(5 * 1024 * 1024) },
      { uuid: ROOT, type: 'user', timestamp: '2026-09-24T00:00:00.000Z' },
    ]);

    expect(conversationRoot(file)).toBeUndefined();
  });
});

describe('lastAnswer', () => {
  it('widens past 256 KB of trailing bookkeeping to find the real answer', () => {
    const records: unknown[] = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-24T00:00:00.000Z' },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-24T00:00:01.000Z',
        message: { content: [{ type: 'text', text: 'the real answer' }] },
      },
    ];
    // More than 256 KB of bookkeeping written after the answer — a retitle,
    // queue operations — none of it an assistant record. Measured on a real
    // store: this is exactly what pushed the answer out of a fixed tail
    // window for 22 of 7,721 transcripts.
    for (let index = 0; index < 3000; index += 1) {
      records.push({ type: 'queue-operation', op: 'x'.repeat(120) });
    }
    const file = tmpFile(records);

    expect(lastAnswer(file)?.at).toBe(Date.parse('2026-09-24T00:00:01.000Z'));
  });

  it('still answers from the first window when the answer is already in it', () => {
    const file = tmpFile([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-24T00:00:00.000Z',
        message: { content: [{ type: 'text', text: 'fine' }] },
      },
    ]);

    expect(lastAnswer(file)?.at).toBe(Date.parse('2026-09-24T00:00:00.000Z'));
  });

  it('is undefined for a transcript that never gets an assistant record, without reading forever', () => {
    const records: unknown[] = [];
    for (let index = 0; index < 3000; index += 1) {
      records.push({ type: 'queue-operation', op: 'x'.repeat(120) });
    }
    const file = tmpFile(records);

    expect(lastAnswer(file)).toBeUndefined();
  });
});
