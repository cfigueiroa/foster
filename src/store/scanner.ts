import { statSync } from 'node:fs';
import path from 'node:path';
import { unfosterableReasons } from '../domain/fostering.js';
import { isSessionFileName } from '../domain/naming.js';
import { accountDir, listAccountDirs } from '../domain/paths.js';
import type {
  AccountRef,
  CodeSessionData,
  DiscoveredSession,
  StoreLayout,
} from '../domain/types.js';
import { safeReaddir } from '../util/fs.js';
import { readSessionCard, readSessionFile } from './sessionFile.js';

/**
 * Read-only view of the Claude Desktop store.
 *
 * Nothing in this module writes. All mutation lives in the engine, so that the
 * scanner can always be run against a live install without risk.
 */

export interface AccountSummary {
  account: AccountRef;
  /** Sessions the app itself created. */
  nativeCount: number;
  /** Sessions foster copied in. */
  copyCount: number;
  isCurrent: boolean;
}

/**
 * What foster wrote, according to the ledger.
 *
 * Needed because the marker on the file is not durable. `activeToPersisted` in
 * the app builds the object it saves from an explicit list of fields, so the
 * first time the app writes a copy back — a title change, a focus, any activity —
 * `_foster` is dropped and the copy becomes indistinguishable from a session the
 * app made itself. Measured on a live store: of 364 copies, 21 had lost the
 * marker, and they were exactly the 21 that had been opened.
 */
export type KnownCopies = ReadonlySet<string>;

const NOTHING_KNOWN: KnownCopies = new Set<string>();

/**
 * How a scan reads each card. `slim` leaves `BULKY_CARD_FIELDS` out of what it
 * keeps (`store/sessionFile.ts`) — for a caller that holds every card of the
 * store for a long run, which is the sweep, and which puts them back with
 * `withBulkyFields` before any write that copies a whole card. Off by default,
 * so every other reader keeps the card exactly as the file holds it.
 *
 * `cache` is the other half of that same long run: see `ScanCache` below.
 */
export interface ScanOptions {
  slim?: boolean;
  cache?: ScanCache;
}

interface CachedCard {
  mtimeMs: number;
  size: number;
  card: { data: CodeSessionData; slim: boolean };
}

/**
 * What a scan actually pays for is the read and the `JSON.parse`, not the
 * directory listing or the per-card classification (`isCopy`, `reasons`) —
 * those depend on `copies`, which can grow mid-run as a sweep's own passes
 * foster new cards, so they are always recomputed fresh. The parsed card
 * itself is what this remembers, keyed by path and invalidated the moment a
 * file's `mtime`/`size` no longer match what was cached — which is every
 * file a sweep did not just write, still true after several re-reads of the
 * same account.
 *
 * A cache entry answers a `slim` request whether it was itself read slim or
 * whole (the bulky fields are simply unused), but never answers a `whole`
 * request from a `slim` entry — those fields are gone from it for good, so
 * that case reads the file again and upgrades the entry in place.
 *
 * One instance lives for one run and is never shared across runs or
 * processes — a fresh `ScanCache` is exactly as safe as passing none at all.
 * See `ops/sweep.ts`, which is the only caller that keeps one alive across
 * several scans.
 *
 * A cache hit hands back the exact same `card.data` object reference every
 * time (see `DiscoveredSession.data`'s own doc comment) — never a fresh
 * parse. The whole point is to skip the `JSON.parse`, so nothing here clones
 * it. That makes an in-place mutation of a cached card's `data` a bug that
 * corrupts every later read of that card for the rest of the run, not just
 * the caller that mutated it — always spread into a new object instead.
 */
export class ScanCache {
  private readonly entries = new Map<string, CachedCard>();

  /** The card at `file`, read fresh only when the cache cannot serve it. */
  read(
    file: string,
    slim: boolean,
  ): { card: { data: CodeSessionData; slim: boolean }; size: number } | undefined {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(file);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      this.entries.delete(file);
      return undefined;
    }

    const cached = this.entries.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      if (slim || !cached.card.slim) return { card: cached.card, size: stat.size };
    }

    const card = slim ? readSessionCard(file) : wholeCard(file);
    if (!card) {
      this.entries.delete(file);
      return undefined;
    }
    this.entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, card });
    return { card, size: stat.size };
  }
}

function readUncached(
  file: string,
  slim: boolean,
): { card: { data: CodeSessionData; slim: boolean }; size: number } | undefined {
  const card = slim ? readSessionCard(file) : wholeCard(file);
  if (!card) return undefined;
  return { card, size: sizeOf(file) };
}

export function scanAccount(
  store: StoreLayout,
  account: AccountRef,
  copies: KnownCopies = NOTHING_KNOWN,
  options: ScanOptions = {},
): DiscoveredSession[] {
  const dir = accountDir(store, account);
  const out: DiscoveredSession[] = [];
  const slim = options.slim ?? false;

  for (const entry of safeReaddir(dir)) {
    if (!isSessionFileName(entry)) continue;

    const file = path.join(dir, entry);
    const read = options.cache ? options.cache.read(file, slim) : readUncached(file, slim);
    if (!read) continue;
    const { card, size } = read;
    const { data } = card;

    // A copy foster wrote, not a session the app created. Classifying before
    // recording is what keeps a rescan from "discovering" copies as new sessions
    // and attributing them to the wrong origin — and the ledger is consulted
    // because the marker on the file does not survive the app saving it.
    const isCopy = data._foster !== undefined || copies.has(data.sessionId);

    const reasons = unfosterableReasons(data, isCopy);
    // The app skips any session file over its size limit while loading, with only
    // a line in its log to show for it. Copying one would write a file that never
    // appears and never explains why, so it is excluded here instead.
    if (size > SESSION_FILE_MAX_BYTES) reasons.push('too-large');

    // Always false here. One account cannot answer whether a conversation still
    // has a card of its own — the original may be sitting in the account next
    // door — so the judgement is made in scanStore, over everything.
    out.push({
      path: file,
      account,
      data,
      isCopy,
      isStranded: false,
      reasons,
      ...(card.slim ? { slim: true } : {}),
    });
  }

  return out;
}

export function scanStore(
  store: StoreLayout,
  copies: KnownCopies = NOTHING_KNOWN,
  options: ScanOptions = {},
): DiscoveredSession[] {
  return markStranded(
    listAccountDirs(store).flatMap((account) => scanAccount(store, account, copies, options)),
  );
}

function wholeCard(file: string): { data: CodeSessionData; slim: boolean } | undefined {
  const data = readSessionFile(file);
  return data ? { data, slim: false } : undefined;
}

/**
 * Sessions from the accounts named, judged against the whole store.
 *
 * Reading only the accounts being offered would be cheaper and would get the
 * answer wrong: whether a copy is the last card of its conversation depends on
 * the accounts *not* being offered, the destination included. Restricting the
 * scan first is what made a copy in a source account look stranded while its
 * original sat in the account the copies were going to.
 */
export function scanSources(
  store: StoreLayout,
  accounts: AccountRef[],
  copies: KnownCopies = NOTHING_KNOWN,
): DiscoveredSession[] {
  return fromAccounts(scanStore(store, copies), accounts);
}

/**
 * The sessions of a whole-store scan that sit in the accounts named.
 *
 * The scan is the expensive half — every card in every account, read and
 * parsed — and a sweep asks this question of the same scan several times over,
 * once per destination and once per set of sources. Splitting the filter out
 * is what lets it be asked without reading the store again.
 */
export function fromAccounts(
  sessions: DiscoveredSession[],
  accounts: AccountRef[],
): DiscoveredSession[] {
  const wanted = new Set(accounts.map(directoryOf));
  return sessions.filter((session) => wanted.has(directoryOf(session.account)));
}

function directoryOf(account: AccountRef): string {
  return `${account.accountUuid}/${account.organizationUuid}`;
}

/**
 * Decide which copies are the last card their conversation has.
 *
 * A conversation with a card of its own is reachable the ordinary way, so its
 * copies stay out of the running. A conversation with nothing but copies is
 * reachable *only* through one of them, and refusing all of them does not keep
 * anything tidy — it makes the conversation unfosterable for good, which is the
 * opposite of what this tool is for.
 *
 * Exported for tests, and because the rule is worth being able to point at.
 */
export function markStranded(sessions: DiscoveredSession[]): DiscoveredSession[] {
  const withOwnCard = new Set<string>();
  for (const session of sessions) {
    if (session.isCopy) continue;
    if (session.data.cliSessionId) withOwnCard.add(session.data.cliSessionId);
  }

  return sessions.map((session) => {
    const conversation = session.data.cliSessionId;
    if (!session.isCopy || !conversation || withOwnCard.has(conversation)) return session;
    return {
      ...session,
      isStranded: true,
      // The only reason strandedness lifts. Archived, too-large and the rest
      // describe the file itself and are as true of a last copy as of anything.
      reasons: session.reasons.filter((reason) => reason !== 'already-a-copy'),
    };
  });
}

export function summarise(
  store: StoreLayout,
  currentAccountUuid: string | undefined,
  copies: KnownCopies = NOTHING_KNOWN,
): AccountSummary[] {
  return listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account, copies), currentAccountUuid),
  );
}

/** Counts an already-scanned account, so callers that need both do not re-read every file. */
export function summariseAccount(
  account: AccountRef,
  sessions: DiscoveredSession[],
  currentAccountUuid: string | undefined,
): AccountSummary {
  let copyCount = 0;
  for (const session of sessions) if (session.isCopy) copyCount += 1;
  return {
    account,
    nativeCount: sessions.length - copyCount,
    copyCount,
    isCurrent: account.accountUuid === currentAccountUuid,
  };
}

/**
 * The largest session file Claude Desktop will load. Mirrored from the app, which
 * skips anything bigger and carries on.
 */
export const SESSION_FILE_MAX_BYTES = 10 * 1024 * 1024;

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
