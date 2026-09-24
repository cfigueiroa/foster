import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptCache } from '../src/store/cache/transcriptCache.js';
import { idsMentionedIn, scanConversation } from '../src/store/transcripts.js';

/**
 * `TranscriptCache` stands in for `scanConversation` and `idsMentionedIn`
 * without ever answering differently than they would — the whole point of a
 * cache that decides forks and re-titles is that a warm run cannot be allowed
 * to say something a cold one would not have. Every scenario here compares the
 * cached answer against the live function on the same bytes.
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

function assistantLine(uuid: string, at: string): string {
  return JSON.stringify({ uuid, type: 'assistant', timestamp: at });
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

  it('a nested id is picked up as mentioned but not as a record uuid', () => {
    const base = dir();
    // A record whose own uuid is OWN_A, quoting MENTIONED somewhere nested —
    // the shape a tool result embedding another record's id would take.
    const file = transcriptFile(base, 'a.jsonl', [
      line(OWN_A, { toolUseResult: { nested: { uuid: MENTIONED } } }),
    ]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));

    const scan = cache.scanConversation(file);
    expect([...scan.uuids]).toEqual([OWN_A]);

    const wanted = new Set([OWN_A, MENTIONED]);
    expect(toSorted(cache.idsMentionedIn(file, wanted))).toEqual(
      toSorted(idsMentionedIn(file, wanted)),
    );
    expect(toSorted(cache.idsMentionedIn(file, wanted))).toEqual([MENTIONED, OWN_A].sort());
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

  it('growth resume still finds ids mentioned only in the new bytes', () => {
    const base = dir();
    const file = transcriptFile(base, 'a.jsonl', [line(OWN_A)]);
    const cache = new TranscriptCache(path.join(base, 'cache.bin'));
    cache.scanConversation(file);

    writeFileSync(
      file,
      `${[line(OWN_A), line(OWN_B, { toolUseResult: { uuid: MENTIONED } })].join('\n')}\n`,
      'utf8',
    );

    const wanted = new Set([MENTIONED]);
    expect(cache.idsMentionedIn(file, wanted)).toEqual([MENTIONED]);
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
