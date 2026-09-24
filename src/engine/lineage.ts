import type { WorktreeReach } from '../domain/fostering.js';
import type { ReachCheck } from '../domain/filter.js';
import type { CodeSessionData } from '../domain/types.js';
import {
  conversationRoot,
  fileOpenedFrom,
  idsMentionedIn,
  indexAllTranscripts,
  scanConversation,
  scanConversationFiles,
  transcriptRoots,
  type ConversationScan,
  type RecordIdCache,
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
   * The records one card can open, which is not the whole conversation.
   *
   * `scanOf` answers what the work holds; this answers what a row reaches. They
   * differ exactly when a conversation occupies more than one file, because the
   * app opens the one under the project directory for that card's working
   * directory — so an account holding the shorter file holds a row that cannot
   * reach the rest, and a card offered from elsewhere may be the only way to
   * open it.
   *
   * Undefined when it cannot be told rather than guessed at: a conversation on
   * one file needs no such question, and a working directory naming no file of
   * this conversation says nothing about what the card reaches. Callers treat
   * that as "no answer", which leaves the behaviour they had before asking.
   */
  reachOf(cliSessionId: string | undefined, cwd: string | undefined): ConversationScan | undefined;
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
   *
   * Incremental across calls, and not just by skipping ids already seen: a
   * later round's new ids are searched against every transcript any earlier
   * round already knows the head of, not only against each other, and every
   * earlier round's heads are searched against the new ids' own transcripts
   * in turn. A single call already asks this of everything it is given —
   * `heads.size < 2` used to end it there — but the sweep's own rounds (see
   * `runSweep`) call this once per round with whatever the round just brought
   * back, and a round that hands back exactly one new id used to compare it
   * against nothing at all: a card the app creates between rounds never got
   * weighed against the conversations already indexed.
   *
   * "Searched against every transcript any earlier round already knows the
   * head of" reads a file, not a whole transcript, so it is bounded by a
   * cache rather than by round count: a file is read and pattern-matched at
   * most once for the life of this `Lineage`, whichever round is the first
   * to ask about it — see `idsMentionedIn`'s `RecordIdCache`. Without that, a
   * round bringing back a single new id would pay to re-read every file any
   * earlier round had already read, for that one id, which is most of the
   * cost the rounds exist to spread out in the first place.
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
  /** One file's records, memoised by path — several cards can open the same file. */
  const perFile = new Map<string, ConversationScan>();
  /** A root that turned out to be a record of another conversation, and whose. */
  const alias = new Map<string, string>();
  const deepened = new Set<string>();
  /** Every id `deepen` has already found a head for, kept across rounds. */
  const deepenedHeads = new Map<string, string>();
  /**
   * `idsMentionedIn`'s own memo of what each file's `matchAll` pass turned
   * up, kept for the run so a file `deepen` has already read once answers a
   * later round's different `wanted` from memory. Without this, every round
   * re-reads and re-scans every file any earlier round already knows the
   * head of (see the loop below) — see `RecordIdCache`'s own doc for the
   * cost that reintroduces.
   */
  const recordIdCache: RecordIdCache = new Map();

  const transcripts = (): Map<string, string[]> => {
    index ??= indexAllTranscripts(projectsDirs);
    return index;
  };

  /**
   * Every path this conversation occupies, because none of them is the whole of
   * it. `scanConversationFiles` has the measurement; the short version is that
   * one `cliSessionId` continued from two working directories leaves two files,
   * and taking the first the directory walk offered hid 6070 records on a real
   * store.
   */
  const filesOf = (cliSessionId: string | undefined): string[] => {
    if (cliSessionId === undefined || cliSessionId === '') return [];
    return transcripts().get(cliSessionId) ?? [];
  };

  const headOf = (cliSessionId: string): string | undefined => {
    // `has` rather than a truthy check: a conversation whose root could not be
    // read is remembered as unanswerable, so a failed read is not repeated for
    // every card that points at it.
    if (roots.has(cliSessionId)) return roots.get(cliSessionId);

    // Every file's own first record, not just one file's. Two transcripts of one
    // conversation disagree about their head whenever the second was started
    // from the middle, and a conversation that answered with the wrong one of
    // them was grouped away from its own siblings.
    const heads: string[] = [];
    for (const file of filesOf(cliSessionId)) {
      const head = conversationRoot(file);
      if (head !== undefined && !heads.includes(head)) heads.push(head);
    }

    const root = heads[0];
    // The rest are the same work by construction — one id, one conversation —
    // so they are filed as aliases of it and every id reaching any of them
    // canonicalises to the same answer, whichever file the walk offered first.
    if (root !== undefined) {
      for (const other of heads.slice(1)) {
        if (alias.has(other) || canonical(root) === other) continue;
        alias.set(other, root);
      }
    }

    roots.set(cliSessionId, root);
    return root;
  };

  /**
   * Follow the aliases to the root that stands for the whole work.
   *
   * Guarded against a cycle rather than assumed free of one: two transcripts
   * can each hold the other's first record, and a chain that returns to where
   * it started must stop somewhere rather than spin.
   *
   * `rootOf` calls this for every id asked about — a sweep on a real store
   * measured that at tens of thousands of calls in a single run — and almost
   * none of them are ever aliased at all (`deepen` only ever adds one for an
   * actual fork). The common case, no alias at `root`, returns before the
   * cycle-guard `Set` is ever allocated; the loop below runs unchanged for a
   * root that does have one.
   */
  const canonical = (root: string): string => {
    if (alias.get(root) === undefined) return root;
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

      const files = filesOf(cliSessionId);
      const scan = files.length === 0 ? undefined : scanConversationFiles(files);
      scans.set(cliSessionId, scan);
      return scan;
    },

    reachOf(cliSessionId, cwd) {
      const files = filesOf(cliSessionId);
      // One file is the whole conversation, and `scanOf` already answers for it.
      if (files.length < 2) return undefined;
      const file = fileOpenedFrom(files, cwd);
      if (file === undefined) return undefined;
      let scan = perFile.get(file);
      if (scan === undefined) {
        scan = scanConversation(file);
        perFile.set(file, scan);
      }
      return scan;
    },

    deepen(cliSessionIds) {
      const newHeads = new Map<string, string>();
      for (const id of cliSessionIds) {
        if (deepened.has(id)) continue;
        deepened.add(id);
        const head = headOf(id);
        if (head !== undefined) newHeads.set(id, head);
      }
      // Nothing new to search for. A lone new id is not skipped the way a
      // second call with the same id already is — see below.
      if (newHeads.size === 0) return;

      const apply = (host: string, found: string): void => {
        // Its own head is not evidence of anything, and a root already
        // spoken for keeps the first answer: the alias is a claim about one
        // record, and two hosts holding it say the same thing.
        if (found === host || alias.has(found)) return;
        // A root that is this conversation's own head would make the work
        // point at itself once canonicalised.
        if (canonical(host) === found) return;
        alias.set(found, host);
      };

      // A new head can be the record a much earlier round already read past —
      // an id this round never touches — so it is hunted for in every
      // transcript any round has read the head of, this one included, not
      // only in the handful `cliSessionIds` names this time. `recordIdCache`
      // is what keeps this from being a full re-read of every earlier
      // round's files: the first round to touch a file pays for the scan,
      // every later one asking it about a different `wantedNew` reuses it.
      const wantedNew = new Set(newHeads.values());
      for (const [id, host] of deepenedHeads) {
        for (const file of filesOf(id)) {
          for (const found of idsMentionedIn(file, wantedNew, recordIdCache)) apply(host, found);
        }
      }
      for (const [id, host] of newHeads) {
        for (const file of filesOf(id)) {
          for (const found of idsMentionedIn(file, wantedNew, recordIdCache)) apply(host, found);
        }
      }

      // The mirror: a head an earlier round already found can turn out to sit
      // inside a transcript this round just brought — a card the app created
      // since. Earlier transcripts were already asked about these heads when
      // the heads were found, so only the new ones need asking now.
      if (deepenedHeads.size > 0) {
        const wantedOld = new Set(deepenedHeads.values());
        for (const [id, host] of newHeads) {
          for (const file of filesOf(id)) {
            for (const found of idsMentionedIn(file, wantedOld, recordIdCache)) apply(host, found);
          }
        }
      }

      for (const [id, head] of newHeads) deepenedHeads.set(id, head);
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

/**
 * What `copyCwd`/`buildFosterCopy` need to choose between a card's own `cwd`
 * and its `originCwd` (#41) — read here, where a `Lineage` is available, and
 * handed to `domain/fostering.ts` as plain numbers so that module never has to
 * read a transcript itself.
 *
 * Given the destination (`here`), each directory is measured by what a copy
 * opening there would reach that no row in the destination already can, not
 * by how much its file holds. The two agree whenever the destination shows no
 * card for the conversation — nothing is held, so everything is beyond — and
 * disagree exactly when it matters: a destination holding the card that opens
 * the bigger file, while the smaller file is the one with the work nothing here
 * reaches. Measured on a real store, 15/09/2026: one conversation on two files,
 * 4872 records in the repository's and 4802 in the worktree's, the destination
 * already opening the repository's. Counting size sent the copy to the
 * repository, where `unreached` found nothing beyond, and the card was skipped
 * as already here — with 2116 records, a whole night's work, in the worktree's
 * file that no row could open.
 *
 * Undefined keeps its meaning from `Lineage.reachOf`: no file for that
 * directory, or one file for the whole conversation. Without `here`, the
 * counts are the files' sizes, as before.
 */
export function worktreeReachOf(
  kin: Lineage,
  data: CodeSessionData,
  here?: ReachCheck,
): WorktreeReach {
  const id = data.cliSessionId;
  const measure = (cwd: string | undefined): number | undefined => {
    const reach = kin.reachOf(id, cwd);
    if (reach === undefined) return undefined;
    // The card itself is left out of "held": a source card never sits in the
    // destination, and a copy already there must not count as reaching what
    // is only reached because it is there.
    return here === undefined ? reach.uuids.size : here.unreached(id, cwd, data.sessionId);
  };
  return { atCwd: measure(data.cwd), atOriginCwd: measure(data.originCwd) };
}
