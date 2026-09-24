import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversationRoot, idsMentionedIn, lastAnswer } from '../src/store/transcripts.js';

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
