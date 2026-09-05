import {
  conversationRoot,
  idsMentionedIn,
  indexAllTranscripts,
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
  /**
   * Resolve roots that only look unrelated, for these conversations.
   *
   * `conversationRoot` reads the first record a transcript holds, which is the
   * shared ancestor only when the app copied the conversation from its
   * beginning. Fork it from a point in the middle instead and the copy opens on
   * a record from the middle — rewritten with no parent, so nothing in the head
   * says where it came from — and the two halves answer with different roots
   * while holding thousands of records in common. Measured on a real store: two
   * halves of one conversation sharing 2097 records, the second's root sitting
   * at position 16818 of the first.
   *
   * The evidence is that record itself. A root found *inside* another
   * conversation is that conversation's own history, so the branch it heads
   * belongs to the same work, and its root is filed as an alias of the host's.
   *
   * Called by whoever is about to group conversations, never on the way in: it
   * reads every transcript named here, which is seconds rather than
   * milliseconds. Idempotent, and remembers what it has already been given.
   */
  deepen(cliSessionIds: Iterable<string>): void;
  /**
   * Every transcript on disk, every path it occupies, keyed by conversation.
   *
   * The same directory walk the other answers are built on, exposed so a caller
   * that also needs the whole index — the orphan search, which asks which
   * transcripts nothing points at — walks the tree once with this rather than
   * once more on its own. A sweep used to do that walk six times over.
   */
  transcripts(): ReadonlyMap<string, string[]>;
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
  let index: Map<string, string[]> | undefined;
  const roots = new Map<string, string | undefined>();
  const scans = new Map<string, ConversationScan | undefined>();
  /** A root that turned out to be a record of another conversation, and whose. */
  const alias = new Map<string, string>();
  const deepened = new Set<string>();

  const transcripts = (): Map<string, string[]> => {
    index ??= indexAllTranscripts(projectsDirs);
    return index;
  };

  // First path wins: the same conversation can be mirrored under a second
  // project directory, and either copy opens the same session.
  const fileOf = (cliSessionId: string | undefined): string | undefined => {
    if (cliSessionId === undefined || cliSessionId === '') return undefined;
    return transcripts().get(cliSessionId)?.[0];
  };

  const headOf = (cliSessionId: string): string | undefined => {
    // `has` rather than a truthy check: a conversation whose root could not be
    // read is remembered as unanswerable, so a failed read is not repeated for
    // every card that points at it.
    if (roots.has(cliSessionId)) return roots.get(cliSessionId);

    const file = fileOf(cliSessionId);
    const root = file ? conversationRoot(file) : undefined;
    roots.set(cliSessionId, root);
    return root;
  };

  /**
   * Follow the aliases to the root that stands for the whole work.
   *
   * Guarded against a cycle rather than assumed free of one: two transcripts
   * can each hold the other's first record, and a chain that returns to where
   * it started must stop somewhere rather than spin.
   */
  const canonical = (root: string): string => {
    let at = root;
    const seen = new Set<string>([at]);
    for (;;) {
      const next = alias.get(at);
      if (next === undefined || seen.has(next)) return at;
      seen.add(next);
      at = next;
    }
  };

  const rootOf = (cliSessionId: string | undefined): string | undefined => {
    if (cliSessionId === undefined || cliSessionId === '') return undefined;
    const head = headOf(cliSessionId);
    return head === undefined ? undefined : canonical(head);
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

    deepen(cliSessionIds) {
      const heads = new Map<string, string>();
      for (const id of cliSessionIds) {
        if (deepened.has(id)) continue;
        deepened.add(id);
        const head = headOf(id);
        if (head !== undefined) heads.set(id, head);
      }
      // One conversation cannot be a fork of itself, and one root cannot be
      // found inside another transcript that does not exist yet to be read.
      if (heads.size < 2) return;

      const wanted = new Set(heads.values());
      for (const [id, head] of heads) {
        const file = fileOf(id);
        if (file === undefined) continue;
        for (const found of idsMentionedIn(file, wanted)) {
          // Its own head is not evidence of anything, and a root already spoken
          // for keeps the first answer: the alias is a claim about one record,
          // and two hosts holding it say the same thing.
          if (found === head || alias.has(found)) continue;
          // A root that is this conversation's own head would make the work
          // point at itself once canonicalised.
          if (canonical(head) === found) continue;
          alias.set(found, head);
        }
      }
    },

    transcripts,
  };
}

/**
 * The lineage of everything this machine's Claude directories hold.
 *
 * `extra` is the caller's further config directories — the same list the
 * orphan search takes — so a sweep asked to look in one more place reads its
 * transcripts through the one index too.
 */
export function lineage(env: NodeJS.ProcessEnv = process.env, extra: string[] = []): Lineage {
  return lineageAt(installedRoots ?? transcriptRoots(env, extra));
}
