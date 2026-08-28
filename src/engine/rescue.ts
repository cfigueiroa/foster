import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { CodeSessionData, DiscoveredSession } from '../domain/types.js';
import { liveConversationIds } from '../ops/foster.js';
import { indexTranscripts, lastRecordedCwd, transcriptRoots } from '../store/transcripts.js';

/**
 * Conversations stranded by a crash, and the resume that brings each one back.
 *
 * A session card with a remote-control mirror is a live link: the app shows the
 * conversation through the process hosting it. When that process dies without
 * closing — a crash, a reboot, a kill — the server keeps the mirror, the card
 * can only say "cannot reach your computer", and nothing client-side reattaches
 * the old mirror id. Verified against a live store after a crash: the device
 * key, bridge URL and authentication all survive unchanged, and the card stays
 * unreachable regardless — the link is per-session, not per-device.
 *
 * What works is resuming the conversation. The transcript on disk is complete,
 * `claude --resume` picks it up, and the first turn mints a fresh mirror; the
 * old card never reconnects and can be archived. The same goes for the empty
 * mirror cards named after the device ("no messages yet"): they are the other
 * side of the same husk, hold nothing, and are archived rather than rescued.
 */

/** A conversation whose card can only say "cannot reach your computer". */
export interface StrandedConversation {
  cliSessionId: string;
  title?: string;
  /**
   * Where the resume must run — the transcript's last word on it, not the
   * card's. The card keeps the directory the session started in, and a session
   * that moved between worktrees is filed under the one it moved to; a resume
   * in the stale directory would not find it.
   */
  cwd?: string;
  /**
   * Whether that directory still exists. Worktrees are routinely removed once
   * their session is archived, and a resume pointed into a deleted directory
   * fails at the terminal — better named here than discovered there.
   */
  cwdExists?: boolean;
  /** Absent when the transcript is gone, which is the one unrescuable case. */
  transcriptPath?: string;
  sizeBytes?: number;
  lastActivityAt?: number;
  isArchived: boolean;
}

export interface RescueSelection {
  /** Only conversations active at or after this instant. */
  since?: number;
  /** Archived sessions were closed on purpose; reviving one is opt-in. */
  includeArchived: boolean;
}

/** The seams tests replace: what is live, and what the transcripts say. */
export interface RescueDeps {
  transcriptFor(cliSessionId: string): string | undefined;
  lastCwd(file: string): string | undefined;
  /** Lowercased conversation ids that have a live writer right now. */
  liveIds: ReadonlySet<string>;
  sizeOf(file: string): number | undefined;
  directoryExists(dir: string): boolean;
}

export function defaultRescueDeps(env: NodeJS.ProcessEnv = process.env): RescueDeps {
  const index = indexTranscripts(transcriptRoots(env));
  return {
    transcriptFor: (id) => index.get(id),
    lastCwd: lastRecordedCwd,
    liveIds: liveConversationIds(env),
    sizeOf: (file) => {
      try {
        return statSync(file).size;
      } catch {
        return undefined;
      }
    },
    directoryExists: existsSync,
  };
}

export function findStranded(
  sessions: DiscoveredSession[],
  selection: RescueSelection,
  deps: RescueDeps,
): StrandedConversation[] {
  // One row per conversation, keeping the most recently active card. Copies
  // count: in an account consolidated by `sweep`, the sidebar card for a
  // conversation IS the copy — its original sits in another account's
  // directory, outside this scan — and skipping copies would hide exactly the
  // cards someone is looking at. The map is what keeps the same conversation
  // from being offered twice when both cards are present.
  const byConversation = new Map<string, DiscoveredSession>();
  // A rescue leaves a second card behind: hosting the conversation again — a
  // resume, or the app delivering a message to it — makes the app write a fresh
  // card with no mirror history, while the husk keeps its dead mirror forever.
  // Once the fresh card's host goes idle and exits, nothing is live and the
  // husk alone would put the conversation right back on this list — already
  // rescued, stranded again every morning. The fresh card is the tell: newer
  // than the husk and pointing at a directory that exists, it is the app's own
  // proof that it can reach the conversation without our help.
  const rehostActivity = new Map<string, number>();
  for (const session of sessions) {
    const { data } = session;
    const conversation = data.cliSessionId?.toLowerCase();
    if (!conversation) continue;
    if (!hadMirror(data)) {
      if (data.isArchived !== true && data.cwd && deps.directoryExists(data.cwd)) {
        const seen = rehostActivity.get(conversation) ?? -Infinity;
        rehostActivity.set(conversation, Math.max(seen, data.lastActivityAt ?? 0));
      }
      continue;
    }
    if (!selection.includeArchived && data.isArchived === true) continue;
    if (selection.since !== undefined && (data.lastActivityAt ?? 0) < selection.since) continue;
    // A live writer is the opposite of stranded: the mirror it minted works.
    if (deps.liveIds.has(conversation)) continue;

    const kept = byConversation.get(conversation);
    if (!kept || (kept.data.lastActivityAt ?? 0) < (data.lastActivityAt ?? 0)) {
      byConversation.set(conversation, session);
    }
  }

  const out: StrandedConversation[] = [];
  for (const session of byConversation.values()) {
    const { data } = session;
    const cliSessionId = data.cliSessionId!;
    const rehostedAt = rehostActivity.get(cliSessionId.toLowerCase());
    if (rehostedAt !== undefined && rehostedAt >= (data.lastActivityAt ?? 0)) continue;
    const transcript = deps.transcriptFor(cliSessionId);
    const cwd = transcript ? deps.lastCwd(transcript) : undefined;
    const sizeBytes = transcript ? deps.sizeOf(transcript) : undefined;
    out.push({
      cliSessionId,
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(cwd !== undefined ? { cwd, cwdExists: deps.directoryExists(cwd) } : {}),
      ...(transcript !== undefined ? { transcriptPath: transcript } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(data.lastActivityAt !== undefined ? { lastActivityAt: data.lastActivityAt } : {}),
      isArchived: data.isArchived === true,
    });
  }

  return out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/**
 * Whether this card ever had a remote-control mirror.
 *
 * One id per attach, appended by the app; the newest is the one the sidebar
 * shows. Read defensively — the field is the app's, not foster's, and a card
 * predating remote control simply does not carry it.
 */
function hadMirror(data: CodeSessionData): boolean {
  const ids = data.bridgeSessionIds;
  return Array.isArray(ids) && ids.some((id) => typeof id === 'string' && id !== '');
}

export function resumeCommandFor(row: StrandedConversation): string {
  return `claude --resume ${row.cliSessionId}`;
}

export type OpenOutcome = 'opened' | 'no-transcript' | 'no-cwd' | 'cwd-gone' | 'failed';

export type TabOpener = (row: StrandedConversation) => void;

/**
 * One Windows Terminal tab per conversation, resume already typed.
 *
 * Each tab runs `claude --resume` in the conversation's own directory and stops
 * at the CLI's resume prompt, so nothing is consumed until a human picks
 * summary or full there. A deleted directory is refused rather than attempted:
 * `wt` fails to start in one, and the error lands in a flash of a closing tab
 * where nobody can read it.
 */
export function openResumeTabs(
  rows: StrandedConversation[],
  open: TabOpener = openWindowsTerminalTab,
): { row: StrandedConversation; outcome: OpenOutcome }[] {
  return rows.map((row) => {
    if (!row.transcriptPath) return { row, outcome: 'no-transcript' as const };
    if (!row.cwd) return { row, outcome: 'no-cwd' as const };
    if (row.cwdExists === false) return { row, outcome: 'cwd-gone' as const };
    try {
      open(row);
      return { row, outcome: 'opened' as const };
    } catch {
      return { row, outcome: 'failed' as const };
    }
  });
}

function openWindowsTerminalTab(row: StrandedConversation): void {
  // The id ends up inside a `pwsh -Command` line, so only the CLI's own id
  // shape may pass — a card file is data from disk, not something to trust
  // into a shell. Same shape `foster resume` validates against.
  if (!/^[0-9a-f][0-9a-f-]{7,63}$/i.test(row.cliSessionId)) {
    throw new Error('the conversation id does not look like one');
  }
  // Hyphenated title on purpose: `wt` splits its command line on spaces, and a
  // spaced title swallows half of itself as a command. Measured, not imagined.
  const result = spawnSync(
    'wt',
    [
      '-w',
      'rescue',
      'new-tab',
      '--title',
      tabTitle(row),
      '-d',
      row.cwd!,
      'pwsh',
      '-NoLogo',
      '-NoExit',
      '-Command',
      resumeCommandFor(row),
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wt exited with ${result.status}`);
}

function tabTitle(row: StrandedConversation): string {
  const base = (row.title ?? row.cliSessionId).trim().replace(/\s+/g, '-');
  return base.length > 40 ? base.slice(0, 40) : base;
}
