import { buildRestoredSession, unfosterableReasons } from '../domain/fostering.js';
import type { DiscoveredSession, StoreLayout } from '../domain/types.js';
import { findOrphanedConversations } from './orphans.js';
import type { Tombstone } from './tombstones.js';
import type { TranscriptFacts } from './transcripts.js';

/**
 * Conversations that were deleted in the app and can still be brought back.
 *
 * The set is the same one purge destroys. A conversation a card still points
 * at — Code or Cowork, this store or another the caller named — is not lost.
 */

export interface Restorable {
  tombstone: Tombstone;
  facts: TranscriptFacts;
  /** Shaped so the ordinary fostering engine can write it, ledger and all. */
  session: DiscoveredSession;
}

export function findRestorable(
  store: StoreLayout,
  env: NodeJS.ProcessEnv = process.env,
  configDirs: string[] = [],
  referenceStores: StoreLayout[] = [],
): Restorable[] {
  return findOrphanedConversations({ store, env, configDirs, referenceStores }).map((orphan) => {
    const data = buildRestoredSession(orphan.facts);
    return {
      tombstone: orphan.tombstone,
      facts: orphan.facts,
      session: {
        path: orphan.tombstone.path,
        account: orphan.account,
        data,
        isCopy: false,
        isStranded: false,
        reasons: unfosterableReasons(data),
      },
    };
  });
}
