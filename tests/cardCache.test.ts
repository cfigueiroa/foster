import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionCardCached, SlimCardCache } from '../src/store/cache/cardCache.js';
import { readSessionCard } from '../src/store/sessionFile.js';
import { session } from './helpers/store.js';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-ccache-'));
}

function writeCard(base: string, name: string, overrides = {}): string {
  const file = path.join(base, name);
  writeFileSync(
    file,
    JSON.stringify({
      ...session(overrides),
      // A bulky field, so `slim` has something real to strip.
      remoteMcpServersConfig: { some: 'x'.repeat(200) },
    }),
    'utf8',
  );
  return file;
}

describe('readSessionCardCached', () => {
  it('with no cache, is exactly readSessionCard', () => {
    const base = dir();
    const file = writeCard(base, 'a.json');
    expect(readSessionCardCached(file, undefined)).toEqual(readSessionCard(file));
  });

  it('a cold read matches the uncached slim read', () => {
    const base = dir();
    const file = writeCard(base, 'a.json');
    const cache = new SlimCardCache(path.join(base, 'cache.ndjson'));
    expect(readSessionCardCached(file, cache)).toEqual(readSessionCard(file));
  });

  it('a warm read answers from the cache without the card changing', () => {
    const base = dir();
    const file = writeCard(base, 'a.json');
    const cache = new SlimCardCache(path.join(base, 'cache.ndjson'));
    const first = readSessionCardCached(file, cache);
    const second = readSessionCardCached(file, cache);
    expect(second).toEqual(first);
    expect(second).toEqual(readSessionCard(file));
  });

  it('a changed file (new size and mtime) is read fresh, not answered stale', () => {
    const base = dir();
    const file = writeCard(base, 'a.json', { title: 'Before' });
    const cache = new SlimCardCache(path.join(base, 'cache.ndjson'));
    readSessionCardCached(file, cache);

    writeCard(base, 'a.json', { title: 'After, and quite a bit longer a title than before' });
    const updated = readSessionCardCached(file, cache);
    expect(updated?.data.title).toBe('After, and quite a bit longer a title than before');
  });

  it('round-trips through save and a fresh instance', () => {
    const base = dir();
    const file = writeCard(base, 'a.json');
    const cacheFile = path.join(base, 'cache.ndjson');

    const first = new SlimCardCache(cacheFile);
    const original = readSessionCardCached(file, first);
    first.save();

    const second = new SlimCardCache(cacheFile);
    const stat = statSync(file);
    const reloaded = second.get(file, stat.size, stat.mtimeMs);
    expect(reloaded).toEqual(original);
  });

  it('ignores a cache file with no header at all', () => {
    const base = dir();
    const file = writeCard(base, 'a.json');
    const cacheFile = path.join(base, 'cache.ndjson');
    writeFileSync(cacheFile, '', 'utf8');

    const cache = new SlimCardCache(cacheFile);
    expect(readSessionCardCached(file, cache)).toEqual(readSessionCard(file));
  });

  it('ignores every entry when the header names a different bulky-field list', () => {
    const base = dir();
    const file = writeCard(base, 'a.json');
    const cacheFile = path.join(base, 'cache.ndjson');
    const stat = statSync(file);
    const card = readSessionCard(file)!;
    const header = JSON.stringify({
      schema: 1,
      fosterVersion: '0.0.0-does-not-exist',
      bulky: ['someOtherField'],
    });
    const row = JSON.stringify({
      path: file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      slim: card.slim,
      data: card.data,
    });
    writeFileSync(cacheFile, `${header}\n${row}\n`, 'utf8');

    const cache = new SlimCardCache(cacheFile);
    // The header mismatch (foster version, in this case) means the row above
    // is never trusted — a fresh read happens instead of the pre-seeded data.
    expect(readSessionCardCached(file, cache)).toEqual(readSessionCard(file));
  });

  it('one damaged line does not cost the rest of the cache', () => {
    const base = dir();
    const fileA = writeCard(base, 'a.json', { sessionId: '00000000-0000-4000-8000-0000000000b1' });
    const fileB = writeCard(base, 'b.json', { sessionId: '00000000-0000-4000-8000-0000000000b2' });
    const cacheFile = path.join(base, 'cache.ndjson');

    const first = new SlimCardCache(cacheFile);
    readSessionCardCached(fileA, first);
    readSessionCardCached(fileB, first);
    first.save();

    // Corrupt exactly one data line, leaving the header and the other line intact.
    const raw = readFileSync(cacheFile, 'utf8');
    const lines = raw.split('\n');
    const dataLineIndex = lines.findIndex((l) => l.includes(fileA.replace(/\\/g, '\\\\')));
    expect(dataLineIndex).toBeGreaterThan(0);
    lines[dataLineIndex] = '{not json';
    writeFileSync(cacheFile, lines.join('\n'), 'utf8');

    const second = new SlimCardCache(cacheFile);
    const statB = statSync(fileB);
    expect(second.get(fileB, statB.size, statB.mtimeMs)).toEqual(readSessionCard(fileB));
    const statA = statSync(fileA);
    expect(second.get(fileA, statA.size, statA.mtimeMs)).toBeUndefined();
  });
});
