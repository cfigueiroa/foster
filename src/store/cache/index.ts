import path from 'node:path';
import { SlimCardCache } from './cardCache.js';
import { cacheDisabled, defaultCacheDir } from './env.js';
import { TranscriptCache } from './transcriptCache.js';

export { readSessionCardCached, SlimCardCache } from './cardCache.js';
export {
  cachedScanConversation,
  cachedScanConversationFiles,
  TranscriptCache,
} from './transcriptCache.js';
export { cacheDisabled, cacheStats, clearCache, defaultCacheDir, type CacheStats } from './env.js';
export { CACHE_SCHEMA } from './schema.js';

/** Both halves of the persistent cache, opened together and saved together. */
export interface FosterCache {
  cards: SlimCardCache;
  transcripts: TranscriptCache;
  save(): void;
}

/**
 * Open the persistent cache for one run, or nothing when it is switched off.
 *
 * The two files live under `defaultCacheDir(env)`; nothing here creates the
 * directory, or reads either file — both are opened lazily, on first use, so a
 * command that asks for a cache but never scans anything pays nothing for it.
 */
export function openFosterCache(
  env: NodeJS.ProcessEnv = process.env,
  noCacheFlag = false,
): FosterCache | undefined {
  if (cacheDisabled(env, noCacheFlag)) return undefined;
  const dir = defaultCacheDir(env);
  const cards = new SlimCardCache(path.join(dir, 'cards.ndjson'));
  const transcripts = new TranscriptCache(path.join(dir, 'transcripts.bin'));
  return {
    cards,
    transcripts,
    save() {
      cards.save();
      transcripts.save();
    },
  };
}
