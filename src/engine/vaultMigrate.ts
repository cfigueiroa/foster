import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { parseCredential, readCliCredential } from '../store/cliCredential.js';
import type { ClaudeClient } from '../store/clients.js';
import { safeReaddir } from '../util/fs.js';
import { rememberCredential } from './vault.js';

/**
 * Bringing the first vault layout into the one that replaced it.
 *
 * The first layout keyed a credential by account alone, on two shelves —
 * `accounts/` for the ones not in use and `rolling/` for the one that was — and
 * stored each as a single JSON envelope. The layout that replaced it keys by
 * `(client, account)`, because one account signed into two config directories
 * has two independent token families and installing one where the other belongs
 * produces a credential that authenticates as nobody.
 *
 * That difference is the whole difficulty here: **the old records do not say
 * which client they came from.** The field did not exist, so it cannot be read;
 * it has to be established, and a migration that guesses wrong writes a
 * credential into a history where it does not belong — the exact failure the new
 * key was introduced to prevent, performed once, permanently, by the tool.
 *
 * So this establishes a client or refuses, and says which of the two happened
 * for every record. Three ways it can be established, strongest first:
 *
 *  - **The credential matches one.** A client whose `.credentials.json` is byte
 *    for byte the record is that record's client. Nothing weaker is needed.
 *  - **Exactly one client is signed in as that account.** Weaker — it is the
 *    cached profile talking, and the cache lags — but on a machine where an
 *    account exists in one place it is the only place the record can have come
 *    from. Reported as inferred, never as read.
 *  - **You said so.** `--to-client` settles it for the records that neither of
 *    the above could reach.
 *
 * And nothing is deleted. A migrated record's file is moved under `legacy/`,
 * where it keeps its bytes and stops being offered; a record that could not be
 * placed is left exactly where it is, with the reason. Re-running is safe: the
 * history deduplicates by content, so a record that somehow migrates twice
 * appends once.
 */

/** The old envelope, as much of it as this needs. */
interface LegacyEnvelope {
  email: string;
  savedAt: number;
  credential: string;
}

export type Evidence =
  | 'the credential matches this client'
  | 'the only client on that account'
  | 'named with --to-client';

export interface MigrationItem {
  file: string;
  /** `accounts` or `rolling` — kept only so the report can say where it sat. */
  shelf: string;
  email: string;
  savedAt: number;
  /** The client it belongs to, once established. */
  surface?: string;
  evidence?: Evidence;
  /** Why it could not be placed. Present exactly when `surface` is absent. */
  blocker?: string;
}

export interface MigrationPlan {
  root: string;
  items: MigrationItem[];
}

export interface MigrationOutcome {
  migrated: number;
  /** Records that were already in the history — moved aside, nothing appended. */
  alreadyPresent: number;
  skipped: number;
  failures: string[];
}

const SHELVES = ['accounts', 'rolling'];

/**
 * What a migration would do, reading everything and writing nothing.
 */
export function planMigration(
  root: string,
  opts: { clients: ClaudeClient[]; toClient?: string },
): MigrationPlan {
  // Read each client's credential once rather than once per record: the match
  // below is the strongest evidence available and would otherwise re-read the
  // same handful of files for every legacy entry.
  const liveByRaw = new Map<string, string>();
  for (const client of opts.clients) {
    const credential = readCliCredential(client.configDir);
    if (credential) liveByRaw.set(credential.raw, client.configDir);
  }

  const items: MigrationItem[] = [];
  for (const shelf of SHELVES) {
    for (const name of safeReaddir(path.join(root, shelf))) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(root, shelf, name);
      const envelope = readEnvelope(file);
      if (!envelope) {
        items.push({
          file,
          shelf,
          email: '(unreadable)',
          savedAt: 0,
          blocker: 'this file is not a vault envelope this version can read',
        });
        continue;
      }

      items.push({ file, shelf, ...envelope, ...place(envelope, liveByRaw, opts) });
    }
  }

  return { root, items };
}

/**
 * Which client a record belongs to, and on what grounds.
 *
 * An explicit `--to-client` wins, because it is a person answering the question
 * the data cannot. Otherwise the byte match is preferred over the account match:
 * one is proof, the other is an inference from a cache that lags.
 */
function place(
  envelope: LegacyEnvelope,
  liveByRaw: Map<string, string>,
  opts: { clients: ClaudeClient[]; toClient?: string },
): { surface?: string; evidence?: Evidence; blocker?: string } {
  if (opts.toClient) {
    return { surface: opts.toClient, evidence: 'named with --to-client' };
  }

  const matched = liveByRaw.get(envelope.credential);
  if (matched) return { surface: matched, evidence: 'the credential matches this client' };

  const onThatAccount = opts.clients.filter(
    (client) => client.identity?.email?.toLowerCase() === envelope.email.toLowerCase(),
  );
  if (onThatAccount.length === 1) {
    return { surface: onThatAccount[0]!.configDir, evidence: 'the only client on that account' };
  }

  return {
    blocker:
      onThatAccount.length > 1
        ? `${onThatAccount.length} clients are signed in as ${envelope.email}, so which one this ` +
          'came from cannot be established. Name it with --to-client.'
        : `no client on this machine holds this credential or is signed in as ${envelope.email}. ` +
          'Name the client it came from with --to-client.',
  };
}

/**
 * Do it.
 *
 * The append comes before the move, in that order and never the other way: a
 * crash between them leaves the record both in its history and in its old place,
 * which the next run resolves by appending nothing and moving it. The reverse
 * order would have a window in which the record is in neither.
 */
export function applyMigration(plan: MigrationPlan, now?: number): MigrationOutcome {
  const outcome: MigrationOutcome = {
    migrated: 0,
    alreadyPresent: 0,
    skipped: 0,
    failures: [],
  };

  for (const item of plan.items) {
    if (!item.surface) {
      outcome.skipped += 1;
      continue;
    }

    try {
      const envelope = readEnvelope(item.file);
      if (!envelope) {
        outcome.skipped += 1;
        continue;
      }

      const { appended } = rememberCredential(
        plan.root,
        item.surface,
        envelope.email,
        parseCredential(envelope.credential),
        { now: envelope.savedAt || now },
      );
      if (appended) outcome.migrated += 1;
      else outcome.alreadyPresent += 1;

      archive(plan.root, item);
    } catch (error) {
      outcome.failures.push(`${item.file}: ${(error as Error).message}`);
    }
  }

  return outcome;
}

/**
 * Move a migrated record out of the way, keeping its bytes.
 *
 * Not a delete, on purpose. The whole reason this vault is append-only is that a
 * credential foster removes is one nothing can reach again — a migration is no
 * more entitled to make that call than a switch is. `legacy/` is where a record
 * goes to stop being offered without ceasing to exist.
 */
function archive(root: string, item: MigrationItem): void {
  const destination = path.join(root, 'legacy', item.shelf, path.basename(item.file));
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(item.file, destination);
}

function readEnvelope(file: string): LegacyEnvelope | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LegacyEnvelope>;
    if (typeof parsed.email !== 'string' || typeof parsed.credential !== 'string') return undefined;
    return {
      email: parsed.email,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      credential: parsed.credential,
    };
  } catch {
    return undefined;
  }
}
