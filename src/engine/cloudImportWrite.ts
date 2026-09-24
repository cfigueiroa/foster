import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bareSessionId } from '../domain/naming.js';
import { accountDir, sessionPath } from '../domain/paths.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { LedgerState } from '../ledger/project.js';
import { claudeProjectsDir, projectDirName } from '../store/transcripts.js';
import { writeFileAtomic } from '../util/fsatomic.js';
import { VERSION } from '../version.js';
import type { CloudRepoHint, CloudSessionDetail, TeleportEvent } from './cloudApi.js';
import { serialiseCloudTranscript, teleportEventsToTranscript } from './cloudTranscript.js';

/**
 * The write half of `foster cloud pull`.
 *
 * Mirrors `codexImportWrite.ts` deliberately — a fabricated transcript under
 * `~/.claude/projects` plus a sidebar card beside it, guarded by the same
 * `_fosterImport` marker and backed by the same `conversation_imported` ledger
 * event, `source: 'cloud'` this time — but the network call is not in here.
 * The caller (`foster cloud pull` in `src/cli/index.ts`) fetches the session
 * detail and its teleport events first and hands them in already read, so this
 * module — like `codexImportWrite.ts`'s own write half — stays pure enough to
 * test against fixtures with no network in the loop.
 *
 * Files first, ledger only after they land — same order, same reasoning: a
 * card the ledger vouches for but that never reached disk would make every
 * later run skip it, and the reverse self-heals because the card carries its
 * own `_fosterImport` and a re-run finds the pair and completes it.
 */

/** The app refuses a transcript larger than this, so foster does not write one. Same limit as `codexImportWrite.ts`. */
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

export type CloudPullStatus = 'imported' | 'skipped' | 'failed';

export interface CloudPullOutcome {
  cloudSessionId: string;
  title?: string;
  status: CloudPullStatus;
  reason?: string;
  cardPath?: string;
  transcriptPath?: string;
  records?: number;
  bytes?: number;
  sidechainsDropped?: number;
  repo?: CloudRepoHint;
}

export interface CloudPullOptions {
  store: StoreLayout;
  ledger: Ledger;
  /** The folded ledger, for the "already imported" check. */
  state: LedgerState;
  target: AccountRef;
  /** Where the resumed conversation opens — resolved to an absolute path by the caller. */
  cwd: string;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

function hashEvents(events: readonly TeleportEvent[]): string {
  // Hashed as fetched, not as converted: a session whose *history* has not
  // changed should hash the same even if a future version of this converter
  // rewrites records differently, and there is no local source file the way a
  // Codex rollout has one to hash instead.
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

/**
 * Bring one already-fetched cloud session in as a local Claude conversation.
 *
 * `id` is the cloud session's own id (`cse_…`/`session_…`) — the ledger's fold
 * key, and what `--undo` matches against. The transcript's own `sessionId`
 * (and therefore its filename) is a freshly minted uuid instead: see
 * `cloudTranscript.ts` for why the two must differ.
 */
export function pullCloudSession(
  id: string,
  detail: CloudSessionDetail,
  events: readonly TeleportEvent[],
  options: CloudPullOptions,
): CloudPullOutcome {
  const { store, ledger, state, target, dryRun } = options;
  const env = options.env ?? process.env;
  const outcome: CloudPullOutcome = { cloudSessionId: id, title: detail.title, status: 'skipped' };

  try {
    const cwd = options.cwd;
    const hash = hashEvents(events);
    const already = state.imported.get(id);
    if (already) {
      if (
        already.contentHash === hash &&
        existsSync(already.cardPath) &&
        existsSync(already.transcriptPath)
      ) {
        return { ...outcome, status: 'skipped', reason: 'already pulled' };
      }
    }

    // A changed re-pull reuses the uuid minted the first time, the same way a
    // changed Codex rollout overwrites `codexImportWrite.ts`'s existing pair
    // rather than growing a second one: without this, every re-pull of a
    // session whose history moved on would orphan the previous transcript and
    // card, since `mintedSessionId` — unlike a Codex rollout's own id — is not
    // otherwise derived from anything stable across runs.
    const mintedSessionId = already ? bareSessionId(already.sessionId) : randomUUID();
    const converted = teleportEventsToTranscript(events, {
      sessionId: mintedSessionId,
      cwd,
      ...(detail.repo.branch !== undefined ? { gitBranch: detail.repo.branch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    outcome.records = converted.records.length;
    outcome.sidechainsDropped = converted.stats.sidechainsDropped;
    outcome.repo = detail.repo;

    const serialised = serialiseCloudTranscript(converted.records);
    const bytes = Buffer.byteLength(serialised, 'utf8');
    outcome.bytes = bytes;
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      return {
        ...outcome,
        reason: `transcript is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB the app loads`,
      };
    }

    const transcriptPath = path.join(
      claudeProjectsDir(env),
      projectDirName(cwd),
      `${mintedSessionId}.jsonl`,
    );
    const cardSessionId = `local_${mintedSessionId}`;
    const cardPath = sessionPath(store, target, cardSessionId);
    outcome.cardPath = cardPath;
    outcome.transcriptPath = transcriptPath;

    if (!already) {
      // Nothing in the ledger vouches for this id, so a file already at either
      // path belongs to someone else — vanishingly unlikely with a freshly
      // minted uuid, but the same refusal `codexImportWrite.ts` makes rather
      // than overwrite something foster did not write.
      if (existsSync(cardPath)) return { ...outcome, reason: 'a card already exists at that id' };
      if (existsSync(transcriptPath)) {
        return { ...outcome, reason: 'a transcript already exists at that id' };
      }
    }

    const at = options.now ?? Date.now();
    const createdAt = detail.createdAt !== undefined ? Date.parse(detail.createdAt) : NaN;
    const lastEventAt = detail.lastEventAt !== undefined ? Date.parse(detail.lastEventAt) : NaN;
    const lastActivityAt = Number.isFinite(lastEventAt) ? lastEventAt : at;

    const card: CodeSessionData = {
      sessionId: cardSessionId,
      cliSessionId: mintedSessionId,
      cwd,
      originCwd: cwd,
      title: detail.title,
      titleSource: 'auto',
      createdAt: Number.isFinite(createdAt) ? createdAt : lastActivityAt,
      lastActivityAt,
      // Without this the card never reaches "Recents" — see buildRestoredSession's own note.
      lastFocusedAt: lastActivityAt,
      isArchived: detail.status === 'archived',
      ...(detail.repo.branch !== undefined ? { branch: detail.repo.branch } : {}),
      _fosterImport: {
        source: 'cloud',
        sourceRolloutPath: `cloud session ${id}`,
        rolloutId: id,
        contentHash: hash,
        ...(detail.containerCliVersion !== undefined
          ? { cliVersion: detail.containerCliVersion }
          : {}),
        importedAt: at,
        toolVersion: VERSION,
      },
    };
    outcome.title = card.title;

    if (dryRun) return { ...outcome, status: 'imported' };

    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileAtomic(transcriptPath, serialised);
    mkdirSync(accountDir(store, target), { recursive: true });
    writeFileAtomic(cardPath, JSON.stringify(card));
    ledger.append({
      kind: 'conversation_imported',
      source: 'cloud',
      rolloutId: id,
      sourceRolloutPath: `cloud session ${id}`,
      contentHash: hash,
      ...(detail.containerCliVersion !== undefined
        ? { cliVersion: detail.containerCliVersion }
        : {}),
      target,
      cardPath,
      transcriptPath,
      sessionId: card.sessionId,
      ...(card.title !== undefined ? { title: card.title } : {}),
    });
    return { ...outcome, status: 'imported' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!dryRun) {
      ledger.append({ kind: 'failed', operation: 'cloud-pull', cliSessionId: id, reason });
    }
    return { ...outcome, status: 'failed', reason };
  }
}
