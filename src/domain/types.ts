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
  title?: string;
  titleSource?: string;
  createdAt?: number;
  lastActivityAt?: number;
  /** Absent on sessions the user never opened; those do not show up under "Recents". */
  lastFocusedAt?: number;
  /** Present on sessions created by a scheduled task; those are listed elsewhere in the app. */
  scheduledTaskId?: string;
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
  'scheduled-task' | 'never-opened' | 'archived' | 'already-a-copy' | 'too-large';

export interface DiscoveredSession {
  /** Absolute path of the session JSON. */
  path: string;
  /** The account directory it was found in — the only thing binding it to an account. */
  account: AccountRef;
  data: CodeSessionData;
  /**
   * A copy previously written by foster, rather than a session the app itself created.
   * Detected via the _foster marker, so a rescan never mistakes copies for new discoveries.
   */
  isCopy: boolean;
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
}
