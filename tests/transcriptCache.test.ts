import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptCache } from '../src/store/cache/transcriptCache.js';
import { scanConversation } from '../src/store/transcripts.js';

/**
 * `TranscriptCache` stands in for `scanConversation` without ever answering
 * differently than it would — the whole point of a cache that decides forks
 * and re-titles is that a warm run cannot be allowed to say something a cold
 * one would not have. Every scenario here compares the cached answer against
 * the live function on the same bytes.
 */

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-tcache-'));
}

const OWN_A = '00000000-0000-4000-8000-00000000a001';
const OWN_B = '00000000-0000-4000-8000-00000000a002';
const OWN_C = '00000000-0000-4000-8000-00000000a003';
const MENTIONED = '00000000-0000-4000-8000-00000000a0ff';

function line(uuid: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    uuid,
    type: 'user',
    timestamp: '2026-09-24T10:00:00.000Z',
    ...extra,
  });
}

function assistantLine(uuid: string, at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid, type: 'assistant', timestamp: at, ...extra });
}

function transcriptFile(base: string, name: string, lines: string[]): string {
  const file = path.join(base, name);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function toSorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

describe('TranscriptCache.scanConversation', () => {
  it('matches the live scan on a cold cache', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A),
      assistantLine(OWN_B, '2026-09-24T10:05:00.000Z'),
    ]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect(cached.lastMessageAt).toBe(live.lastMessageAt);
    expect(cached.lastAssistantAt).toBe(live.lastAssistantAt);
  });

  it('a nested id is not mistaken for a record uuid, cached or live alike', () => {
    const base = dir();
    // A record whose own uuid is OWN_A, quoting MENTIONED somewhere nested —
    // the shape a tool result embedding another record's id would take. The
    // pattern this cache's `recordFields` reads by is structural, not a raw
    // match, so a nested id never lands in `scan.uuids`.
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A, { toolUseResult: { nested: { uuid: MENTIONED } } }),
    ]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));

    const scan = cache.scanConversation(file);
    expect([...scan.uuids]).toEqual([OWN_A]);
  });

  it('a hit on an unchanged file answers without needing the entry to change', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A)]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));

    const first = cache.scanConversation(file);
    const second = cache.scanConversation(file);
    expect(toSorted(second.uuids)).toEqual(toSorted(first.uuids));
  });

  it('growth resumes from the stored offset and matches a full scan of the grown file', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A)]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));

    // Cache the file as it is now, then let it grow — the shape a live
    // transcript takes between two sweeps.
    cache.scanConversation(file);
    writeFileSync(
      file,
      `${[line(OWN_A), line(OWN_B), assistantLine(OWN_C, '2026-09-24T10:10:00.000Z')].join('\n')}\n`,
      'utf8',
    );

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect(cached.lastMessageAt).toBe(live.lastMessageAt);
    expect(cached.lastAssistantAt).toBe(live.lastAssistantAt);
    expect(toSorted(cached.uuids)).toEqual(toSorted([OWN_A, OWN_B, OWN_C]));
  });

  it('a rewrite that keeps growing but changes earlier bytes forces a full rescan', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A), line(OWN_B)]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    cache.scanConversation(file);

    // Same conversation id, entirely different content and a different,
    // larger size — not an append, so the tail hash cannot still match.
    writeFileSync(
      file,
      `${[
        line(OWN_C),
        assistantLine(MENTIONED, '2026-09-24T11:00:00.000Z'),
        line('00000000-0000-4000-8000-00000000a004'),
      ].join('\n')}\n`,
      'utf8',
    );

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect(cached.uuids.has(OWN_A)).toBe(false);
    expect(cached.uuids.has(OWN_B)).toBe(false);
  });

  it('a file that shrinks is treated as a different file, not a stale resume', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A), line(OWN_B), line(OWN_C)]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    cache.scanConversation(file);

    writeFileSync(file, `${line(MENTIONED)}\n`, 'utf8');

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect([...cached.uuids]).toEqual([MENTIONED]);
  });

  it('survives a file whose last line has no trailing newline, then grows past it', () => {
    const base = dir();
    const file = path.join(base, 'a.jsonl');
    // No trailing newline on purpose — the shape an actively-written transcript has.
    writeFileSync(file, line(OWN_A), 'utf8');
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    cache.scanConversation(file);

    writeFileSync(file, `${line(OWN_A)}\n${line(OWN_B)}`, 'utf8');
    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect(toSorted(cached.uuids)).toEqual(toSorted([OWN_A, OWN_B]));
  });

  it('a record still being written, longer than the tail window, is not lost once it completes', () => {
    // Reproduces the growth-resume bug: a record whose serialized length
    // exceeds TAIL_BYTES (4096) is only partly on disk when the entry is
    // cached — genuinely incomplete JSON, not just missing its trailing
    // newline — so it is correctly uncounted at that point. The write then
    // completes and the file grows past it. A resume that starts a fixed
    // TAIL_BYTES before the old offset lands inside this record rather than
    // before it, and dropping "the fragment before the first newline" as
    // already-counted then discards the whole finished record.
    const base = dir();
    const file = path.join(base, 'a.jsonl');
    const fullSecond = line(OWN_B, { big: 'x'.repeat(6900) });
    // Cut well short of the closing quote/brace: unambiguously invalid JSON,
    // the shape an in-progress write actually takes on disk.
    const truncatedSecond = fullSecond.slice(0, fullSecond.length - 500);
    expect(truncatedSecond.length).toBeGreaterThan(4096);

    writeFileSync(file, `${line(OWN_A)}\n${truncatedSecond}`, 'utf8');
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));

    const beforeCompletion = cache.scanConversation(file);
    expect(beforeCompletion.uuids.has(OWN_B)).toBe(false);

    // The write completes: same prefix, the rest of the record appended, now
    // with its trailing newline.
    writeFileSync(file, `${line(OWN_A)}\n${fullSecond}\n`, 'utf8');

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect(toSorted(cached.uuids)).toEqual(toSorted([OWN_A, OWN_B]));
  });

  it('an unreadable file answers empty, the same as the live function', () => {
    const base = dir();
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    const missing = path.join(base, 'nope.jsonl');
    const cached = cache.scanConversation(missing);
    const live = scanConversation(missing);
    expect([...cached.uuids]).toEqual([...live.uuids]);
  });
});

describe('TranscriptCache persistence', () => {
  it('round-trips through save and a fresh instance', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A),
      assistantLine(OWN_B, '2026-09-24T10:05:00.000Z'),
    ]);
    const cacheFile = path.join(base, 'cache.bin');

    const first = new TranscriptCache(cacheFile);
    first.scanConversation(file);
    first.save();

    const second = new TranscriptCache(cacheFile);
    const reloaded = second.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(reloaded.uuids)).toEqual(toSorted(live.uuids));
    expect(reloaded.lastMessageAt).toBe(live.lastMessageAt);
    expect(reloaded.lastAssistantAt).toBe(live.lastAssistantAt);
  });

  it('ignores a cache file from a different schema/version rather than trusting it', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A)]);
    const cacheFile = path.join(base, 'cache.bin');

    // A foreign or future format — the exact bytes do not matter, only that
    // they are not what this reader expects.
    writeFileSync(cacheFile, Buffer.from('not a foster cache at all, at any version'));

    const cache = new TranscriptCache(cacheFile);
    const result = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(result.uuids)).toEqual(toSorted(live.uuids));
  });

  it('a growth resume also survives a reload in between', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A)]);
    const cacheFile = path.join(base, 'cache.bin');

    const first = new TranscriptCache(cacheFile);
    first.scanConversation(file);
    first.save();

    writeFileSync(file, `${[line(OWN_A), line(OWN_B)].join('\n')}\n`, 'utf8');

    const second = new TranscriptCache(cacheFile);
    const cached = second.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
    expect(toSorted(cached.uuids)).toEqual(toSorted([OWN_A, OWN_B]));
  });

  it('a record id that will not pack is never persisted, but stays correct within the run', () => {
    const base = dir();
    // Uppercase hex: matches the live regex and recordFields just as well as
    // lowercase, but does not round-trip through the compact lowercase-only
    // binary form — see `uuidToBytes`.
    const upper = '00000000-0000-4000-8000-00000000A00A';
    const file = transcriptFile(base, 'a.jsonl', [line(upper)]);
    const cacheFile = path.join(base, 'cache.bin');

    const first = new TranscriptCache(cacheFile);
    const inRun = first.scanConversation(file);
    expect([...inRun.uuids]).toEqual([upper]);
    first.save();

    // Never persisted: a fresh instance has nothing cached for this file and
    // falls back to a live-equivalent full scan, which still agrees.
    const second = new TranscriptCache(cacheFile);
    const reloaded = second.scanConversation(file);
    expect(toSorted(reloaded.uuids)).toEqual(toSorted(scanConversation(file).uuids));
  });
});

describe('cache-vs-live agreement, deliberately ignoring mtime resolution', () => {
  it('still resumes correctly when a growth happens within the same mtime tick', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A)]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    cache.scanConversation(file);

    const stat = { atime: new Date(), mtime: new Date() };
    writeFileSync(file, `${[line(OWN_A), line(OWN_B)].join('\n')}\n`, 'utf8');
    // Pin both files to the exact same mtime instant a coarse filesystem clock
    // could produce; growth is judged on size, not mtime, so this must not
    // matter.
    utimesSync(file, stat.atime, stat.mtime);

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(toSorted(cached.uuids)).toEqual(toSorted(live.uuids));
  });
});

/**
 * The record-accumulation rule (`accumulateScanRecord`, `store/transcripts.ts`)
 * used to be duplicated between `scanConversation` and the cache's own
 * `scanOwnRange`, and the copy fell behind on two fixes: it took the *last*
 * timestamp read for `lastMessageAt` instead of the max, and let a
 * usage-limit or sidechain assistant record set `lastAssistantAt`. Cold and
 * warm cache runs agreed with each other — both ran the same buggy copy — but
 * neither agreed with a `--no-cache` run against the live function. These
 * scenarios exercise exactly the record shapes that used to expose the
 * drift: a usage-limit record, a sidechain record, and records read out of
 * timestamp order, cold, warm (a second read of the same bytes), and after
 * the file has grown.
 */
describe('cache/live parity: usage-limit, sidechain, and out-of-order records', () => {
  it('a sidechain assistant record read last never becomes lastAssistantAt', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A, { timestamp: '2026-09-24T10:00:00.000Z' }),
      assistantLine(OWN_B, '2026-09-24T10:10:00.000Z'), // the real answer
      // A subagent's turn, timestamped after the real answer and read last —
      // the shape that made the old cache copy overwrite lastAssistantAt.
      assistantLine(OWN_C, '2026-09-24T10:20:00.000Z', { isSidechain: true }),
    ]);
    const live = scanConversation(file);
    expect(live.lastAssistantAt).toBe(Date.parse('2026-09-24T10:10:00.000Z'));
    // The sidechain record's own timestamp still counts toward lastMessageAt.
    expect(live.lastMessageAt).toBe(Date.parse('2026-09-24T10:20:00.000Z'));

    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    const cold = cache.scanConversation(file);
    expect(cold).toEqual(live);
    const warm = cache.scanConversation(file);
    expect(warm).toEqual(live);
  });

  it('a usage-limit assistant record read last never becomes lastAssistantAt', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A, { timestamp: '2026-09-24T10:00:00.000Z' }),
      assistantLine(OWN_B, '2026-09-24T10:10:00.000Z'), // the real answer
      // The app's own synthetic rate-limit record, timestamped after the real
      // answer and read last.
      assistantLine(OWN_C, '2026-09-24T10:20:00.000Z', { isApiErrorMessage: true }),
    ]);
    const live = scanConversation(file);
    expect(live.lastAssistantAt).toBe(Date.parse('2026-09-24T10:10:00.000Z'));

    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    const cold = cache.scanConversation(file);
    expect(cold).toEqual(live);
    const warm = cache.scanConversation(file);
    expect(warm).toEqual(live);
  });

  it('out-of-order timestamps take the max, not the last record read, cold and warm', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      assistantLine(OWN_A, '2026-09-24T10:10:00.000Z'), // the latest moment
      line(OWN_B, { timestamp: '2026-09-24T10:02:00.000Z' }), // read last, but earlier
    ]);
    const live = scanConversation(file);
    expect(live.lastMessageAt).toBe(Date.parse('2026-09-24T10:10:00.000Z'));
    expect(live.lastAssistantAt).toBe(Date.parse('2026-09-24T10:10:00.000Z'));

    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    const cold = cache.scanConversation(file);
    expect(cold).toEqual(live);
    const warm = cache.scanConversation(file);
    expect(warm).toEqual(live);
  });

  it('a grown range whose own last record is not its latest resumes exactly like a live scan', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A, { timestamp: '2026-09-24T10:00:00.000Z' }),
      assistantLine(OWN_B, '2026-09-24T10:10:00.000Z', { isSidechain: true }),
    ]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    cache.scanConversation(file);

    // Growth appends a range whose own real answer (OWN_C, 10:30) is not the
    // last record scanned — a user record with an earlier timestamp (OWN_D,
    // 10:15) follows it — exactly the shape that exposed the bug only in the
    // *resumed* range, not the whole-file re-scan a shrink or rewrite forces.
    writeFileSync(
      file,
      `${[
        line(OWN_A, { timestamp: '2026-09-24T10:00:00.000Z' }),
        assistantLine(OWN_B, '2026-09-24T10:10:00.000Z', { isSidechain: true }),
        assistantLine(OWN_C, '2026-09-24T10:30:00.000Z'),
        line('00000000-0000-4000-8000-00000000a004', { timestamp: '2026-09-24T10:15:00.000Z' }),
      ].join('\n')}\n`,
      'utf8',
    );

    const cached = cache.scanConversation(file);
    const live = scanConversation(file);
    expect(cached).toEqual(live);
    expect(cached.lastAssistantAt).toBe(Date.parse('2026-09-24T10:30:00.000Z'));
    expect(cached.lastMessageAt).toBe(Date.parse('2026-09-24T10:30:00.000Z'));
  });

  it('a persisted, reloaded entry still matches live after a growth spanning usage-limit and sidechain records', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A, { timestamp: '2026-09-24T10:00:00.000Z' }),
    ]);
    const cacheFile = path.join(base, 'cache.bin');

    const first = new TranscriptCache(cacheFile);
    first.scanConversation(file);
    first.save();

    writeFileSync(
      file,
      `${[
        line(OWN_A, { timestamp: '2026-09-24T10:00:00.000Z' }),
        assistantLine(OWN_B, '2026-09-24T10:10:00.000Z'),
        assistantLine(OWN_C, '2026-09-24T10:25:00.000Z', { isApiErrorMessage: true }),
        assistantLine('00000000-0000-4000-8000-00000000a005', '2026-09-24T10:05:00.000Z', {
          isSidechain: true,
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    const second = new TranscriptCache(cacheFile);
    const cached = second.scanConversation(file);
    const live = scanConversation(file);
    expect(cached).toEqual(live);
    expect(cached.lastAssistantAt).toBe(Date.parse('2026-09-24T10:10:00.000Z'));
  });
});
