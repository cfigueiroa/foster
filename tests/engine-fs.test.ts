import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLink, removeSafely, writeFileAtomic } from '../src/engine/fsatomic.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-fs-'));
}

describe('writeFileAtomic', () => {
  it('writes the file', () => {
    const dir = scratch();
    const target = path.join(dir, 'session.json');

    writeFileAtomic(target, '{"a":1}');

    expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  it('leaves no temporary files behind', () => {
    const dir = scratch();
    writeFileAtomic(path.join(dir, 'session.json'), '{}');

    expect(readdirSync(dir)).toEqual(['session.json']);
  });

  it('replaces an existing file in one step', () => {
    const dir = scratch();
    const target = path.join(dir, 'session.json');
    writeFileAtomic(target, '{"v":1}');
    writeFileAtomic(target, '{"v":2}');

    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
  });
});

describe('removeSafely', () => {
  it('removes a plain file', () => {
    const dir = scratch();
    const file = path.join(dir, 'copy.json');
    writeFileSync(file, '{}', 'utf8');

    expect(removeSafely(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('reports false for a path that is not there', () => {
    expect(removeSafely(path.join(scratch(), 'missing.json'))).toBe(false);
  });

  /**
   * The invariant that separates undoing a change from losing data: removing a
   * link must unlink the link, never recurse into what it points at.
   */
  it('never destroys the target a link points at', () => {
    const dir = scratch();
    const real = path.join(dir, 'real-sandbox');
    mkdirSync(real);
    writeFileSync(path.join(real, 'precious.txt'), 'irreplaceable', 'utf8');

    const link = path.join(dir, 'linked-sandbox');
    symlinkSync(real, link, 'junction');
    expect(isLink(link)).toBe(true);

    removeSafely(link);

    expect(existsSync(link)).toBe(false);
    expect(existsSync(real)).toBe(true);
    expect(readFileSync(path.join(real, 'precious.txt'), 'utf8')).toBe('irreplaceable');
  });

  it('refuses to silently wipe a populated real directory', () => {
    const dir = scratch();
    const populated = path.join(dir, 'not-a-link');
    mkdirSync(populated);
    writeFileSync(path.join(populated, 'keep.txt'), 'keep', 'utf8');

    expect(() => removeSafely(populated)).toThrow();
    expect(existsSync(path.join(populated, 'keep.txt'))).toBe(true);
  });
});
