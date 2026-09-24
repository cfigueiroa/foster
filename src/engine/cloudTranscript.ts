import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.js';
import type { TeleportEvent } from './cloudApi.js';

/**
 * Cloud session teleport events -> a local Claude transcript — the write half
 * of `foster cloud pull`.
 *
 * Unlike a Codex rollout (`codexTranscript.ts`, which builds Claude records
 * from scratch out of an unrelated format), a teleport event's `payload` is
 * already shaped like a Claude transcript record — `uuid`, `parentUuid`,
 * `sessionId`, `timestamp`, `type`, `isSidechain`, and per-type fields such as
 * `message` — because the cloud session *is* a Claude Code CLI conversation,
 * teleported off whatever machine it last ran on. Measured against a real
 * session's 62 events (2026-09-24, one signed-in account): every payload
 * carried `isSidechain`, `parentUuid`, `sessionId`, `timestamp`, `type` and
 * `uuid`; none carried `cwd`, `userType` or `version`, three fields a local
 * transcript record does carry (compared against this machine's own
 * `~/.claude/projects` files). So the conversion is mostly pass-through, with
 * three things done to it:
 *
 *  1. **Drop sidechains** (`payload.isSidechain === true`) — a teleported
 *     resume drops them too (task note, matching the CLI's own filter), and
 *     nothing here tries to repair a `parentUuid` that pointed at one; a
 *     dangling parent is exactly what the real CLI would also produce, since
 *     sidechains are leaves, not links in the mainline chain.
 *  2. **Mint a fresh uuid for the session and rewrite `sessionId`/`cwd`
 *     everywhere.** A cloud session's own id (`cse_…`/`session_…`) is not
 *     shaped like the uuid a local transcript's `sessionId` — and therefore
 *     its filename — is expected to be, and its `cwd` names a path on a
 *     container this machine does not have. `uuid`/`parentUuid` are left
 *     alone: they are the chain the app plays the conversation back in, and
 *     rewriting them would risk breaking links this conversion has no reason
 *     to touch.
 *  3. **Append the same "continued from another machine" notice the real CLI
 *     adds on a teleport resume** — read verbatim out of the installed CLI's
 *     bundle (`k$o` in the 2.1.278 build): a `user` message, `isMeta: true`,
 *     naming the new working directory. Without it the transcript just stops;
 *     with it, opening the card in Claude Desktop shows the same thing the
 *     CLI's own `--teleport` would.
 *
 * What this cannot promise: fidelity beyond what was measured on one session.
 * `event_type` values other than `user`/`assistant`/`attachment`/`system`
 * (the four seen) are passed through unexamined — this only ever reads
 * `payload.isSidechain`, never branches on `event_type` itself, so an unseen
 * type carries through exactly like the four that were measured.
 */

/** A transcript record, held generically: a teleport payload's own fields plus the ones this rewrites onto it. */
export type CloudTranscriptRecord = Record<string, unknown>;

export interface CloudConvertOptions {
  /** The transcript's new conversation id — minted here, not the cloud session's own id. */
  sessionId: string;
  /** Where the conversation resumes, written onto every record. */
  cwd: string;
  gitBranch?: string;
  now?: number;
}

export interface CloudConvertResult {
  records: CloudTranscriptRecord[];
  stats: {
    /** Events read from the API, sidechains included. */
    total: number;
    /** Dropped for `isSidechain: true`. */
    sidechainsDropped: number;
    /** What made it into the transcript, the continuation notice included. */
    kept: number;
  };
}

/** The exact text the CLI's own `k$o()` opens a teleported resume with, read out of the 2.1.278 bundle. */
export function continuationNotice(cwd: string): string {
  return (
    'This session is being continued from another machine. Application state may have ' +
    `changed. The updated working directory is ${cwd}`
  );
}

/**
 * Convert one cloud session's teleport events into transcript records ready to
 * serialise. Order is preserved as the API returned it — assumed to already be
 * the conversation's own order, since `parentUuid` is kept exactly as received
 * rather than rebuilt from this function's own traversal.
 */
export function teleportEventsToTranscript(
  events: readonly TeleportEvent[],
  options: CloudConvertOptions,
): CloudConvertResult {
  const now = options.now ?? Date.now();
  const records: CloudTranscriptRecord[] = [];
  let sidechainsDropped = 0;
  let lastUuid: string | null = null;

  for (const event of events) {
    const payload = event.payload;
    if (payload.isSidechain === true) {
      sidechainsDropped++;
      continue;
    }

    const record: CloudTranscriptRecord = {
      ...payload,
      sessionId: options.sessionId,
      cwd: options.cwd,
      userType: payload.userType ?? 'external',
      version: payload.version ?? VERSION,
      ...(options.gitBranch !== undefined && payload.gitBranch === undefined
        ? { gitBranch: options.gitBranch }
        : {}),
    };
    records.push(record);

    const uuid = record.uuid;
    if (typeof uuid === 'string') lastUuid = uuid;
  }

  const noticeUuid = randomUUID();
  records.push({
    parentUuid: lastUuid,
    isSidechain: false,
    userType: 'external',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: VERSION,
    ...(options.gitBranch !== undefined ? { gitBranch: options.gitBranch } : {}),
    type: 'user',
    message: { role: 'user', content: continuationNotice(options.cwd) },
    isMeta: true,
    uuid: noticeUuid,
    timestamp: new Date(now).toISOString(),
  });

  return {
    records,
    stats: { total: events.length, sidechainsDropped, kept: records.length },
  };
}

/** Serialise records to the newline-delimited JSON a `.jsonl` transcript holds — same shape `codexTranscript.ts` writes. */
export function serialiseCloudTranscript(records: readonly CloudTranscriptRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
