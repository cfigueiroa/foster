import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { VERSION } from '../version.js';
import type { LedgerEvent, LedgerEventInput } from './types.js';

const EVENT_KINDS = new Set<string>([
  'account_labelled',
  'account_identity_seen',
  'account_identity_forgotten',
  'account_switched',
  'fostered',
  'returned',
  'fostering_followed',
  'card_repointed',
  'card_retitled',
  'card_dated',
  'conversation_purged',
  'failed',
  'profile_registered',
  'profile_forgotten',
  'client_root_registered',
  'client_root_forgotten',
  'handler_armed',
  'handler_restored',
  'worktree_released',
  'worktree_release_undone',
  'conversation_imported',
  'conversation_import_undone',
  'layout_applied',
  'pin_move_deferred',
  'pins_moved',
]);

/**
 * A ledger line is only an event when it names a kind we fold. Valid JSON
 * without that discriminant is a neighbor, not history — skip it, keep the rest.
 */
export function parseLedgerEvent(raw: string): LedgerEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !EVENT_KINDS.has(record.kind)) return undefined;
  return record as unknown as LedgerEvent;
}

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FOSTER_HOME ?? path.join(homedir(), '.foster');
  return path.join(base, 'ledger.jsonl');
}

function statSyncOrUndefined(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

/** What `read()` last parsed, and the stat that says whether it is still current. */
interface ReadCache {
  events: LedgerEvent[];
  size: number;
  mtimeMs: number;
}

/**
 * Append-only event log. Kept outside the Claude Desktop store so that foster's
 * own bookkeeping can never be mistaken for app data.
 */
export class Ledger {
  private directoryEnsured = false;

  /**
   * The last parse, kept alive across calls on one instance.
   *
   * Measured on a real ledger (23 MB, 30,445 events): reading and parsing it
   * costs 160-190 ms, and a single sweep calls `read()` on the order of a dozen
   * times per round across up to three rounds, plus once per copy in the branch
   * pass — several seconds paid over and over for the same bytes. Keyed on
   * `(size, mtimeMs)` rather than trusted blindly, so a ledger changed from
   * outside this instance (another `foster` process, a hand edit) is still
   * caught and re-read — the same guarantee an uncached `readFileSync` gave.
   */
  private cache?: ReadCache;

  constructor(private readonly file: string = defaultLedgerPath()) {}

  get path(): string {
    return this.file;
  }

  /**
   * Records an operation that has already completed.
   *
   * Deliberately after the filesystem work, not before. A record of something
   * that did not happen cannot be detected later: a "fostered" event with no file
   * makes every future run skip that session as already done, and a "returned"
   * event with the copy still on disk orphans it where nothing will look again.
   * The opposite gap is self-healing — a copy written but not recorded still
   * carries its own _foster marker for the scanner to find, and a copy deleted
   * but not recorded is simply removed again, which succeeds.
   */
  append(event: LedgerEventInput): LedgerEvent {
    const full = {
      v: 1 as const,
      ts: event.ts ?? Date.now(),
      toolVersion: VERSION,
      ...event,
    } as LedgerEvent;

    // Once per instance rather than once per event: a batch appends one event per
    // session, and the directory cannot stop existing midway through.
    if (!this.directoryEnsured) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.directoryEnsured = true;
      // Only worth checking the first time: nothing but this instance's own
      // appends can leave the file torn again once it is fixed here, so paying
      // the open-and-seek on every later append would guard against a condition
      // that stops recurring after the first one is caught.
      this.ensureTrailingNewline();
    }
    // Taken *before* the write, so it describes the file this instance's cache
    // actually claims to represent. A second writer — another `foster`
    // process, a hand edit, a detached restart script, all of which this
    // ledger is meant to tolerate (see the class docstring) — can append
    // between this instance's last read()/append() and this call; if it did,
    // this stat will already disagree with `this.cache`, and pushing `full`
    // onto the cached array below would silently drop that other writer's
    // event forever (the post-write stat would then make the cache match the
    // real file exactly, so no future read() would ever re-fetch it).
    const preStat = this.cache ? statSyncOrUndefined(this.file) : undefined;

    appendFileSync(this.file, `${JSON.stringify(full)}\n`, 'utf8');

    // Kept in step with the write rather than dropped: growing the cached array
    // in place is what lets `read()` skip the reparse on the very next call, and
    // what lets `project()` (ledger/project.ts) memoize its fold over the same
    // array reference. A cache miss here would cost exactly the reparse this
    // whole thing exists to avoid — worse, on every write in a batch that both
    // reads and writes the ledger many times over (a sweep round).
    if (this.cache) {
      const staleBeforeWrite =
        !preStat || preStat.size !== this.cache.size || preStat.mtimeMs !== this.cache.mtimeMs;
      if (staleBeforeWrite) {
        // Someone else wrote to this file since this instance last saw it.
        // The in-memory array is missing whatever they added, so pushing
        // `full` onto it would produce a view with this instance's own event
        // but not theirs — worse than no cache at all. Drop it; the next
        // read() reparses from disk and picks up everything.
        this.cache = undefined;
      } else {
        this.cache.events.push(full);
        const stat = statSyncOrUndefined(this.file);
        if (stat) {
          this.cache.size = stat.size;
          this.cache.mtimeMs = stat.mtimeMs;
        } else {
          // Cannot happen right after a successful append, but if the file
          // somehow is not there to stat, dropping the cache is the safe
          // fallback: the next read() just reparses, same as an instance that
          // never cached anything.
          this.cache = undefined;
        }
      }
    }
    return full;
  }

  /**
   * Guarantees the file this instance is about to append to already ends in a
   * newline, before the very first append of this instance's life.
   *
   * `appendFileSync` does not check. A line left torn on disk — the detached
   * restart's `taskkill /F`, a power loss mid-write — glues to whatever is
   * appended next: the two half-lines together are neither valid JSON nor
   * separated by a line break, so `parseLedgerEvent` fails on the merged line
   * and *both* events are lost, not just the one that was already damaged.
   * Fixed here rather than left to `read()`'s existing tolerance for a torn
   * *trailing* line (see `parseLedgerEvent`'s skip-what-does-not-parse
   * behaviour, exercised by the "survives a torn final line" test) — that
   * tolerance only helps a reader that never writes again; this instance is
   * about to.
   */
  private ensureTrailingNewline(): void {
    let fd: number;
    try {
      fd = openSync(this.file, 'r+');
    } catch {
      // No file yet — appendFileSync below creates one, newline-clean by
      // construction.
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return;
      const lastByte = Buffer.alloc(1);
      readSync(fd, lastByte, 0, 1, size - 1);
      if (lastByte[0] !== 0x0a) {
        writeSync(fd, Buffer.from('\n', 'utf8'), 0, 1, size);
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The events on disk, parsed.
   *
   * Handed to callers as the live cached array, never a copy: iterating it is
   * every caller's whole use of it (checked across `src/`; nothing sorts,
   * pushes or otherwise mutates what this returns), so a defensive copy here
   * would spend on every call exactly the time this cache exists to save.
   * `project()` leans on that identity to memoize its own fold — see
   * `ledger/project.ts`.
   */
  read(): LedgerEvent[] {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(this.file);
    } catch {
      // No file (yet, or any more). A ledger is never deleted out from under a
      // live instance in ordinary use, so this is almost always "yet" — but
      // either way, the honest answer is empty, not a stale cache from before.
      this.cache = undefined;
      return [];
    }

    if (this.cache && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache.events;
    }

    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }

    const events: LedgerEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseLedgerEvent(trimmed);
      if (event) events.push(event);
    }
    this.cache = { events, size: stat.size, mtimeMs: stat.mtimeMs };
    return events;
  }
}
