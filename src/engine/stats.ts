import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import { copySessionIds } from '../ledger/project.js';
import type { Ledger } from '../ledger/log.js';
import { USAGE_LIMIT } from './revive.js';
import { scanStore } from '../store/scanner.js';
import { indexAllTranscripts, transcriptRoots } from '../store/transcripts.js';

/**
 * `foster stats` — token usage, sessions and usage-limit stops, read out of the
 * transcripts themselves and aggregated per account, per model and per week.
 *
 * The motivation is per-model weekly limits: an account can be at, say, 53% of
 * its general week and 100% on one model, and the account-wide number alone
 * never shows that. Nothing here calls the usage API (`foster usage` does, for
 * the account signed in now) — this reads what the transcripts already wrote
 * down, for every account this store has ever fostered into or seen, at once.
 */

export interface UsageEvent {
  at: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface LimitStopEvent {
  at: number;
  model: string;
}

export interface StatsOptions {
  /** Only events at or after this instant. */
  since: number;
  by: 'account' | 'model' | 'week';
}

/** One conversation to fold into the report, and the account (if any) it counts against. */
export interface StatsConversation {
  cliSessionId: string;
  account?: AccountRef;
}

/** The seams tests replace: which conversations exist, and what their transcripts say. */
export interface StatsDeps {
  conversations(): StatsConversation[];
  /** Usage and limit-stop events at or after `since`, from every file the conversation occupies. */
  eventsOf(cliSessionId: string, since: number): { usage: UsageEvent[]; stops: LimitStopEvent[] };
}

export interface StatsBucketKey {
  account?: string;
  model?: string;
  /** The Monday (UTC) the week starts, as `YYYY-MM-DD`. */
  week?: string;
}

export interface StatsBucket {
  key: StatsBucketKey;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  limitStops: number;
}

export interface StatsReport {
  since: number;
  by: StatsOptions['by'];
  buckets: StatsBucket[];
  totals: Omit<StatsBucket, 'key'>;
}

/** Sorts before an account uuid ever could — Sets and Maps otherwise order it wherever it fell. */
const UNATTRIBUTED = '\u0000unattributed';

interface Cell {
  account?: string;
  model: string;
  week: string;
  sessions: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  limitStops: number;
}

function cellKey(account: string | undefined, model: string, week: string): string {
  return `${account ?? UNATTRIBUTED}\u0001${model}\u0001${week}`;
}

function cellFor(
  cells: Map<string, Cell>,
  account: string | undefined,
  model: string,
  week: string,
): Cell {
  const key = cellKey(account, model, week);
  let cell = cells.get(key);
  if (!cell) {
    cell = {
      ...(account !== undefined ? { account } : {}),
      model,
      week,
      sessions: new Set(),
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      limitStops: 0,
    };
    cells.set(key, cell);
  }
  return cell;
}

export function computeStats(options: StatsOptions, deps: StatsDeps): StatsReport {
  const cells = new Map<string, Cell>();
  const totalSessions = new Set<string>();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    limitStops: 0,
  };

  for (const conversation of deps.conversations()) {
    const { usage, stops } = deps.eventsOf(conversation.cliSessionId, options.since);
    if (usage.length === 0 && stops.length === 0) continue;
    totalSessions.add(conversation.cliSessionId);

    for (const event of usage) {
      const week = weekKey(event.at);
      const cell = cellFor(cells, conversation.account?.accountUuid, event.model, week);
      cell.sessions.add(conversation.cliSessionId);
      cell.inputTokens += event.inputTokens;
      cell.outputTokens += event.outputTokens;
      cell.cacheCreationTokens += event.cacheCreationTokens;
      cell.cacheReadTokens += event.cacheReadTokens;
      totals.inputTokens += event.inputTokens;
      totals.outputTokens += event.outputTokens;
      totals.cacheCreationTokens += event.cacheCreationTokens;
      totals.cacheReadTokens += event.cacheReadTokens;
    }

    for (const stop of stops) {
      const week = weekKey(stop.at);
      const cell = cellFor(cells, conversation.account?.accountUuid, stop.model, week);
      cell.sessions.add(conversation.cliSessionId);
      cell.limitStops += 1;
      totals.limitStops += 1;
    }
  }

  return {
    since: options.since,
    by: options.by,
    buckets: collapse(cells, options.by),
    totals: { sessions: totalSessions.size, ...totals },
  };
}

/** Merges the fine-grained (account, model, week) cells down to the one dimension asked for. */
function collapse(cells: Map<string, Cell>, by: StatsOptions['by']): StatsBucket[] {
  const merged = new Map<
    string,
    { key: StatsBucketKey; sessions: Set<string> } & Omit<StatsBucket, 'key' | 'sessions'>
  >();

  for (const cell of cells.values()) {
    const key: StatsBucketKey =
      by === 'account'
        ? { ...(cell.account !== undefined ? { account: cell.account } : {}) }
        : by === 'model'
          ? { model: cell.model }
          : { week: cell.week };
    const mapKey =
      by === 'account' ? (cell.account ?? UNATTRIBUTED) : by === 'model' ? cell.model : cell.week;

    let bucket = merged.get(mapKey);
    if (!bucket) {
      bucket = {
        key,
        sessions: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        limitStops: 0,
      };
      merged.set(mapKey, bucket);
    }
    for (const id of cell.sessions) bucket.sessions.add(id);
    bucket.inputTokens += cell.inputTokens;
    bucket.outputTokens += cell.outputTokens;
    bucket.cacheCreationTokens += cell.cacheCreationTokens;
    bucket.cacheReadTokens += cell.cacheReadTokens;
    bucket.limitStops += cell.limitStops;
  }

  const buckets = [...merged.values()].map((bucket) => ({
    key: bucket.key,
    sessions: bucket.sessions.size,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    limitStops: bucket.limitStops,
  }));

  if (by === 'week') buckets.sort((a, b) => (a.key.week ?? '').localeCompare(b.key.week ?? ''));
  else {
    buckets.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  }
  return buckets;
}

/** The Monday (UTC) a moment's week starts on, as `YYYY-MM-DD` — stable across timezones. */
export function weekKey(at: number): string {
  const d = new Date(at);
  const isoDay = (d.getUTCDay() + 6) % 7; // 0 = Monday, ... 6 = Sunday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - isoDay));
  return monday.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Real deps: transcripts on disk.
// ---------------------------------------------------------------------------

/** How much of a transcript to hold in memory at once while scanning it. */
const CHUNK_BYTES = 1024 * 1024;

function* streamLines(file: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let pending = '';
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      const lines = (pending + buffer.subarray(0, read).toString('utf8')).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    if (pending !== '') yield pending;
  } catch {
    // A transcript that turns unreadable mid-scan yields what it gave; the
    // caller treats a short read as "no more events" rather than as a fork.
  } finally {
    closeSync(fd);
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

type LineEvent =
  | { kind: 'usage'; at: number; event: UsageEvent }
  | { kind: 'stop'; at: number; event: LimitStopEvent };

/**
 * One line's event, or undefined for a line that is not one of the two record
 * shapes this cares about.
 *
 * Cheap substring checks come before `JSON.parse`, on purpose: the large
 * majority of lines in a transcript are tool calls and tool results, and a
 * turn's `usage` (or a stop's `rate_limit`) each appear on one assistant
 * record. Measured against the whole-record parse this replaces on a real
 * store's transcripts (`recordFields` in `store/transcripts.ts` did the same
 * measurement for a different pair of fields): skipping the parse for every
 * line that cannot possibly match is the entire saving, not a rounding error.
 */
function eventOfLine(line: string): LineEvent | undefined {
  const hasUsage = line.includes('"usage"');
  const hasStop = !hasUsage && line.includes(USAGE_LIMIT);
  if (!hasUsage && !hasStop) return undefined;

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (record.type !== 'assistant' || record.isSidechain === true) return undefined;

  const at = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '');
  if (!Number.isFinite(at)) return undefined;

  const message = record.message as Record<string, unknown> | undefined;
  const model = typeof message?.model === 'string' ? message.model : 'unknown';

  if (record.isApiErrorMessage === true && record.error === USAGE_LIMIT) {
    return { kind: 'stop', at, event: { at, model } };
  }

  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  return {
    kind: 'usage',
    at,
    event: {
      at,
      model,
      inputTokens: numberField(usage.input_tokens),
      outputTokens: numberField(usage.output_tokens),
      cacheCreationTokens: numberField(usage.cache_creation_input_tokens),
      cacheReadTokens: numberField(usage.cache_read_input_tokens),
    },
  };
}

/** Every usage and limit-stop event in one transcript file, at or after `since`. */
export function usageEventsInFile(
  file: string,
  since: number,
): { usage: UsageEvent[]; stops: LimitStopEvent[] } {
  const usage: UsageEvent[] = [];
  const stops: LimitStopEvent[] = [];
  // The app writes a limit-stop record with its own model field set to the
  // literal placeholder `<synthetic>` — see the doc comment on `lastAnswer` in
  // `store/transcripts.ts`. The real model is whatever the conversation's last
  // genuine turn (a usage record, never an error or a sidechain — `eventOfLine`
  // already filters both out before a line can become `kind: 'usage'`) was
  // running, so it is tracked here across the whole file, in order, and a stop
  // is attributed to it instead of to the placeholder. Tracked regardless of
  // `since`: a stop just inside the window can be preceded by the model that
  // was running just outside it, and that model is still the right answer.
  let lastRealModel: string | undefined;

  for (const line of streamLines(file)) {
    const found = eventOfLine(line);
    if (!found) continue;

    if (found.kind === 'usage') {
      lastRealModel = found.event.model;
      if (found.at >= since) usage.push(found.event);
      continue;
    }

    if (found.at >= since) {
      stops.push({ ...found.event, model: lastRealModel ?? found.event.model });
    }
  }

  return { usage, stops };
}

/**
 * Every account whose transcripts still exist on disk, for the whole-store
 * report. Takes the scan rather than doing it itself so a caller that already
 * has one — `defaultStatsDeps` scans once per invocation of `stats`, and
 * `foster disk` scans once per invocation of its own command — never asks for
 * a second. The two commands are separate CLI handlers, run in separate
 * processes, so nothing is actually shared between them today.
 */
export function ownersOf(sessions: DiscoveredSession[]): Map<string, AccountRef> {
  const owners = new Map<string, { account: AccountRef; isCopy: boolean }>();
  for (const found of sessions) {
    const id = found.data.cliSessionId;
    if (!id) continue;
    const existing = owners.get(id);
    // A native card beats a copy for saying which account actually reached the
    // usage limit — a copy only proves the conversation was fostered *into*
    // that account, not that the tokens were spent under it. Where nothing but
    // copies exist (the native card was deleted, or never came from here), the
    // first one found still says more than nothing.
    if (!existing || (existing.isCopy && !found.isCopy)) {
      owners.set(id, { account: found.account, isCopy: found.isCopy });
    }
  }
  return new Map([...owners].map(([id, owner]) => [id, owner.account]));
}

export function defaultStatsDeps(
  store: StoreLayout,
  ledger: Ledger,
  env: NodeJS.ProcessEnv = process.env,
): StatsDeps {
  const sessions = scanStore(store, copySessionIds(ledger.read()));
  const owners = ownersOf(sessions);
  const index = indexAllTranscripts(transcriptRoots(env));

  const conversations: StatsConversation[] = [...index.keys()].map((cliSessionId) => ({
    cliSessionId,
    ...(owners.has(cliSessionId) ? { account: owners.get(cliSessionId) } : {}),
  }));

  return {
    conversations: () => conversations,
    eventsOf(cliSessionId, since) {
      const files = index.get(cliSessionId) ?? [];
      const usage: UsageEvent[] = [];
      const stops: LimitStopEvent[] = [];
      for (const file of files) {
        // A file whose last write predates the window cannot hold a record
        // inside it — records are appended in order — so the read itself,
        // the expensive part on a large transcript, is skipped outright.
        let mtime: number;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < since) continue;
        const found = usageEventsInFile(file, since);
        usage.push(...found.usage);
        stops.push(...found.stops);
      }
      return { usage, stops };
    },
  };
}
