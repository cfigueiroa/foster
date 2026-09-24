import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSessionFileName } from '../domain/naming.js';
import { listAgentAccountDirs } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import { safeReaddir } from '../util/fs.js';
import { BULKY_CARD_FIELDS } from '../store/sessionFile.js';
import { SESSION_FILE_MAX_BYTES } from '../store/scanner.js';
import { indexAllTranscripts, projectDirName, transcriptRoots } from '../store/transcripts.js';

/**
 * `foster disk` — where the bytes are, and what is safe to look at removing.
 *
 * Report only: nothing here deletes anything, and nothing here decides that a
 * file is safe to remove — `foster purge` already owns that judgement (a
 * tombstone plus nothing referencing the conversation any more), and this
 * module never asks its question. What this answers is narrower and cheaper:
 * which accounts and which working directories the bytes on disk belong to,
 * how much of a card's own JSON is the fields `BULKY_CARD_FIELDS` names,
 * which transcripts nothing on this store's cards points at any more (with or
 * without a tombstone — `findOrphanedConversations` is stricter, and requires
 * one), which transcript files are byte-for-byte copies of each other, and
 * which session cards are already over the app's own 10 MB load limit.
 */

export interface AccountDiskUsage {
  account: AccountRef;
  cardBytes: number;
  cardCount: number;
  /** The slice of `cardBytes` that is `BULKY_CARD_FIELDS`, by JSON size of the field's value. */
  bulkyCardBytes: number;
  /**
   * Bytes of transcript this account's cards can reach — the union of every
   * conversation any of its cards (native or copied) points at. A conversation
   * fostered into more than one account counts once per account that holds it,
   * which is "how much this sidebar reaches", not a partition of disk space:
   * the transcript itself sits once on disk regardless of how many accounts
   * open it.
   */
  transcriptBytes: number;
  transcriptCount: number;
}

export interface ProjectDiskUsage {
  /** The encoded directory name transcripts are actually filed under — see `projectDirName`. */
  project: string;
  cardBytes: number;
  cardCount: number;
  transcriptBytes: number;
  transcriptCount: number;
}

/** How much of a card's bytes are `BULKY_CARD_FIELDS`, broken down by field. */
export interface BulkyFieldUsage {
  field: string;
  bytes: number;
  cardCount: number;
}

export interface OrphanTranscript {
  cliSessionId: string;
  files: string[];
  bytes: number;
}

export interface DuplicateTranscriptGroup {
  bytes: number;
  files: string[];
}

export interface OversizedCard {
  path: string;
  account: AccountRef;
  bytes: number;
}

export interface DiskReport {
  accounts: AccountDiskUsage[];
  projects: ProjectDiskUsage[];
  bulkyFields: BulkyFieldUsage[];
  totals: {
    cardBytes: number;
    cardCount: number;
    bulkyCardBytes: number;
    transcriptBytes: number;
    transcriptCount: number;
  };
  orphanTranscripts: OrphanTranscript[];
  duplicateTranscripts: DuplicateTranscriptGroup[];
  oversizedCards: OversizedCard[];
}

/** `<accountUuid>/<organizationUuid>`, the key `resolveDestination` and friends key accounts by. */
function accountKey(account: AccountRef): string {
  return `${account.accountUuid}/${account.organizationUuid}`;
}

/**
 * Every conversation a Cowork (agent-mode) session references, across every
 * account. Mirrors `agentSessionReferences` in `store/orphans.ts` — kept as its
 * own small copy here rather than importing that unexported function, so this
 * report has no dependency on a module another package in this milestone may
 * also be touching.
 */
function agentReferencedIds(store: StoreLayout): Set<string> {
  const ids = new Set<string>();
  for (const account of listAgentAccountDirs(store)) {
    const dir = path.join(store.agentSessionsDir, account.accountUuid, account.organizationUuid);
    for (const entry of safeReaddir(dir)) {
      if (!isSessionFileName(entry)) continue;
      try {
        const data = JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as {
          cliSessionId?: unknown;
        };
        if (typeof data.cliSessionId === 'string') ids.add(data.cliSessionId);
      } catch {
        // A file too broken to parse also cannot be shown to reference anything.
      }
    }
  }
  return ids;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Measure the store `sessions` was scanned from. `sessions` is passed in
 * rather than read here so a caller that already has a full (non-slim) scan —
 * `foster disk` does — never reads the store twice; passing a slim scan would
 * silently report every bulky field as absent, since a slim scan is exactly
 * what leaves them out.
 */
export function diskReport(
  store: StoreLayout,
  sessions: DiscoveredSession[],
  env: NodeJS.ProcessEnv = process.env,
): DiskReport {
  const accounts = new Map<string, AccountDiskUsage>();
  // Keyed lowercase: a cwd's casing can differ from the directory name already
  // on disk on a case-insensitive filesystem, the same lossiness `fileOpenedFrom`
  // (`store/transcripts.ts`) already normalizes for. The label kept alongside
  // is whichever spelling was seen first, purely for display.
  const projects = new Map<string, { label: string; cardBytes: number; cardCount: number }>();
  const bulkyByField = new Map<string, { bytes: number; cardCount: number }>();
  const oversizedCards: OversizedCard[] = [];
  const referencedIds = new Set<string>();
  const idsByAccount = new Map<string, Set<string>>();

  let totalCardBytes = 0;
  let totalCardCount = 0;
  let totalBulkyBytes = 0;

  for (const field of BULKY_CARD_FIELDS) bulkyByField.set(field, { bytes: 0, cardCount: 0 });

  for (const found of sessions) {
    const key = accountKey(found.account);
    const bytes = sizeOf(found.path);
    totalCardBytes += bytes;
    totalCardCount += 1;

    let bulkyBytes = 0;
    const record = found.data as unknown as Record<string, unknown>;
    for (const field of BULKY_CARD_FIELDS) {
      if (!(field in record) || record[field] === undefined) continue;
      let fieldBytes = 0;
      try {
        fieldBytes = Buffer.byteLength(JSON.stringify(record[field]), 'utf8');
      } catch {
        // A value JSON cannot round-trip (a circular reference the app itself
        // would never write) contributes nothing rather than throwing the
        // whole report away.
        continue;
      }
      bulkyBytes += fieldBytes;
      const tally = bulkyByField.get(field)!;
      tally.bytes += fieldBytes;
      tally.cardCount += 1;
    }
    totalBulkyBytes += bulkyBytes;

    const accountUsage = accounts.get(key) ?? {
      account: found.account,
      cardBytes: 0,
      cardCount: 0,
      bulkyCardBytes: 0,
      transcriptBytes: 0,
      transcriptCount: 0,
    };
    accountUsage.cardBytes += bytes;
    accountUsage.cardCount += 1;
    accountUsage.bulkyCardBytes += bulkyBytes;
    accounts.set(key, accountUsage);

    const project = projectDirName(found.data.cwd ?? '') || '(no working directory)';
    const projectKey = project.toLowerCase();
    const projectUsage = projects.get(projectKey) ?? { label: project, cardBytes: 0, cardCount: 0 };
    projectUsage.cardBytes += bytes;
    projectUsage.cardCount += 1;
    projects.set(projectKey, projectUsage);

    if (bytes > SESSION_FILE_MAX_BYTES) {
      oversizedCards.push({ path: found.path, account: found.account, bytes });
    }

    if (found.data.cliSessionId) {
      referencedIds.add(found.data.cliSessionId);
      const set = idsByAccount.get(key) ?? new Set<string>();
      set.add(found.data.cliSessionId);
      idsByAccount.set(key, set);
    }
  }

  const roots = transcriptRoots(env);
  const index = indexAllTranscripts(roots);

  const transcriptProjectUsage = new Map<string, { label: string; bytes: number; count: number }>();
  const allFiles: { path: string; bytes: number }[] = [];
  const fileBytes = new Map<string, number>();
  let totalTranscriptBytes = 0;
  let totalTranscriptCount = 0;

  for (const files of index.values()) {
    for (const file of files) {
      const bytes = sizeOf(file);
      fileBytes.set(file, bytes);
      totalTranscriptBytes += bytes;
      totalTranscriptCount += 1;
      allFiles.push({ path: file, bytes });

      const project = path.basename(path.dirname(file));
      const projectKey = project.toLowerCase();
      const usage = transcriptProjectUsage.get(projectKey) ?? {
        label: project,
        bytes: 0,
        count: 0,
      };
      usage.bytes += bytes;
      usage.count += 1;
      transcriptProjectUsage.set(projectKey, usage);
    }
  }

  // A project can hold transcripts and never a card (nobody ever opened one
  // there) or a card and no transcript on this machine (fostered from a store
  // whose transcripts never travelled) — the union of both key sets is what
  // gives every project a row.
  const projectList: ProjectDiskUsage[] = [
    ...new Set([...projects.keys(), ...transcriptProjectUsage.keys()]),
  ]
    .map((projectKey) => {
      const cards = projects.get(projectKey);
      const transcripts = transcriptProjectUsage.get(projectKey);
      return {
        project: cards?.label ?? transcripts?.label ?? projectKey,
        cardBytes: cards?.cardBytes ?? 0,
        cardCount: cards?.cardCount ?? 0,
        transcriptBytes: transcripts?.bytes ?? 0,
        transcriptCount: transcripts?.count ?? 0,
      };
    })
    .sort((a, b) => b.cardBytes + b.transcriptBytes - (a.cardBytes + a.transcriptBytes));

  // Reuses the sizes already measured above rather than asking `transcriptBytes`
  // (`store/transcripts.ts`) to walk and index the roots again per account.
  for (const usage of accounts.values()) {
    const ids = idsByAccount.get(accountKey(usage.account)) ?? new Set<string>();
    let bytes = 0;
    let count = 0;
    for (const id of ids) {
      const files = index.get(id);
      if (!files || files.length === 0) continue;
      bytes += files.reduce((sum, file) => sum + (fileBytes.get(file) ?? 0), 0);
      count += 1;
    }
    usage.transcriptBytes = bytes;
    usage.transcriptCount = count;
  }

  // Orphans: a conversation on disk that no card, in any account, and no
  // Cowork session either, still points at. Broader than `findOrphanedConversations`
  // — that one also requires a tombstone, which is how it decides *purging* is
  // safe; this is only counting, so it does not.
  const agentIds = agentReferencedIds(store);
  const orphanTranscripts: OrphanTranscript[] = [];
  for (const [cliSessionId, files] of index) {
    if (referencedIds.has(cliSessionId) || agentIds.has(cliSessionId)) continue;
    orphanTranscripts.push({
      cliSessionId,
      files,
      bytes: files.reduce((sum, file) => sum + (fileBytes.get(file) ?? 0), 0),
    });
  }
  orphanTranscripts.sort((a, b) => b.bytes - a.bytes);

  const duplicateTranscripts = findDuplicateFiles(allFiles);

  return {
    accounts: [...accounts.values()].sort((a, b) => b.cardBytes - a.cardBytes),
    projects: projectList,
    bulkyFields: [...bulkyByField.entries()]
      .map(([field, tally]) => ({ field, bytes: tally.bytes, cardCount: tally.cardCount }))
      .sort((a, b) => b.bytes - a.bytes),
    totals: {
      cardBytes: totalCardBytes,
      cardCount: totalCardCount,
      bulkyCardBytes: totalBulkyBytes,
      transcriptBytes: totalTranscriptBytes,
      transcriptCount: totalTranscriptCount,
    },
    orphanTranscripts,
    duplicateTranscripts,
    oversizedCards: oversizedCards.sort((a, b) => b.bytes - a.bytes),
  };
}

/**
 * Byte-identical files, grouped. Only files that already share a size are
 * hashed — two files of different sizes cannot be identical, and skipping the
 * read is the whole saving on a store whose transcripts run into the
 * gigabytes. Hashing itself streams rather than reading a file whole, for the
 * same reason.
 */
function findDuplicateFiles(files: { path: string; bytes: number }[]): DuplicateTranscriptGroup[] {
  const bySize = new Map<number, string[]>();
  for (const file of files) {
    if (file.bytes === 0) continue; // Two empty files are not a meaningful duplicate to report.
    const group = bySize.get(file.bytes) ?? [];
    group.push(file.path);
    bySize.set(file.bytes, group);
  }

  const groups: DuplicateTranscriptGroup[] = [];
  for (const [bytes, paths] of bySize) {
    if (paths.length < 2) continue;
    const byHash = new Map<string, string[]>();
    for (const filePath of paths) {
      const hash = hashOf(filePath);
      if (hash === undefined) continue;
      const group = byHash.get(hash) ?? [];
      group.push(filePath);
      byHash.set(hash, group);
    }
    for (const group of byHash.values()) {
      if (group.length > 1) groups.push({ bytes, files: group.sort() });
    }
  }

  return groups.sort((a, b) => b.bytes * b.files.length - a.bytes * a.files.length);
}

/** How much of a file to hold in memory at once while hashing it — see `streamLines` in transcripts.ts. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/** A file's sha256, read a chunk at a time so a multi-gigabyte transcript costs a buffer, not its own size. */
function hashOf(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
