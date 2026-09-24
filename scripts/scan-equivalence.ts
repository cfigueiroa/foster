/**
 * Prove `scanConversation` still answers what a whole-record parse answered.
 *
 * The scan reads five top-level fields — three strings and two booleans — out
 * of each JSONL line instead of building the record, and decodes the bytes as
 * latin1 instead of utf8. Both are why a sweep got cheaper; neither is allowed
 * to change an answer, and nor is the moment either field joined the read:
 * `lastMessageAt`/`lastAssistantAt` are each the **max** timestamp seen, never
 * the last record in file order, and `lastAssistantAt` skips a usage-limit
 * record (`isApiErrorMessage: true`) or a sidechain one (`isSidechain: true`)
 * the same way `lastAnswer` already does. The unit tests pin the reading
 * against `JSON.parse` on the shapes that could make them disagree — they
 * cannot pin it against shapes nobody thought of. This walks a real corpus
 * instead, so the argument for the change is a measurement.
 *
 * Both readings run over **the same bytes**, read once. Transcripts on a working
 * machine are being appended to while this runs, and reading each file twice
 * would report that as a divergence.
 *
 * What is compared is the whole answer — every record id, the last message and
 * the last answer — not a line at a time, because that is what the callers act
 * on. It reads only, writes nothing, and prints no conversation content: a file
 * that disagrees is named by path, with the counts on each side.
 *
 *   npm run equivalence                 # every transcript this machine holds
 *   npm run equivalence -- <dir|file>…  # only these
 *   npm run equivalence -- --quick      # stop at the first file that disagrees
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { recordFields, transcriptRoots } from '../src/store/transcripts.js';

interface Scan {
  uuids: Set<string>;
  lastMessageAt?: number;
  lastAssistantAt?: number;
}

/** The later of a running max and a freshly seen moment. */
function maxOf(running: number | undefined, at: number): number {
  return running === undefined ? at : Math.max(running, at);
}

/** The reading this replaced: decode as utf8, parse every line, take five fields. */
function byParsing(text: string): Scan {
  const uuids = new Set<string>();
  let lastMessageAt: number | undefined;
  let lastAssistantAt: number | undefined;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record.uuid === 'string' && record.uuid !== '') uuids.add(record.uuid);
    if (typeof record.timestamp === 'string') {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) {
        lastMessageAt = maxOf(lastMessageAt, at);
        if (
          record.type === 'assistant' &&
          record.isApiErrorMessage !== true &&
          record.isSidechain !== true
        ) {
          lastAssistantAt = maxOf(lastAssistantAt, at);
        }
      }
    }
  }
  return { uuids, lastMessageAt, lastAssistantAt };
}

/** The reading in use: decode as latin1, read the fields off each line. */
function byScanning(text: string): Scan {
  const uuids = new Set<string>();
  let lastMessageAt: number | undefined;
  let lastAssistantAt: number | undefined;

  for (const line of text.split('\n')) {
    const record = recordFields(line);
    if (!record) continue;
    if (record.uuid !== undefined && record.uuid !== '') uuids.add(record.uuid);
    if (record.timestamp !== undefined) {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) {
        lastMessageAt = maxOf(lastMessageAt, at);
        if (
          record.type === 'assistant' &&
          record.isApiErrorMessage !== true &&
          record.isSidechain !== true
        ) {
          lastAssistantAt = maxOf(lastAssistantAt, at);
        }
      }
    }
  }
  return { uuids, lastMessageAt, lastAssistantAt };
}

/** What each side holds that the other does not, and where the moments differ. */
function differences(parsed: Scan, scanned: Scan): string[] {
  const said: string[] = [];

  const onlyParsed = [...parsed.uuids].filter((id) => !scanned.uuids.has(id));
  const onlyScanned = [...scanned.uuids].filter((id) => !parsed.uuids.has(id));
  if (onlyParsed.length > 0) said.push(`${onlyParsed.length} id(s) only the parse found`);
  if (onlyScanned.length > 0) said.push(`${onlyScanned.length} id(s) only the scan found`);

  if (parsed.lastMessageAt !== scanned.lastMessageAt) {
    said.push(`last message ${String(parsed.lastMessageAt)} vs ${String(scanned.lastMessageAt)}`);
  }
  if (parsed.lastAssistantAt !== scanned.lastAssistantAt) {
    said.push(
      `last answer ${String(parsed.lastAssistantAt)} vs ${String(scanned.lastAssistantAt)}`,
    );
  }
  return said;
}

function filesUnder(entry: string): string[] {
  let stats;
  try {
    stats = statSync(entry);
  } catch {
    return [];
  }
  if (stats.isFile()) return entry.endsWith('.jsonl') ? [entry] : [];
  if (!stats.isDirectory()) return [];

  const found: string[] = [];
  for (const name of readdirSync(entry)) found.push(...filesUnder(path.join(entry, name)));
  return found;
}

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const targets = args.filter((arg) => !arg.startsWith('--'));
const roots = targets.length > 0 ? targets : transcriptRoots();

const files = [...new Set(roots.flatMap(filesUnder))].sort();
console.log(`${files.length} transcript(s) under ${roots.length} root(s)`);

let bytes = 0;
let ids = 0;
let disagreed = 0;
let parsingMs = 0;
let scanningMs = 0;

for (const file of files) {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    continue;
  }
  bytes += raw.length;

  // One read, two decodes: whatever a live session appends next is outside both.
  const asUtf8 = raw.toString('utf8');
  const asLatin1 = raw.toString('latin1');

  const startParse = performance.now();
  const parsed = byParsing(asUtf8);
  parsingMs += performance.now() - startParse;

  const startScan = performance.now();
  const scanned = byScanning(asLatin1);
  scanningMs += performance.now() - startScan;

  ids += parsed.uuids.size;

  const said = differences(parsed, scanned);
  if (said.length > 0) {
    disagreed++;
    console.log(`  DIVERGED ${file}`);
    for (const line of said) console.log(`    ${line}`);
    if (quick) break;
  }
}

const mb = bytes / (1024 * 1024);
console.log('');
console.log(`${files.length} file(s), ${mb.toFixed(0)} MB, ${ids} record id(s)`);
console.log(
  `  parsing  ${(parsingMs / 1000).toFixed(1)} s  (${(mb / (parsingMs / 1000)).toFixed(0)} MB/s)`,
);
console.log(
  `  scanning ${(scanningMs / 1000).toFixed(1)} s  (${(mb / (scanningMs / 1000)).toFixed(0)} MB/s)`,
);
console.log(
  disagreed === 0
    ? 'Every file reads the same both ways.'
    : `${disagreed} file(s) disagree — the change is not equivalent.`,
);
process.exit(disagreed === 0 ? 0 : 1);
