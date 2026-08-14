import { statSync } from 'node:fs';
import path from 'node:path';
import { isDirectory } from '../util/fs.js';
import { conversationRoot, indexTranscripts, transcriptRoots } from '../store/transcripts.js';

/**
 * Which conversations are the same work, when their identifiers disagree.
 *
 * `continued.ts` explains the branch: a conversation with a live writer cannot be
 * continued from a second card, so the app copies its history into a new
 * transcript with a new id and moves the card onto that. Everything downstream of
 * a branch reads as two unrelated conversations — different `cliSessionId`,
 * different files — while being one piece of work that happened to fork.
 *
 * That is how a sidebar ends up with two identical rows even though fostering
 * already refuses to add a conversation the account has: the second row is a
 * branch, its id has never been seen here, and the check that would have caught
 * it compares the one field a branch changes.
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
   * When the conversation was last written, from the transcript's `mtime` — the
   * question "which of these two branches kept going?" in the form a `stat`
   * answers. Undefined when there is no transcript to ask.
   */
  lastWriteOf(cliSessionId: string | undefined): number | undefined;
}

export function lineage(env: NodeJS.ProcessEnv = process.env): Lineage {
  let transcripts: Map<string, string> | undefined;
  const roots = new Map<string, string | undefined>();

  const fileOf = (cliSessionId: string | undefined): string | undefined => {
    if (cliSessionId === undefined || cliSessionId === '') return undefined;
    transcripts ??= indexTranscripts(rootsOf(env));
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
    lastWriteOf(cliSessionId) {
      const file = fileOf(cliSessionId);
      if (file === undefined) return undefined;
      try {
        return statSync(file).mtimeMs;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * A root as a map key that cannot collide with a `cliSessionId`.
 *
 * Both are uuids and both are keyed in one map, so the namespaces are kept apart
 * by construction rather than by hoping a conversation never shares an id with
 * some other conversation's first record.
 */
export function rootKey(root: string | undefined): string | undefined {
  return root === undefined ? undefined : `root:${root}`;
}

/**
 * Where the transcripts are, without walking a real Claude install from a test.
 *
 * A test that hands us a `CLAUDE_CONFIG_DIR` of its own is pointing at a tree;
 * look only there. A test that did not is not asking about branches, and the
 * vitest config forbids touching the real home. Production has no `VITEST` and
 * still sees every account's `projects/`.
 */
function rootsOf(env: NodeJS.ProcessEnv): string[] {
  if (process.env.VITEST && env === process.env) return [];
  if (env !== process.env && env.CLAUDE_CONFIG_DIR) {
    const dir = path.join(env.CLAUDE_CONFIG_DIR, 'projects');
    return isDirectory(dir) ? [dir] : [];
  }
  return transcriptRoots(env);
}
