import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheDisabled, cacheStats, clearCache, defaultCacheDir } from '../src/store/cache/env.js';
import { openFosterCache } from '../src/store/cache/index.js';

describe('defaultCacheDir', () => {
  it('sits under FOSTER_HOME, next to the ledger, not inside it', () => {
    expect(defaultCacheDir({ FOSTER_HOME: 'C:\\fake\\home' })).toBe('C:\\fake\\home\\cache');
  });
});

describe('cacheDisabled', () => {
  it('is off by default', () => {
    expect(cacheDisabled({})).toBe(false);
  });

  it('the --no-cache flag alone is enough', () => {
    expect(cacheDisabled({}, true)).toBe(true);
  });

  it('FOSTER_NO_CACHE=1 is enough on its own', () => {
    expect(cacheDisabled({ FOSTER_NO_CACHE: '1' })).toBe(true);
  });

  it('FOSTER_NO_CACHE=0 does not count as set', () => {
    expect(cacheDisabled({ FOSTER_NO_CACHE: '0' })).toBe(false);
  });

  it('an empty FOSTER_NO_CACHE does not count as set', () => {
    expect(cacheDisabled({ FOSTER_NO_CACHE: '' })).toBe(false);
  });
});

describe('cacheStats', () => {
  it('a directory that does not exist yet answers empty rather than throwing', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'foster-cstats-')), 'cache');
    expect(cacheStats(dir)).toEqual({ dir, exists: false, files: 0, bytes: 0 });
  });

  it('counts files and bytes, and the newest mtime among them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-cstats-'));
    writeFileSync(path.join(dir, 'a'), 'hello', 'utf8');
    writeFileSync(path.join(dir, 'b'), 'hello world', 'utf8');
    const stats = cacheStats(dir);
    expect(stats.exists).toBe(true);
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBe('hello'.length + 'hello world'.length);
    expect(stats.newestMtimeMs).toBeDefined();
  });
});

describe('clearCache', () => {
  it('a directory that does not exist yet removes nothing', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'foster-cclear-')), 'cache');
    expect(clearCache(dir)).toBe(0);
  });

  it('removes every file and leaves the directory itself in place', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foster-cclear-'));
    writeFileSync(path.join(dir, 'a'), 'x', 'utf8');
    writeFileSync(path.join(dir, 'b'), 'y', 'utf8');
    expect(clearCache(dir)).toBe(2);
    expect(existsSync(dir)).toBe(true);
    expect(cacheStats(dir).files).toBe(0);
  });
});

describe('openFosterCache', () => {
  it('answers nothing when disabled', () => {
    expect(openFosterCache({}, true)).toBeUndefined();
    expect(openFosterCache({ FOSTER_NO_CACHE: '1' }, false)).toBeUndefined();
  });

  it('answers a cache rooted at FOSTER_HOME/cache when enabled', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'foster-open-'));
    mkdirSync(path.join(home, 'cache'), { recursive: true });
    const cache = openFosterCache({ FOSTER_HOME: home }, false);
    expect(cache).toBeDefined();
    // Opening costs nothing until something is scanned: neither file exists yet.
    expect(existsSync(path.join(home, 'cache', 'cards.ndjson'))).toBe(false);
    expect(existsSync(path.join(home, 'cache', 'transcripts.bin'))).toBe(false);
  });
});
