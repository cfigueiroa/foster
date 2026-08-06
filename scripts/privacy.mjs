#!/usr/bin/env node
/**
 * The privacy guard, runnable before pushing rather than only in CI.
 *
 * This repository is public, and a real account identifier or a personal path in
 * a fixture is not the kind of mistake a review catches reliably — it looks
 * exactly like the synthetic ones beside it. CI has always checked; the gap was
 * that nothing checked *here*, so the answer arrived after the push, in a job
 * nobody was watching because the release workflow beside it had gone green.
 * A real account UUID reached the published repository that way.
 *
 * Kept deliberately in step with .github/workflows/ci.yml: same patterns, same
 * exclusions. If one changes, change both.
 *
 *   node scripts/privacy.mjs
 */
import { execFileSync } from 'node:child_process';

const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
/** Long runs of one hex digit, which no real identifier contains. */
const SYNTHETIC = /(0{4,}|1{4,}|2{4,}|a{4,}|f{4,}|deadbeef)/i;
const SCOPE = ['--', '.', ':(exclude).github/workflows/ci.yml', ':(exclude)scripts/privacy.mjs'];

/** git grep exits 1 when it matches nothing, which is the good case here. */
function grep(args) {
  try {
    return execFileSync('git', ['grep', ...args, ...SCOPE], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

let failed = false;

// Windows user-profile paths, in the single-backslash form used in prose, the
// doubled form used inside string literals, and the forward-slash spelling.
const paths = grep(['-nIiE', String.raw`C:[\\/]+Users[\\/]+[A-Za-z0-9._-]+`]);
if (paths.trim()) {
  console.error('A literal C:\\Users\\<name> path is in a tracked file:\n');
  console.error(paths.trim());
  failed = true;
}

// Each identifier is judged on its own: filtering whole lines would let a real
// one through whenever a synthetic one shared the line.
const found = new Set(
  grep(['-hoIiE', UUID])
    .split('\n')
    .map((line) => line.trim())
    .filter((id) => id && !SYNTHETIC.test(id)),
);

if (found.size > 0) {
  console.error(
    `\n${found.size} realistic UUID(s) in tracked files — fixtures must be obviously synthetic:\n`,
  );
  for (const id of found) {
    console.error(`  ${id}`);
    console.error(grep(['-nI', id]).trimEnd());
  }
  failed = true;
}

if (failed) {
  console.error('\nReplace them with values like 00000000-0000-4000-8000-00000000000a.');
  process.exit(1);
}

console.log('privacy: no personal identifiers in tracked files.');
