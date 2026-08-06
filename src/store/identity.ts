import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { StoreLayout } from '../domain/types.js';
import { readConfig } from '../store/config.js';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * The human name behind an account UUID, read from the app's own cache.
 *
 * The account's email and display name are not in any file foster is allowed to
 * read outright: the token cache is a credential, and the authoritative copy is
 * behind the API. But the app, having fetched its own profile once, keeps a copy
 * at rest, in the web-origin storage under `Local Storage/` and `IndexedDB/`.
 * That copy is cached page data, the same category as the session files, so it
 * can be read.
 *
 * It is read the crudest way on purpose: every candidate file is loaded as bytes,
 * capped by size, and searched as text. An earlier version parsed the Local
 * Storage LevelDB with the same reader foster uses for the pin list — and that
 * reader, written for one narrow database, corrupted the heap on a real Local
 * Storage table and took the process down with a status no `try` can catch
 * (0xC0000374). Parsing the app's storage means trusting a format that is the
 * app's to change; reading bytes and looking for an email trusts nothing. It
 * finds less — a value that only exists inside a compressed block is missed — but
 * it cannot crash, and a best-effort read that crashes is not best-effort.
 *
 * Two honesties beyond that. It is best-effort: a version that stores the profile
 * differently makes this find nothing rather than something wrong, and the manual
 * `label` is always there. And it only ever describes the account signed in now,
 * because web storage belongs to the current session — naming the others still
 * means visiting each.
 */

export interface CachedIdentity {
  email?: string;
  name?: string;
}

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const NAME = /"(?:full_name|fullName|display_name|displayName|name)"\s*:\s*"([^"]{1,80})"/;

/**
 * The account's identity from cache, or undefined when nothing can be tied to it.
 *
 * Tied is the word that matters. The cache holds emails that are not the
 * account's — a correspondent quoted in a conversation, a teammate — so an email
 * is only taken from a chunk of text that also carries the account's own UUID. A
 * guess that could label the account with a stranger's address is worse than no
 * guess, which is why this returns undefined rather than a loose match.
 */
export function readIdentityFromCache(
  store: StoreLayout,
  accountUuid = readConfig(store).lastKnownAccountUuid,
): CachedIdentity | undefined {
  if (!accountUuid) return undefined;
  const needle = accountUuid.toLowerCase();
  const found: CachedIdentity = {};

  for (const text of readCandidateFiles(store)) {
    // Extracted only when it sits close to the account's own id. A file can hold
    // the profile and, elsewhere, a conversation with a different person's
    // address; the profile keeps the email in the same small object as the uuid,
    // a few characters away, while a stranger's address is off in another record.
    // Nearest-to-the-uuid, within a bound, is what tells the two apart.
    found.email ??= nearest(text, needle, EMAIL, (m) => m[0]);
    found.name ??= nearest(text, needle, NAME, (m) => m[1]?.trim());
    if (found.email && found.name) return found;
  }

  return found.email || found.name ? found : undefined;
}

/**
 * The text of every file worth searching, each decoded a few plausible ways.
 *
 * Both stores are read the same crude way — bytes, size-capped — because neither
 * is parsed. Local Storage is small and holds the display name; the IndexedDB
 * blob tree holds the large values, the email among them, as plain files. The
 * IndexedDB LevelDB itself is skipped: it is the conversation database, big and
 * the source of the crash, and nothing here needs it.
 */
function* readCandidateFiles(store: StoreLayout): Generator<string> {
  const localStorage = path.join(store.root, 'Local Storage', 'leveldb');
  for (const name of safeReaddir(localStorage)) {
    if (name.endsWith('.ldb') || name.endsWith('.log')) {
      yield* readFileText(path.join(localStorage, name));
    }
  }

  yield* walkBlobs(path.join(store.root, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob'), {
    files: MAX_BLOB_FILES,
  });
}

/** The blob tree, walked breadth-unaware but bounded, each file read as text. */
function* walkBlobs(root: string, budget: { files: number }): Generator<string> {
  for (const entry of safeReaddir(root)) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry);
    try {
      if (isDirectory(full)) {
        yield* walkBlobs(full, budget);
        continue;
      }
    } catch {
      continue;
    }
    budget.files -= 1;
    yield* readFileText(full);
  }
}

/**
 * A file's bytes, decoded to the strings they might be — or nothing.
 *
 * Size-capped before it is opened: a file past the limit is a conversation store
 * or a document, never a profile record, and reading it is the memory the crude
 * approach exists to avoid spending. The bytes are offered as UTF-8 and as
 * UTF-16LE because Chromium stores strings both ways; a wrong decoding simply
 * fails to match the patterns.
 */
function* readFileText(file: string): Generator<string> {
  try {
    if (fileSize(file) > MAX_FILE_BYTES) return;
    trace(`${path.basename(file)} (${fileSize(file)} bytes)`);
    const bytes = readFileSync(file);
    yield bytes.toString('latin1');
    yield bytes.toString('utf16le');
  } catch {
    // A file that vanished, is locked, or cannot be read is skipped; the search
    // across the rest is what matters, and its failure is not an error.
  }
}

/**
 * The match closest to any occurrence of the account id, if one is close enough.
 *
 * Closeness is the whole safeguard. The profile's email and name sit beside the
 * uuid in one small object; a stranger's address, cached from a conversation, is
 * in a different record and further away. Taking the match nearest the uuid — and
 * only when it is within a profile-object's reach — keeps the wrong one from
 * winning, in a way a plain "somewhere in the same file" cannot.
 */
function nearest(
  text: string,
  needle: string,
  pattern: RegExp,
  pick: (match: RegExpExecArray) => string | undefined,
): string | undefined {
  const uuids = occurrences(text.toLowerCase(), needle);
  if (uuids.length === 0) return undefined;

  const source = new RegExp(pattern.source, 'g');
  let best: { value: string; distance: number } | undefined;

  for (let match = source.exec(text); match; match = source.exec(text)) {
    const value = pick(match);
    if (!value) continue;
    // Between spans, not between start points: the account id is 36 characters
    // long, so a field beside it but after it starts far from its beginning while
    // a neighbour before it starts near — measuring start-to-start would prefer
    // the neighbour. The gap between the two spans is what "beside" really means.
    const start = match.index;
    const end = match.index + match[0].length;
    const distance = Math.min(...uuids.map((at) => gap(at, at + needle.length, start, end)));
    if (distance <= MAX_DISTANCE && (!best || distance < best.distance)) {
      best = { value, distance };
    }
  }

  return best?.value;
}

/** The number of characters between two spans, or 0 when they touch or overlap. */
function gap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, bStart - aEnd, aStart - bEnd);
}

/** Every index where the account id appears, searched in the lower-cased text. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    out.push(at);
  }
  return out;
}

/**
 * How far from the account id a match may be and still be its own.
 *
 * A profile object — uuid, email, name and a few other fields — is a few hundred
 * characters at most, so a match beyond this is in some other record and not the
 * account's. Small enough to exclude a neighbour, generous enough to span the
 * object the uuid lives in.
 */
const MAX_DISTANCE = 600;

/**
 * The largest file this will read. Nothing being looked for lives in a big file;
 * a big file is a conversation store or a stored document, and loading one is the
 * cost — in memory, and in the crash that motivated all of this — that reading
 * bytes crudely is meant to avoid.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** How many blob files the walk will look at before giving up — a bound, not a target. */
const MAX_BLOB_FILES = 4000;

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * A breadcrumb before each file is opened, printed only when FOSTER_DEBUG is set.
 *
 * The read can be killed in a way no `try` catches — a heap fault, an
 * out-of-memory abort, a security tool that mistakes reading browser storage for
 * theft — and a crash that leaves no error is diagnosable only by what was about
 * to be read. The last line this prints before silence names the file that did it.
 */
function trace(message: string): void {
  if (process.env.FOSTER_DEBUG) process.stderr.write(`[foster] ${message}\n`);
}

/**
 * A one-line label from a cached identity, or undefined when there is nothing.
 *
 * Name and email together when both are known — "John — john@…" is what tells
 * two accounts apart at a glance — and whichever one is present otherwise.
 */
export function identityLabel(identity: CachedIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  if (identity.name && identity.email) return `${identity.name} — ${identity.email}`;
  return identity.name ?? identity.email ?? undefined;
}
