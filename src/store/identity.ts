import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { decodeBatch, readLog, scanTable } from '../engine/leveldb.js';
import type { StoreLayout } from '../domain/types.js';
import { readConfig } from '../store/config.js';
import { isDirectory, safeReaddir } from '../util/fs.js';

/**
 * The human name behind an account UUID, read from the app's own cache.
 *
 * The account's email and display name are not in any file foster is allowed to
 * read outright: the token cache is a credential, and the authoritative copy is
 * behind the API. But the app, having fetched its own profile once, keeps a copy
 * at rest — in the web-origin storage under `Local Storage/` and `IndexedDB/`,
 * which are Chromium LevelDB databases, the same format foster already reads for
 * the pin list. That copy is not a credential; it is cached page data, the same
 * category as the session files. So it can be read.
 *
 * Two honesties about this. It is **best-effort**: the schema is the app's, not a
 * contract, and a version that stores the profile differently makes this return
 * nothing rather than something wrong. And it only ever describes the account
 * signed in **now** — web storage belongs to the current session, so this pairs
 * one email with one directory per run, exactly as reading it off the screen
 * would. When it fails, the caller falls back to asking, or to the opt-in fetch.
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
 * is only taken when it sits in the same cached value as the account's own UUID.
 * A guess that could label the account with a stranger's address is worse than
 * no guess, which is why this returns undefined rather than a loose match.
 */
export function readIdentityFromCache(
  store: StoreLayout,
  accountUuid = readConfig(store).lastKnownAccountUuid,
): CachedIdentity | undefined {
  if (!accountUuid) return undefined;

  const found: CachedIdentity = {};

  // Every candidate string, from two sources kept deliberately separate. The
  // Local Storage database is small and holds the display name; it is read
  // through the LevelDB parser. The IndexedDB database is not — it holds whole
  // conversations, reaches hundreds of megabytes, and decompressing it to search
  // for an email is how this crashes. Its large values spill into blob files that
  // are plain bytes, so those are read raw and capped instead, never parsed.
  const sources = [
    readAllValues(path.join(store.root, 'Local Storage', 'leveldb')),
    readBlobs(path.join(store.root, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob')),
  ];

  for (const values of sources) {
    for (const value of values) {
      // Only values that name this very account are considered, so the email that
      // comes back belongs to the account being named and not to whoever else the
      // app has cached — a correspondent, a teammate.
      if (!containsUuid(value, accountUuid)) continue;

      found.email ??= value.match(EMAIL)?.[0];
      found.name ??= value.match(NAME)?.[1]?.trim();
      if (found.email && found.name) return found;
    }
  }

  return found.email || found.name ? found : undefined;
}

/**
 * Every value in a LevelDB directory, decoded to the strings it might be.
 *
 * Over-reads on purpose: every SSTable and the log are scanned, stale and
 * superseded records included, because this is a search for whether the profile
 * is present anywhere rather than for the current value of one key. Following the
 * manifest to read only live records would be more correct for a Get and is not
 * worth it here — more haystack only helps when looking for a needle.
 */
function* readAllValues(dir: string): Generator<string> {
  for (const name of safeReaddir(dir)) {
    const file = path.join(dir, name);
    try {
      // Read into memory only what is safe to. The IndexedDB holds whole
      // conversations and can reach hundreds of megabytes; readFileSync of one of
      // those, before any per-value guard can apply, is itself the crash. The
      // profile lives in a small database, so a large file is skipped rather than
      // loaded — and the small Local Storage database, where the name is, is read.
      if (fileSize(file) > MAX_FILE_BYTES) continue;
      if (name.endsWith('.ldb')) {
        const values: Buffer[] = [];
        scanTable(readFileSync(file), (_entry, value) => {
          if (worthSearching(value)) values.push(Buffer.from(value));
        });
        for (const value of values) yield* decodings(value);
      } else if (name.endsWith('.log')) {
        for (const batch of readLog(readFileSync(file), { tolerant: true })) {
          for (const entry of decodeBatch(batch.payload).entries) {
            if (worthSearching(entry.value)) yield* decodings(Buffer.from(entry.value!));
          }
        }
      }
    } catch {
      // A half-written table, a log torn by a kill, a compression this does not
      // implement: any one file failing must not stop the search across the rest.
      // Best-effort means the read that works is what counts.
    }
  }
}

/**
 * IndexedDB blob files, decoded to the strings they might hold.
 *
 * When an IndexedDB value is large, Blink stores it outside the LevelDB as a
 * plain file under `…indexeddb.blob/<db>/<dir>/<file>`. Those files are the raw
 * value bytes — no framing, no compression to bomb — so they can be read
 * directly, which is exactly what makes them safe where parsing the database is
 * not. Read capped and counted: a blob past the size limit is skipped, and the
 * walk stops after a bounded number of files, because this is a search for a
 * small profile, not a reason to load a conversation archive.
 */
function* readBlobs(root: string, budget = { files: MAX_BLOB_FILES }): Generator<string> {
  for (const entry of safeReaddir(root)) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry);
    try {
      if (isDirectory(full)) {
        yield* readBlobs(full, budget);
        continue;
      }
      budget.files -= 1;
      if (fileSize(full) > MAX_BLOB_BYTES) continue;
      yield* decodings(readFileSync(full));
    } catch {
      // A blob that vanished or cannot be read is skipped like any other file.
    }
  }
}

/**
 * The largest value worth decoding. A profile is a small JSON object; the same
 * database also holds whole conversations, and copying one of those five ways to
 * search it for an email is how a best-effort read turns into an out-of-memory
 * crash — which a `try` cannot catch, so it has to be prevented rather than
 * handled. Nothing this looks for is ever bigger than a few kilobytes.
 */
const MAX_VALUE_BYTES = 64 * 1024;

function worthSearching(value: Buffer | undefined): value is Buffer {
  return value !== undefined && value.length > 0 && value.length <= MAX_VALUE_BYTES;
}

/**
 * The largest database file this will load. `scanTable` reads the whole file and
 * decompresses every block, so an oversized one is a crash before the per-value
 * guard is ever reached. The profile's database is small; a large file is the
 * conversation store, which this has no reason to read.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** A blob larger than this is a stored document, not a profile record. */
const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** How many blob files the walk will look at before giving up — a bound, not a target. */
const MAX_BLOB_FILES = 2000;

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The candidate strings a stored value might be.
 *
 * Chromium Local Storage prefixes each value with a one-byte encoding tag — 0 for
 * UTF-16, 1 for Latin-1 — while IndexedDB values carry Blink's own framing. Rather
 * than parse either scheme, every plausible reading is produced and searched: the
 * whole buffer and its tail past a leading byte, each as UTF-8 and as UTF-16LE. A
 * wrong decoding yields text that simply does not match the patterns, so offering
 * several costs nothing and misses less.
 */
function* decodings(value: Buffer): Generator<string> {
  yield value.toString('utf8');
  yield value.toString('utf16le');
  if (value.length > 1) {
    yield value.subarray(1).toString('utf8');
    yield value.subarray(1).toString('utf16le');
  }
}

/** Whether a decoded value names the account — matched case-insensitively, bare or braced. */
function containsUuid(value: string, accountUuid: string): boolean {
  return value.toLowerCase().includes(accountUuid.toLowerCase());
}

/**
 * A one-line label from a cached identity, or undefined when there is nothing.
 *
 * Name and email together when both are known — "Leila — leila@…" is what tells
 * two accounts apart at a glance — and whichever one is present otherwise.
 */
export function identityLabel(identity: CachedIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  if (identity.name && identity.email) return `${identity.name} — ${identity.email}`;
  return identity.name ?? identity.email ?? undefined;
}
