import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/privacy.mjs, run as the real CLI against a throwaway git
 * repository — never against this one: a fixture holding a real-looking
 * path or UUID would trip the very guard it is testing, and `npm run
 * privacy` would then fail on *this* file. The forbidden strings below are
 * therefore assembled at runtime (never spelled contiguously in the source),
 * the same reason scripts/privacy.mjs itself keeps two personal identifiers
 * base64-encoded rather than literal.
 *
 * Issue #134: `git grep` alone only sees tracked files, so a fixture written
 * but not yet `git add`-ed used to pass `npm run privacy` and only fail once
 * CI saw it tracked, after the push (#131's tests/detach.test.ts, cleaned up
 * by #132 and a history rewrite). These tests plant an *untracked* file and
 * expect the guard to still catch it — the case that cost a rewrite.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/privacy.mjs', import.meta.url));
// 'C:' + '\Users\' + 'jsmith' + '\file' — split so the literal never appears
// contiguously here.
const WINDOWS_PATH = `const p = 'C:${'\\'}Users${'\\'}jsmith${'\\'}file';\n`;
// A realistic-looking UUID, assembled from parts so no 8-4-4-4-12 hex run
// appears contiguously in this file.
const FAKE_UUID = ['4f8a2c11', '9b3d', '4e6a', '8f21', '7c5d9a01b3e4'].join('-');

let repo: string;

function git(...args: string[]) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

/** Runs the guard the way `npm run privacy` does, but rooted at `repo`. */
function runGuard(): { ok: boolean; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT], { cwd: repo, encoding: 'utf8' });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'foster-privacy-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  writeFileSync(path.join(repo, 'README.md'), 'nothing to see here\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('scripts/privacy.mjs', () => {
  it('passes a repository with nothing but synthetic identifiers', () => {
    writeFileSync(
      path.join(repo, 'fixture.ts'),
      "const accountUuid = '00000000-0000-4000-8000-00000000000a';\n",
    );
    git('add', 'fixture.ts');
    expect(runGuard().ok).toBe(true);
  });

  it('catches a real-looking Windows profile path in an untracked file', () => {
    // Deliberately never `git add`-ed: this is the case plain `git grep`
    // (tracked files only) used to miss, before #134.
    writeFileSync(path.join(repo, 'untracked.ts'), WINDOWS_PATH);
    const { ok, output } = runGuard();
    expect(ok).toBe(false);
    expect(output).toContain('C:\\Users\\<name>');
    expect(output).toContain('untracked.ts');
  });

  it('catches a realistic UUID in an untracked file', () => {
    writeFileSync(path.join(repo, 'untracked.ts'), `const accountUuid = '${FAKE_UUID}';\n`);
    const { ok, output } = runGuard();
    expect(ok).toBe(false);
    expect(output).toContain('realistic UUID');
    expect(output).toContain('untracked.ts');
  });

  it('catches a real-looking path already staged, not just committed', () => {
    writeFileSync(path.join(repo, 'staged.ts'), WINDOWS_PATH);
    git('add', 'staged.ts');
    expect(runGuard().ok).toBe(false);
  });

  it('never sees an untracked file that .gitignore excludes', () => {
    mkdirSync(path.join(repo, 'ignored'));
    writeFileSync(path.join(repo, 'ignored', 'secret.ts'), WINDOWS_PATH);
    expect(runGuard().ok).toBe(true);
  });
});
