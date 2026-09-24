import { bareSessionId } from '../domain/naming.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import { scanStore } from '../store/scanner.js';
import { indexAllTranscripts, transcriptRoots } from '../store/transcripts.js';

/**
 * Turns an id or a title fragment into the one conversation it names.
 *
 * No `foster where` exists yet on `main` to share this with, so it lives here
 * on its own — the resolver `foster export` needs, and the shape a future
 * `where` would want too: given an argument that might be a `cliSessionId`, a
 * card's own `local_<uuid>` `sessionId`, or a piece of a title, say which
 * conversation it is, or refuse by naming every candidate rather than
 * guessing at one.
 */

export interface ResolvedConversation {
  cliSessionId: string;
  /** Every transcript path this conversation occupies — see `scanConversationFiles`. */
  files: string[];
  /** Every card, in every account this store holds, that opens it. Possibly none. */
  cards: DiscoveredSession[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function definedCliSessionIds(sessions: readonly DiscoveredSession[]): string[] {
  return unique(
    sessions
      .map((session) => session.data.cliSessionId)
      .filter((id): id is string => id !== undefined && id !== ''),
  );
}

function ambiguousError(input: string, kind: string, ids: readonly string[]): Error {
  return new Error(
    `"${input}" is ambiguous: it matches ${ids.length} ${kind}.\n` +
      ids.map((id) => `  ${id}`).join('\n'),
  );
}

/**
 * Resolves `input` against every transcript this machine's clients hold and
 * every card the Desktop store named by `store` shows, across the accounts
 * given (every account, when `accounts` is left out).
 *
 * Tried in order, refusing rather than guessing whenever more than one
 * candidate survives a step:
 *
 * 1. A transcript id — `cliSessionId` — exact or an unambiguous prefix. Tried
 *    even against a conversation with no card left anywhere, because a
 *    deleted conversation naming its own id is `export`'s most ordinary case.
 * 2. A card's own `sessionId`, the app's `local_<uuid>` — exact or an
 *    unambiguous prefix, the app's own prefix accepted or not (`bareSessionId`).
 * 3. A case-insensitive substring of a card's title.
 *
 * A step that matches nothing falls through to the next; a step matching more
 * than one conversation stops there rather than trying the next, naked
 * ambiguity being a clearer refusal than a coincidental single hit further
 * down would be a good answer.
 */
export function resolveConversation(
  input: string,
  store: StoreLayout,
  accounts?: readonly AccountRef[],
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Test seam: the transcript directories to search, in place of
   * `transcriptRoots(env)` — see the same parameter on `GrepOptions` in
   * `engine/grep.ts` for why. Production never sets this.
   */
  projectsDirs?: string[],
): ResolvedConversation {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Nothing to resolve: give an id or a title fragment.');

  const index = indexAllTranscripts(projectsDirs ?? transcriptRoots(env));
  const wanted = accounts === undefined ? undefined : new Set(accounts.map(directoryOf));
  const cards = scanStore(store).filter(
    (session) => wanted === undefined || wanted.has(directoryOf(session.account)),
  );

  const build = (cliSessionId: string): ResolvedConversation => ({
    cliSessionId,
    files: index.get(cliSessionId) ?? [],
    cards: cards.filter((session) => session.data.cliSessionId === cliSessionId),
  });

  const needle = bareSessionId(trimmed).toLowerCase();

  const idMatches = [...index.keys()].filter((id) => id.toLowerCase().startsWith(needle));
  if (idMatches.length === 1) return build(idMatches[0]!);
  if (idMatches.length > 1) throw ambiguousError(trimmed, 'conversation ids', idMatches);

  const bySessionId = cards.filter((session) =>
    bareSessionId(session.data.sessionId).toLowerCase().startsWith(needle),
  );
  const idsBySessionId = definedCliSessionIds(bySessionId);
  if (idsBySessionId.length === 1) return build(idsBySessionId[0]!);
  if (idsBySessionId.length > 1) throw ambiguousError(trimmed, 'cards', idsBySessionId);

  const byTitle = cards.filter((session) =>
    (session.data.title ?? '').toLowerCase().includes(trimmed.toLowerCase()),
  );
  const idsByTitle = definedCliSessionIds(byTitle);
  if (idsByTitle.length === 1) return build(idsByTitle[0]!);
  if (idsByTitle.length > 1) {
    throw new Error(
      `"${trimmed}" matches ${idsByTitle.length} conversations by title:\n` +
        idsByTitle
          .map((id) => byTitle.find((session) => session.data.cliSessionId === id)!)
          .map((session) => `  ${session.data.cliSessionId} — ${session.data.title ?? ''}`)
          .join('\n'),
    );
  }

  throw new Error(
    `No conversation found for "${trimmed}". Tried it as a conversation id, a card id and a title.`,
  );
}

function directoryOf(account: AccountRef): string {
  return `${account.accountUuid}/${account.organizationUuid}`;
}
