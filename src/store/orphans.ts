import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSessionFileName } from '../domain/naming.js';
import { comparablePath, listAgentAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { safeReaddir } from '../util/fs.js';
import { scanStore } from './scanner.js';
import { scanAllTombstones, type Tombstone } from './tombstones.js';
import {
  indexAllTranscripts,
  readTranscriptFacts,
  transcriptRoots,
  type TranscriptFacts,
} from './transcripts.js';

/**
 * Conversations the app deleted the card for, and nothing still points at.
 *
 * Restore and purge are the two sides of this set. The difference is entirely
 * in what is required before acting: restoring adds a pointer, purging
 * destroys the files. Computing the set twice is how a Cowork card (or a card
 * in another profile) came to protect a conversation from purge while restore
 * still offered it.
 */

export interface OrphanedConversation {
  cliSessionId: string;
  /** Every copy of the transcript on disk. */
  files: string[];
  bytes: number;
  facts: TranscriptFacts;
  account: AccountRef;
  deletedAt?: number;
  tombstone: Tombstone;
}

export interface OrphanSearch {
  store: StoreLayout;
  /**
   * Further installations whose session files also count as a reference.
   * `store` is always in the set and no argument can take it out.
   */
  referenceStores?: StoreLayout[];
  /**
   * Count Cowork cards as references. Default true: a conversation a Cowork
   * session still opens is not lost, and restoring it would only duplicate it.
   */
  includeAgent?: boolean;
  env?: NodeJS.ProcessEnv;
  configDirs?: string[];
}

export function findOrphanedConversations(search: OrphanSearch): OrphanedConversation[] {
  const { store, env = process.env, configDirs = [], includeAgent = true } = search;
  const transcripts = indexAllTranscripts(transcriptRoots(env, configDirs));
  if (transcripts.size === 0) return [];

  const referenced = new Set<string>();
  const scanned = new Set<string>();
  for (const scope of [store, ...(search.referenceStores ?? [])]) {
    const key = comparablePath(scope.root);
    if (scanned.has(key)) continue;
    scanned.add(key);
    for (const session of scanStore(scope)) {
      if (session.data.cliSessionId) referenced.add(session.data.cliSessionId);
    }
    if (includeAgent) {
      for (const id of agentSessionReferences(scope)) referenced.add(id);
    }
  }

  const seen = new Set<string>();
  const out: OrphanedConversation[] = [];

  for (const tombstone of scanAllTombstones(store)) {
    const files = transcripts.get(tombstone.id);
    if (!files) continue;
    if (referenced.has(tombstone.id) || seen.has(tombstone.id)) continue;
    seen.add(tombstone.id);

    out.push({
      cliSessionId: tombstone.id,
      files,
      bytes: files.reduce((sum, file) => sum + sizeOf(file), 0),
      facts: readTranscriptFacts(files[0]!, tombstone.id),
      account: tombstone.account,
      ...(tombstone.deletedAt === undefined ? {} : { deletedAt: tombstone.deletedAt }),
      tombstone,
    });
  }

  return out.sort((a, b) => (b.facts.lastActivityAt ?? 0) - (a.facts.lastActivityAt ?? 0));
}

function agentSessionReferences(store: StoreLayout): string[] {
  const out: string[] = [];

  for (const account of listAgentAccountDirs(store)) {
    const dir = path.join(store.agentSessionsDir, account.accountUuid, account.organizationUuid);
    for (const entry of safeReaddir(dir)) {
      if (!isSessionFileName(entry)) continue;
      try {
        const data = JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as {
          cliSessionId?: unknown;
        };
        if (typeof data.cliSessionId === 'string') out.push(data.cliSessionId);
      } catch {
        // A file too broken to parse also cannot be shown to reference anything.
      }
    }
  }

  return out;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
