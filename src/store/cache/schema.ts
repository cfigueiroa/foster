/**
 * Version of the on-disk shape the two cache files use.
 *
 * Bumped whenever a stored record changes in a way an old reader could
 * misread — a field added, removed or repacked. A mismatch against a file
 * already on disk means "ignore it and rebuild", never an error: see
 * `cardCache.ts` and `transcriptCache.ts` for where this is checked.
 */
export const CACHE_SCHEMA = 2;
