import {
  conversationRoot,
  indexTranscripts,
  scanConversation,
  transcriptRoots,
  type ConversationScan,
} from '../store/transcripts.js';

/**
 * Which conversations are the same work, when their identifiers disagree.
 *
 * `continued.ts` explains the branch: a conversation with a live writer cannot be
 * continued from a second card, so the app copies its history into a new
 * transcript with a new id and moves the card onto that. Everything downstream of
 * a branch reads as two unrelated conversations — different `cliSessionId`,
 * different files — while being one piece of work that happened to fork.
 *
 * The answer is the first record both files still share. See `conversationRoot`.
 *
 * Reads are deferred and remembered: the transcript index is a directory walk and
 * most runs never need it, while the ones that do ask about the same handful of
 * conversations repeatedly.
 */
export interface Lineage {
  /**
   * The conversation this one descends from, `undefined` when unanswerable —
   * no transcript on disk, or nothing in its head to go on. Two ids with the
   * same root are the same work; two with different roots are not; and an
   * `undefined` on either side is not an answer at all.
   */
  rootOf(cliSessionId: string | undefined): string | undefined;
  /** True when both ids resolve, and to the same root. */
  sameWork(a: string | undefined, b: string | undefined): boolean;
  /**
   * The whole transcript, read once per run.
   *
   * This replaced a `lastWriteOf` that answered "which of these branches kept
   * going?" with the file's `mtime` — a question `stat` cannot answer, because
   * the app rewrites its own bookkeeping into a transcript every time a card is
   * opened. Reading the records is the only honest form of that question, and
   * `branches.ts` is where the reading is interpreted.
   *
   * Memoised here rather than there because this is already the per-run memo, and
   * the alternative is measurable: `status` builds one sidebar per account, so a
   * store with six accounts asks about the same handful of forked transcripts
   * six times over. Undefined when there is no transcript to read.
   */
  scanOf(cliSessionId: string | undefined): ConversationScan | undefined;
}

/**
 * Test seam: an empty list so unit tests never walk the real `~/.claude`.
 * Production never calls this. A test that is asking about branches passes
 * its own tree to `lineageAt` / `projectsDirs` instead.
 */
let installedRoots: string[] | undefined;

export function useTranscriptRoots(dirs: string[] | undefined): void {
  installedRoots = dirs;
}

export function lineageAt(projectsDirs: string[]): Lineage {
  let transcripts: Map<string, string> | undefined;
  const roots = new Map<string, string | undefined>();
  const scans = new Map<string, ConversationScan | undefined>();

  const fileOf = (cliSessionId: string | undefined): string | undefined => {
    if (cliSessionId === undefined || cliSessionId === '') return undefined;
    transcripts ??= indexTranscripts(projectsDirs);
    return transcripts.get(cliSessionId);
  };

  const rootOf = (cliSessionId: string | undefined): string | undefined => {
    if (cliSessionId === undefined || cliSessionId === '') return undefined;
    // `has` rather than a truthy check: a conversation whose root could not be
    // read is remembered as unanswerable, so a failed read is not repeated for
    // every card that points at it.
    if (roots.has(cliSessionId)) return roots.get(cliSessionId);

    const file = fileOf(cliSessionId);
    const root = file ? conversationRoot(file) : undefined;
    roots.set(cliSessionId, root);
    return root;
  };

  return {
    rootOf,
    sameWork(a, b) {
      if (a === undefined || b === undefined) return false;
      if (a === b) return true;
      const rootA = rootOf(a);
      return rootA !== undefined && rootA === rootOf(b);
    },

    scanOf(cliSessionId) {
      if (cliSessionId === undefined || cliSessionId === '') return undefined;
      if (scans.has(cliSessionId)) return scans.get(cliSessionId);

      const file = fileOf(cliSessionId);
      const scan = file === undefined ? undefined : scanConversation(file);
      scans.set(cliSessionId, scan);
      return scan;
    },
  };
}

export function lineage(env: NodeJS.ProcessEnv = process.env): Lineage {
  return lineageAt(installedRoots ?? transcriptRoots(env));
}
