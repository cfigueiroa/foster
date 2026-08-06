#!/usr/bin/env node
/**
 * Keeps the version honest across the four files that carry it.
 *
 * package.json is the manifest, src/version.ts is stamped into every copy foster
 * writes (so support triage can tell which build produced a file), and
 * install.ps1 pins the release it downloads. A release where these disagree
 * either installs the wrong bundle or mislabels its own output, so the release
 * workflow refuses to publish until they match the tag.
 *
 * package-lock.json carries the version too, and npm rewrites it on the next
 * install whether or not anyone asked. Left to drift it turns into diff noise
 * in unrelated branches, so it is checked and set alongside the rest.
 *
 *   node scripts/version.mjs check [vX.Y.Z]
 *   node scripts/version.mjs set X.Y.Z
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// npm records the version twice in the lockfile: once at the top level and once
// for the root package under packages[""]. Rewriting the two string literals in
// place leaves every other byte — including npm's own formatting — untouched.
function replaceVersionAfter(text, from, version, what) {
  const key = text.indexOf('"version":', from);
  if (key === -1) throw new Error(`Could not find the ${what} version in package-lock.json`);
  const open = text.indexOf('"', key + '"version":'.length);
  const close = text.indexOf('"', open + 1);
  return {
    text: text.slice(0, open + 1) + version + text.slice(close),
    end: open + 1 + version.length,
  };
}

const sources = [
  {
    label: 'package.json',
    file: 'package.json',
    read: (text) => JSON.parse(text).version,
    write: (text, version) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    label: 'package-lock.json',
    file: 'package-lock.json',
    // Both copies have to agree; joining them lets a lockfile that disagrees
    // with itself fail the same "versions disagree" check as any other file.
    read: (text) => {
      const lock = JSON.parse(text);
      const versions = [lock.version, lock.packages?.['']?.version];
      if (versions.some((version) => !version)) return undefined;
      return versions[0] === versions[1] ? versions[0] : versions.join(' / ');
    },
    write: (text, version) => {
      const rootField = replaceVersionAfter(text, 0, version, 'top-level');
      const packages = rootField.text.indexOf('"packages":', rootField.end);
      if (packages === -1) throw new Error('Could not find "packages" in package-lock.json');
      return replaceVersionAfter(rootField.text, packages, version, 'packages[""]').text;
    },
  },
  {
    label: 'src/version.ts',
    file: 'src/version.ts',
    read: (text) => text.match(/export const VERSION = '([^']+)'/)?.[1],
    write: (text, version) => text.replace(/(export const VERSION = ')[^']+(')/, `$1${version}$2`),
  },
  {
    label: 'install.ps1',
    file: 'install.ps1',
    // The installer pins a tag, so its value carries the leading "v".
    read: (text) => text.match(/\$Version\s*=\s*'v([^']+)'/)?.[1],
    write: (text, version) => text.replace(/(\$Version\s*=\s*')v[^']+(')/, `$1v${version}$2`),
  },
];

function readAll() {
  return sources.map((source) => {
    const text = readFileSync(path.join(root, source.file), 'utf8');
    const version = source.read(text);
    if (!version) throw new Error(`Could not find a version in ${source.file}`);
    return { ...source, text, version };
  });
}

function check(expectedTag) {
  const found = readAll();
  for (const entry of found) console.log(`  ${entry.label.padEnd(18)} ${entry.version}`);

  const distinct = new Set(found.map((entry) => entry.version));
  if (distinct.size > 1) {
    throw new Error(
      `Versions disagree: ${[...distinct].join(', ')}. Run: npm run version:set <X.Y.Z>`,
    );
  }

  const version = found[0].version;
  if (expectedTag) {
    const expected = expectedTag.replace(/^v/, '');
    if (expected !== version) {
      throw new Error(`Tag ${expectedTag} does not match the version in the tree (${version}).`);
    }
    console.log(`  tag ${expectedTag} matches`);
  }
  return version;
}

function set(version) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    throw new Error(`"${version}" is not a semantic version.`);
  }
  for (const source of sources) {
    const file = path.join(root, source.file);
    writeFileSync(file, source.write(readFileSync(file, 'utf8'), version));
    console.log(`  ${source.label} -> ${version}`);
  }
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === 'check') check(argument);
  else if (command === 'set') set(argument ?? '');
  else throw new Error('Usage: version.mjs check [vX.Y.Z] | set X.Y.Z');
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
