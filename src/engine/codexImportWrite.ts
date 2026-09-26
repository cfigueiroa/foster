import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRestoredSession } from '../domain/fostering.js';
import { accountDir, sessionPath } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import type { LedgerState } from '../ledger/project.js';
import type { ImportedConversation } from '../ledger/types.js';
import { type CodexRecord, type CodexRolloutMeta, readRolloutRecords } from '../store/codex.js';
import { claudeProjectsDir, projectDirName } from '../store/transcripts.js';
import { removeSafely, writeFileAtomic } from '../util/fsatomic.js';
import { VERSION } from '../version.js';
import { parseCodexRollout } from './codexImport.js';
import { rolloutToTranscript, serialiseTranscript, titleFromRecords } from './codexTranscript.js';

/**
 * The write half of `foster import-codex` — issue #19.
 *
 * Unlike everything else foster writes, an import fabricates a **transcript**,
 * not only a card: a Codex conversation has no Claude transcript on disk for a
 * card to point at, so foster writes one under `~/.claude/projects` and the card
 * beside it. Both are the first of their kind foster produces, so both are
 * guarded and both are undoable (`_fosterImport` marker + `conversation_imported`
 * ledger event, mirroring `_foster`/`fostered`).
 *
 * The order is the one every other writer keeps: files first, ledger only after
 * they land. A card the ledger vouches for but that never reached disk would make
 * every later run skip it; the reverse is self-healing, because the card carries
 * its own `_fosterImport` and a re-run finds the pair and completes it.
 */

/** The app refuses a transcript larger than this, so foster does not write one. */
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

export type ImportStatus = 'imported' | 'skipped' | 'failed';

export interface ImportOutcome {
  rolloutId: string;
  title?: string;
  status: ImportStatus;
  /** Why it was skipped or how it failed. */
  reason?: string;
  cardPath?: string;
  transcriptPath?: string;
  records?: number;
  bytes?: number;
  turns?: number;
  toolCalls?: number;
  reasoning?: number;
  unpairedToolCalls?: number;
}

export interface ImportRunOptions {
  store: StoreLayout;
  ledger: Ledger;
  /** The folded ledger, for the "already imported" check. */
  state: LedgerState;
  target: AccountRef;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Bring a set of Codex rollouts in as Claude conversations. Each is independent:
 * one that is skipped or throws does not stop the rest.
 */
export function importCodexRollouts(
  metas: readonly CodexRolloutMeta[],
  options: ImportRunOptions,
): ImportOutcome[] {
  const { store, ledger, state, target, dryRun } = options;
  const env = options.env ?? process.env;
  const outcomes: ImportOutcome[] = [];

  for (const meta of metas) {
    const outcome: ImportOutcome = { rolloutId: meta.id, status: 'skipped' };
    try {
      // A card the app can open has to name where the conversation ran, and the
      // transcript is filed under that same directory. Without a cwd there is
      // nowhere to put it and nothing for the app to find.
      if (meta.cwd === undefined) {
        outcomes.push({ ...outcome, reason: 'no working directory recorded' });
        continue;
      }

      let records: CodexRecord[];
      try {
        records = readRolloutRecords(meta.file);
      } catch (error) {
        // A real read failure (past ENOENT, which reads as empty, not
        // thrown) — refuse this rollout, naming why, rather than let the
        // empty-records branch below import it as a conversation with
        // nothing in it.
        outcomes.push({
          ...outcome,
          reason: `rollout could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (records.length === 0) {
        outcomes.push({ ...outcome, reason: 'rollout could not be read' });
        continue;
      }

      const thread = parseCodexRollout(records);
      const card = buildRestoredSession({
        cliSessionId: meta.id,
        cwd: meta.cwd,
        ...(thread.title !== undefined ? { title: thread.title } : {}),
        ...(meta.startedAt !== undefined && Number.isFinite(Date.parse(meta.startedAt))
          ? { createdAt: Date.parse(meta.startedAt) }
          : {}),
        lastActivityAt: meta.mtimeMs,
      });
      outcome.title = card.title;

      // `buildRestoredSession` reduces a worktree cwd to its repository, which is
      // where the card opens; the transcript is filed under that same directory
      // and every record carries it, so all three agree.
      const cwd = card.cwd;
      if (cwd === undefined) {
        outcomes.push({ ...outcome, reason: 'no working directory recorded' });
        continue;
      }

      const converted = rolloutToTranscript(records, {
        cliSessionId: meta.id,
        cwd,
        ...(meta.gitBranch !== undefined ? { gitBranch: meta.gitBranch } : {}),
      });
      // A thread with no human turn has no parser title; the first thing the
      // assistant said beats the bare "(recovered conversation)" fallback.
      if (thread.title === undefined) {
        const derived = titleFromRecords(converted.records);
        if (derived !== undefined) {
          card.title = derived;
          outcome.title = derived;
        }
      }
      outcome.turns = converted.stats.turns;
      outcome.toolCalls = converted.stats.toolCalls;
      outcome.reasoning = converted.stats.reasoning;
      outcome.unpairedToolCalls = converted.stats.unpairedToolCalls;
      if (converted.records.length === 0) {
        outcomes.push({ ...outcome, reason: 'no conversation turns to import' });
        continue;
      }

      const serialised = serialiseTranscript(converted.records);
      const bytes = Buffer.byteLength(serialised, 'utf8');
      outcome.records = converted.records.length;
      outcome.bytes = bytes;
      if (bytes > MAX_TRANSCRIPT_BYTES) {
        outcomes.push({
          ...outcome,
          reason: `transcript is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB the app loads`,
        });
        continue;
      }

      const transcriptPath = path.join(
        claudeProjectsDir(env),
        projectDirName(cwd),
        `${meta.id}.jsonl`,
      );
      const cardPath = sessionPath(store, target, card.sessionId);
      outcome.cardPath = cardPath;
      outcome.transcriptPath = transcriptPath;

      const hash = hashFile(meta.file);
      const already = state.imported.get(meta.id);
      if (already) {
        // Already brought in. Re-do it only when a file went missing or the
        // rollout itself changed under us; otherwise it is a clean no-op.
        if (
          already.contentHash === hash &&
          existsSync(already.cardPath) &&
          existsSync(already.transcriptPath)
        ) {
          outcomes.push({ ...outcome, status: 'skipped', reason: 'already imported' });
          continue;
        }
      } else {
        // Nothing in the ledger says this is ours, so a file already sitting at
        // either path belongs to someone else — a real Claude conversation that
        // shares the id, or an import whose ledger record was lost. Either way,
        // refuse rather than overwrite.
        if (existsSync(cardPath)) {
          outcomes.push({ ...outcome, reason: 'a card already exists at that id' });
          continue;
        }
        if (existsSync(transcriptPath)) {
          outcomes.push({ ...outcome, reason: 'a transcript already exists at that id' });
          continue;
        }
      }

      card._fosterImport = {
        sourceRolloutPath: meta.file,
        rolloutId: meta.id,
        contentHash: hash,
        ...(meta.cliVersion !== undefined ? { cliVersion: meta.cliVersion } : {}),
        importedAt: options.now ?? Date.now(),
        toolVersion: VERSION,
      };

      if (dryRun) {
        outcomes.push({ ...outcome, status: 'imported' });
        continue;
      }

      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      writeFileAtomic(transcriptPath, serialised);
      mkdirSync(accountDir(store, target), { recursive: true });
      writeFileAtomic(cardPath, JSON.stringify(card));
      ledger.append({
        kind: 'conversation_imported',
        rolloutId: meta.id,
        sourceRolloutPath: meta.file,
        contentHash: hash,
        ...(meta.cliVersion !== undefined ? { cliVersion: meta.cliVersion } : {}),
        target,
        cardPath,
        transcriptPath,
        sessionId: card.sessionId,
        ...(card.title !== undefined ? { title: card.title } : {}),
      });
      outcomes.push({ ...outcome, status: 'imported' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!dryRun) {
        ledger.append({
          kind: 'failed',
          operation: 'import-codex',
          cliSessionId: meta.id,
          reason,
        });
      }
      outcomes.push({ ...outcome, status: 'failed', reason });
    }
  }

  return outcomes;
}

export interface UndoOutcome {
  rolloutId: string;
  title?: string;
  status: 'undone' | 'failed';
  reason?: string;
  cardPath?: string;
  transcriptPath?: string;
}

/**
 * Undo imports: remove the card and the transcript foster wrote and record the
 * reversal. Removing the transcript is what makes this different from returning
 * a fostered copy — a copy shares the original's transcript and has nothing of
 * its own there, but an import's transcript exists only because foster wrote it.
 */
export function undoCodexImports(
  imports: readonly ImportedConversation[],
  options: { ledger: Ledger; dryRun: boolean },
): UndoOutcome[] {
  const outcomes: UndoOutcome[] = [];
  for (const imported of imports) {
    const outcome: UndoOutcome = {
      rolloutId: imported.rolloutId,
      status: 'undone',
      cardPath: imported.cardPath,
      transcriptPath: imported.transcriptPath,
      ...(imported.title !== undefined ? { title: imported.title } : {}),
    };
    if (options.dryRun) {
      outcomes.push(outcome);
      continue;
    }
    try {
      // Absence is success: the person may have deleted the row in the app.
      removeSafely(imported.cardPath);
      removeSafely(imported.transcriptPath);
      options.ledger.append({ kind: 'conversation_import_undone', rolloutId: imported.rolloutId });
      outcomes.push(outcome);
    } catch (error) {
      outcomes.push({
        ...outcome,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
