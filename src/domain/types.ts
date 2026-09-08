/** Identifies the account/organization pair that owns a directory of sessions. */
export interface AccountRef {
  accountUuid: string;
  organizationUuid: string;
}

/**
 * The marker foster writes into a copy so the file describes its own origin.
 * Claude Desktop tolerates unknown keys in session JSON (verified empirically),
 * so this survives alongside the fields the app cares about.
 */
export interface FosterMark {
  originAccountUuid: string;
  originOrganizationUuid: string;
  originSessionId: string;
  /** Present only for a copy taken from a different installation or profile. */
  originStore?: string;
  fosteredAt: number;
  toolVersion: string;
}

/**
 * The fields of a Code session file that foster reasons about. The real file
 * carries more keys; they are preserved verbatim when copying.
 */
export interface CodeSessionData {
  sessionId: string;
  /** Points at the transcript under ~/.claude/projects — account-agnostic, shared with the original. */
  cliSessionId?: string;
  cwd?: string;
  originCwd?: string;
  /**
   * The worktree this card holds. The claim is here; the lease is in the app's
   * own store, keyed by session id — which is why a copy must not carry either
   * across. See `buildFosterCopy`.
   */
  worktreePath?: string;
  worktreeName?: string;
  /** A worktree the app has promised the session but not yet cut. Same reasoning. */
  worktreeLazy?: unknown;
  title?: string;
  titleSource?: string;
  /**
   * The names this card used to wear, newest first — the app appends to it
   * whenever it writes a new title. There is no timestamp on any of them, so
   * this cannot date a rename; what it can do is order two of them. A card
   * whose history already holds the name the other side is wearing has been
   * through that name and moved on. See `titleSync.ts`.
   */
  previousTitles?: string[];
  createdAt?: number;
  lastActivityAt?: number;
  /** Absent on sessions the user never opened; those do not show up under "Recents". */
  lastFocusedAt?: number;
  /**
   * The remote-control mirrors this card has had, one appended per attach; the
   * newest is the one the sidebar shows. When the process behind it dies
   * without closing, the card can only say "cannot reach your computer" —
   * which is what `foster rescue` reads this field to find.
   */
  bridgeSessionIds?: string[];
  /** Present on sessions created by a scheduled task; those are listed elsewhere in the app. */
  scheduledTaskId?: string;
  /**
   * Present on sessions the app spawned from a background-task chip, naming the
   * session that spawned it.
   *
   * The same shape of thing as `scheduledTaskId`: the conversation ran on its
   * own, unattended, so it never got a focus time and never reached Recents.
   * What it did is an ordinary transcript, and can be substantial — this was
   * found on a session carrying 562 turns of work that had no card anywhere.
   * Also what `foster unstarted` reads to tell a request that was made of the
   * app from a conversation a person opened themselves.
   */
  spawnedFrom?: { sessionId?: string; taskId?: string; title?: string };
  /**
   * Turns that finished. Zero alongside an `error` is a request that died before
   * answering once, which leaves nothing to resume and only a prompt to recover.
   */
  completedTurns?: number;
  isArchived?: boolean;
  model?: string;
  /** A stale failure from the origin account; rendered as a warning badge. Stripped when fostering. */
  error?: string;
  errorAt?: number;
  _foster?: FosterMark;
  [key: string]: unknown;
}

/**
 * Why a session on disk is not offered for fostering.
 *
 * `too-large` is the app's own limit, not foster's: it skips any session file
 * over 10 MB while loading, so a copy of one would be written and never listed.
 */
export type Unfosterable =
  'scheduled-task' | 'spawned-task' | 'never-opened' | 'archived' | 'already-a-copy' | 'too-large';

export interface DiscoveredSession {
  /** Absolute path of the session JSON. */
  path: string;
  /** The account directory it was found in — the only thing binding it to an account. */
  account: AccountRef;
  data: CodeSessionData;
  /**
   * Bytes of transcript behind a session that has no card of its own to show it.
   *
   * Only ever filled in for sessions held back by `never-opened`, and only by
   * the surfaces that report them, because answering it means indexing the
   * transcript directories. `undefined` means "not measured", `0` means the
   * conversation is not on disk at all — a distinction worth keeping, since the
   * whole point is telling an abandoned record apart from real work.
   */
  transcriptBytes?: number;
  /**
   * A copy previously written by foster, rather than a session the app itself created.
   * Detected via the _foster marker, so a rescan never mistakes copies for new discoveries.
   */
  isCopy: boolean;
  /**
   * A copy that is the only card its conversation has left.
   *
   * Copies are normally not sources: fostering one would make a second copy of a
   * conversation whose original is right there, which is a duplicate with a
   * longer provenance chain. But the original can stop existing — deleted in the
   * app, or never there at all because the copy came from `restore` — and then
   * that rule strands the conversation. It sits in one account, perfectly
   * readable, and no sweep will ever offer it again.
   *
   * So the rule is about the conversation, not the file: a copy is refused while
   * its conversation still has a card of its own somewhere, and is a legitimate
   * source once it does not. Only a whole-store scan can answer that, which is
   * why `scanAccount` always reports false and `scanStore` decides.
   */
  isStranded: boolean;
  /** Empty when the session can be fostered normally. */
  reasons: Unfosterable[];
}

export interface StoreLayout {
  /** Claude Desktop's userData directory. */
  root: string;
  codeSessionsDir: string;
  /** Present in the store but not fosterable — Cowork sandboxes are listed from the server. */
  agentSessionsDir: string;
  configFile: string;
  /**
   * The app's own settings file, `claude_desktop_config.json` — where the MCP
   * server list lives, and where the app keeps the preferences its UI writes,
   * under a top-level `preferences` object. A different file from `configFile`,
   * which holds the account cache and the OAuth token (#92).
   */
  desktopConfigFile: string;
}
