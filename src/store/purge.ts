import type { AccountRef, StoreLayout } from '../domain/types.js';
import { findOrphanedConversations } from './orphans.js';
import type { TranscriptFacts } from './transcripts.js';

/**
 * Conversations that survive a deletion, found so they can be destroyed.
 *
 * This is `findRestorable` read the other way round: the same orphan set, then
 * the files rather than a reconstructed pointer. The gates live in the engine
 * and the CLI; this module only reads.
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
  store: StoreLayout;
  /**
   * Further installations whose session files also count as a reference.
   * `store` is always in the set and no argument can take it out.
   */
  referenceStores?: StoreLayout[];
  env?: NodeJS.ProcessEnv;
  configDirs?: string[];
}

export function findPurgeable(search: PurgeSearch): Purgeable[] {
  return findOrphanedConversations(search).map((orphan) => ({
    cliSessionId: orphan.cliSessionId,
    files: orphan.files,
    bytes: orphan.bytes,
    facts: orphan.facts,
    account: orphan.account,
    ...(orphan.deletedAt === undefined ? {} : { deletedAt: orphan.deletedAt }),
  }));
}
