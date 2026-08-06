import { statSync } from 'node:fs';
import type { Ledger } from '../ledger/log.js';
import type { Purgeable } from '../store/purge.js';
import { errorMessage } from '../util/fs.js';
import { removeSafely } from './fsatomic.js';

/**
 * Destroy the conversations behind deleted sessions.
 *
 * Every other operation in foster adds a file or removes one it wrote itself,
 * and the ledger exists so any of them can be walked backwards. This one cannot
 * be walked backwards. It deletes the transcript — the conversation itself,
 * every word of it — and there is no copy anywhere, by design: a command whose
 * purpose is to make something unrecoverable cannot quietly keep a backup and
 * still be that command.
 *
 * Which is why the interesting part of this module is what it refuses. The
 * caller supplies a candidate set that is already narrowed to conversations no
 * session anywhere points at (see `findPurgeable`); the gate here is the other
 * one — a live `claude` process holding the file open. Deleting underneath a
 * running writer is how a process ends up appending to a file that no longer has
 * a name, which loses the work in progress and leaves nothing to show for it.
 */

export type PurgeStatus = 'purged' | 'skipped' | 'failed';

export interface PurgeOutcome {
  cliSessionId: string;
  title: string;
  status: PurgeStatus;
  detail?: string;
  /**
   * What actually went. Non-zero on a failure too: a purge can throw part-way
   * through a mirrored transcript, and reporting nothing in that case would
   * describe a half-destroyed conversation as untouched.
   */
  files: number;
  bytes: number;
}

export interface PurgeOptions {
  ledger: Ledger;
  /** When true, decide everything and delete nothing. */
  dryRun?: boolean;
  /**
   * Conversations a live `claude` process is holding open, lower-cased.
   *
   * Injected rather than read here so the engine stays free of process
   * inspection, and so tests can state the condition instead of arranging it.
   */
  held?: ReadonlySet<string>;
}

export function purgeConversations(items: Purgeable[], options: PurgeOptions): PurgeOutcome[] {
  const { ledger, dryRun = false, held } = options;
  const outcomes: PurgeOutcome[] = [];

  for (const item of items) {
    const title = item.facts.title ?? item.cliSessionId;

    if (held?.has(item.cliSessionId.toLowerCase())) {
      outcomes.push({
        cliSessionId: item.cliSessionId,
        title,
        status: 'skipped',
        detail: 'a live claude process is holding this conversation open',
        files: 0,
        bytes: 0,
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        cliSessionId: item.cliSessionId,
        title,
        status: 'purged',
        files: item.files.length,
        bytes: item.bytes,
      });
      continue;
    }

    // Declared outside the try, because a throw part-way through a mirrored
    // transcript leaves files that are already destroyed. A catch that could not
    // see them reported "0 destroyed" over a conversation that was half gone.
    let removed = 0;
    let removedBytes = 0;

    try {
      // Every copy, and the size of each one measured immediately before it goes.
      // Taking the total from the scan instead would claim back bytes that a copy
      // deleted by something else in the meantime never gave up.
      for (const file of item.files) {
        const size = sizeOf(file);
        if (!removeSafely(file)) continue;
        removed += 1;
        removedBytes += size;
      }

      // Recorded after the deletion, and only for a deletion that happened —
      // the same order fostering uses, for the same reason. An event written
      // first would claim a destruction that a failure then did not perform.
      ledger.append({
        kind: 'conversation_purged',
        cliSessionId: item.cliSessionId,
        files: removed,
        bytes: removedBytes,
      });
      outcomes.push({
        cliSessionId: item.cliSessionId,
        title,
        status: 'purged',
        files: removed,
        bytes: removedBytes,
      });
    } catch (error) {
      const reason = errorMessage(error);
      // What did go is recorded first, and as the destruction it was. This is
      // the one operation with no undo, so a partial one that left no trace
      // would make a missing transcript indistinguishable from corruption —
      // which is the question the ledger exists here to answer.
      if (removed > 0) {
        ledger.append({
          kind: 'conversation_purged',
          cliSessionId: item.cliSessionId,
          files: removed,
          bytes: removedBytes,
        });
      }
      ledger.append({
        kind: 'failed',
        operation: 'purge',
        cliSessionId: item.cliSessionId,
        reason,
      });
      outcomes.push({
        cliSessionId: item.cliSessionId,
        title,
        status: 'failed',
        detail: reason,
        files: removed,
        bytes: removedBytes,
      });
    }
  }

  return outcomes;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export class PurgeNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurgeNotConfirmedError';
  }
}

/**
 * The second gate, and the reason it counts rather than merely asks.
 *
 * `--yes` is the switch every writing command in foster has, and for the others
 * it is enough: what they do can be undone by the command sitting next to them.
 * Accepting the same flag here would put "destroy every conversation I ever
 * threw away" one word away from "copy them into my sidebar" — the same word,
 * in the same shell history.
 *
 * A count is a better second gate than another flag or a typed phrase, because
 * it is the only one that can fail for a reason other than intent. It cannot be
 * pasted out of documentation or typed from muscle memory; it has to be read off
 * a dry run. And if the set moved between looking and acting — something else
 * deleted in the app in the meantime, a filter that matches more than it did —
 * the number no longer agrees and the run stops, instead of destroying a
 * conversation that was never on the list the user actually read.
 */
export function assertPurgeConfirmed(confirm: string | undefined, count: number): void {
  if (confirm === undefined) {
    throw new PurgeNotConfirmedError(
      'Destroying conversations is permanent: there is no undo, and foster keeps no copy.\n' +
        'Read the list first, then confirm the count:\n' +
        '  foster purge                       (writes nothing)\n' +
        `  foster purge --yes --confirm ${count}`,
    );
  }

  const expected = Number(confirm);
  if (!/^\d+$/.test(confirm.trim()) || !Number.isInteger(expected)) {
    throw new PurgeNotConfirmedError(
      `--confirm takes the number of conversations to destroy, not "${confirm}".`,
    );
  }
  if (expected !== count) {
    throw new PurgeNotConfirmedError(
      `--confirm ${expected} does not match the ${count} conversation(s) this run would destroy.\n` +
        'Either the filters do not select what you expected, or the set changed since you looked.\n' +
        'Re-read it with "foster purge" and confirm the number it prints.',
    );
  }
}

export function summarisePurge(outcomes: PurgeOutcome[]): {
  purged: number;
  skipped: number;
  failed: number;
  bytes: number;
} {
  const counts = { purged: 0, skipped: 0, failed: 0, bytes: 0 };
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
    if (outcome.status === 'purged') counts.bytes += outcome.bytes;
  }
  return counts;
}
