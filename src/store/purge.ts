import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSessionFileName } from '../domain/naming.js';
import { comparablePath, listAgentAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { safeReaddir } from '../util/fs.js';
import { scanStore } from './scanner.js';
import { scanAllTombstones } from './tombstones.js';
import {
  indexAllTranscripts,
  readTranscriptFacts,
  transcriptRoots,
  type TranscriptFacts,
} from './transcripts.js';

/**
 * Conversations that survive a deletion, found so they can be destroyed.
 *
 * This is `findRestorable` read the other way round. Deleting a session in the
 * app removes the card and keeps the conversation, which is what makes an
 * accidental deletion recoverable — and what makes a deliberate one incomplete.
 * Everything that was ever said is still in a file on disk, and `foster restore`
 * is proof that it is not merely present but reachable.
 *
 * So the same set answers both questions. The difference is entirely in what is
 * required before acting on it: restoring adds a pointer and can be undone by
 * removing it, while purging is the only operation in foster with nothing behind
 * it. The gates live in the engine and the CLI; this module only reads.
 */

export interface Purgeable {
  cliSessionId: string;
  /** Every copy of the transcript on disk. All of them have to go, or none did. */
  files: string[];
  /** Total size of those files, which is the only measure of what is being lost. */
  bytes: number;
  facts: TranscriptFacts;
  /** The account the deletion was recorded under. */
  account: AccountRef;
  deletedAt?: number;
}

export interface PurgeSearch {
  /** Where the app's deletion markers are read from. */
  store: StoreLayout;
  /**
   * Further installations whose session files also count as a reference.
   *
   * A conversation that any card still points at is not a leftover — it is live
   * work, one restart away from the sidebar — and destroying it would gut a
   * session the user can see. `findRestorable` asks that question of one store,
   * because being wrong there means offering a duplicate. Being wrong here means
   * losing the conversation, so the answer should come from every store foster
   * can reach.
   *
   * Additive on purpose. This started out as the whole list, and a caller that
   * built it from "every installation foster knows about" produced a list that
   * did not contain the store being worked on — a temporary one, which nothing
   * had heard of — so every card in it counted for nothing and its live
   * conversations were offered up for destruction. `store` is now always in the
   * set and no argument can take it out.
   */
  referenceStores?: StoreLayout[];
  env?: NodeJS.ProcessEnv;
  configDirs?: string[];
}

export function findPurgeable(search: PurgeSearch): Purgeable[] {
  const { store, env = process.env, configDirs = [] } = search;
  const transcripts = indexAllTranscripts(transcriptRoots(env, configDirs));
  if (transcripts.size === 0) return [];

  const referenced = new Set<string>();
  const scanned = new Set<string>();
  for (const scope of [store, ...(search.referenceStores ?? [])]) {
    // Two spellings of one directory would otherwise read every card in it
    // twice, which costs a full rescan per duplicate on a store holding hundreds.
    const key = comparablePath(scope.root);
    if (scanned.has(key)) continue;
    scanned.add(key);
    for (const session of scanStore(scope)) {
      if (session.data.cliSessionId) referenced.add(session.data.cliSessionId);
    }
    for (const id of agentSessionReferences(scope)) referenced.add(id);
  }

  const seen = new Set<string>();
  const out: Purgeable[] = [];

  for (const tombstone of scanAllTombstones(store)) {
    // Deleting writes one marker per identifier the session carried, so most of
    // them name nothing. Having a transcript is what identifies the one that
    // still holds a conversation.
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
    });
  }

  return out.sort((a, b) => (b.facts.lastActivityAt ?? 0) - (a.facts.lastActivityAt ?? 0));
}

/**
 * Conversation ids the Cowork tree points at.
 *
 * `scanStore` reads Code sessions and nothing else, which is the right scope for
 * every other command: Cowork sessions are not fosterable, so they are not
 * candidates. The question here is a different one — not "can this be copied?"
 * but "is anything still pointing at it?" — and a card in
 * `local-agent-mode-sessions` points just as firmly as one next door. Leaving it
 * out means a Cowork session's conversation could be destroyed under it.
 */
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
        // Skipped like any other unreadable card. Worth naming, since this one
        // guards a deletion: a file too broken to parse also cannot be shown to
        // reference anything, so a corrupt Cowork card protects nothing.
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
