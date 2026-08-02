#!/usr/bin/env node
/**
 * Keeps the version honest across the three files that carry it.
 *
 * package.json is the manifest, src/version.ts is stamped into every copy foster
 * writes (so support triage can tell which build produced a file), and
 * install.ps1 pins the release it downloads. A release where these disagree
 * either installs the wrong bundle or mislabels its own output, so the release
 * workflow refuses to publish until they match the tag.
 *
 *   node scripts/version.mjs check [vX.Y.Z]
 *   node scripts/version.mjs set X.Y.Z
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sources = [
  {
    label: 'package.json',
    file: 'package.json',
    read: (text) => JSON.parse(text).version,
    write: (text, version) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
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
  for (const entry of found) console.log(`  ${entry.label.padEnd(16)} ${entry.version}`);

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
