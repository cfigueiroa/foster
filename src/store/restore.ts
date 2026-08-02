import { buildRestoredSession, unfosterableReasons } from '../domain/fostering.js';
import type { DiscoveredSession, StoreLayout } from '../domain/types.js';
import { scanStore } from './scanner.js';
import { scanAllTombstones, type Tombstone } from './tombstones.js';
import {
  indexTranscripts,
  readTranscriptFacts,
  transcriptRoots,
  type TranscriptFacts,
} from './transcripts.js';

/**
 * Conversations that were deleted in the app and can still be brought back.
 *
 * Deleting a session removes the pointer and leaves the conversation. The app
 * will not offer to re-import it — its own recovery scan treats a tombstoned id
 * as deliberately discarded — but nothing stops a session file that points at
 * that conversation from being written and loaded. For an accidental deletion
 * that is the only route left.
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
): Restorable[] {
  const roots = transcriptRoots(env, configDirs);
  const transcripts = indexTranscripts(roots);
  if (transcripts.size === 0) return [];

  // Conversations a session file already points at, anywhere on disk. A tombstoned
  // id that is still referenced was not lost — the app itself skips those when it
  // scans for recoverable transcripts, and restoring one would only duplicate it.
  const referenced = new Set<string>();
  for (const session of scanStore(store)) {
    if (session.data.cliSessionId) referenced.add(session.data.cliSessionId);
  }

  const seen = new Set<string>();
  const out: Restorable[] = [];

  for (const tombstone of scanAllTombstones(store)) {
    // Deleting writes one marker per identifier the session carried, so most of
    // them are session ids with no conversation behind them. Having a transcript
    // is what identifies the one that matters.
    const file = transcripts.get(tombstone.id);
    if (!file) continue;
    if (referenced.has(tombstone.id) || seen.has(tombstone.id)) continue;
    seen.add(tombstone.id);

    const facts = readTranscriptFacts(file, tombstone.id);
    const data = buildRestoredSession(facts);

    out.push({
      tombstone,
      facts,
      session: {
        // The tombstone is where this was found; there is no session file left.
        path: tombstone.path,
        // Credited to the account it was deleted from, which is what the copy
        // records as its origin.
        account: tombstone.account,
        data,
        isCopy: false,
        reasons: unfosterableReasons(data),
      },
    });
  }

  return out.sort((a, b) => (b.facts.lastActivityAt ?? 0) - (a.facts.lastActivityAt ?? 0));
}
