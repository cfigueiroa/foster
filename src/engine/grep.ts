import { readFileSync, statSync } from 'node:fs';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { scanStore } from '../store/scanner.js';
import {
  indexAllTranscripts,
  readTranscriptFacts,
  textOf,
  transcriptRoots,
} from '../store/transcripts.js';

/**
 * `foster grep`: a regex over every transcript this machine holds — every
 * client's `projects/` tree, every conversation any account ever ran —
 * searched by what a `user`/`assistant` message actually says rather than by
 * the JSONL a record happens to be written as.
 *
 * Two passes per file, coarse then real, the same shape `idsMentionedIn`
 * (`store/transcripts.ts`) already reads a transcript in for lineage: latin1,
 * byte-for-byte, because the structure of a JSON line and its ASCII survive
 * that decode and a rare term almost never does. What is new here is *how*
 * coarse the first pass is. `idsMentionedIn` still walks the whole file with
 * `matchAll`, because it is genuinely after every occurrence of several ids at
 * once; a `grep` for one rare term needs only one question answered — does
 * this file hold it at all? — and asking that of the *whole file's text in one
 * call*, before ever splitting it into lines, is what a plain `String#includes`
 * (or, for a pattern that carries real regex syntax, one `RegExp#test`, which
 * stops at its first hit rather than collecting every one) is fast at. A
 * transcript that fails it is never parsed, never even split into lines — which
 * is what most of a large corpus does, for a rare term.
 *
 * The real match is asked only of a line the coarse pass flagged, and only of
 * the *decoded* text a message actually shows — never of the raw JSONL, which
 * would as happily match a `\n` inside a JSON escape or a `uuid` quoted inside
 * a tool result as it would a word someone wrote. `Buffer.from(line,
 * 'latin1').toString('utf8')` is what recovers the real characters: the latin1
 * read never changed a byte, so writing those char codes back out as bytes and
 * decoding *that* as UTF-8 reconstructs exactly what was on disk, not a guess —
 * the same round trip `recordFields`' comments describe for the three fields it
 * reads, extended here to a whole line because a search needs the message
 * body, not three short strings.
 */

export interface GrepHit {
  cliSessionId: string;
  file: string;
  /** 1-based, the way an editor or `grep -n` would say it. */
  lineNumber: number;
  at?: number;
  role: string;
  /** The matched text and a little of what is around it, whitespace collapsed. */
  snippet: string;
}

/** One card, in one account, that opens the conversation a hit belongs to. */
export interface GrepCard {
  account: AccountRef;
  sessionId: string;
  title?: string;
  isArchived: boolean;
}

export interface GrepConversation {
  cliSessionId: string;
  /** The conversation's own working directory, read from its transcript's head. */
  cwd?: string;
  hits: GrepHit[];
  /** Every card, in every account this store holds, that opens this conversation. */
  cards: GrepCard[];
}

export interface GrepOptions {
  /** Only conversations with at least one card in this exact account. */
  accountUuid?: string;
  /** A file older than this (by mtime) is skipped before it is ever opened. */
  since?: number;
  /** Case-insensitive substring of the conversation's own working directory. */
  cwd?: string;
  role?: 'user' | 'assistant';
  /** Stop once this many *conversations* (not hits) have been found. */
  limit?: number;
  /**
   * Test seam: the transcript directories to search, in place of
   * `transcriptRoots(process.env)`. Production never sets this — see
   * `lineageAt`/`lineage` in `engine/lineage.ts` for the same split, kept for
   * the same reason: a test that wants an isolated tree hands it over
   * directly rather than routing through `CLAUDE_CONFIG_DIR` and the real
   * home directory `transcriptRoots` also scans.
   */
  projectsDirs?: string[];
}

/** Characters that make a pattern something other than a literal string to find. */
const REGEX_META = /[.*+?^${}()|[\]\\]/;

/**
 * A regex source rewritten to match the latin1 view a transcript is read in.
 *
 * Every character of a pattern's source above U+007F is not regex syntax —
 * parens, brackets, quantifiers, the `\d`-style escapes are all ASCII — so it
 * is a literal character to find, and it is re-encoded here to the UTF-8 bytes
 * that character would actually take up on disk, one latin1 code unit per
 * byte. An ASCII-only pattern, the ordinary case for a technical term, passes
 * through unchanged.
 */
function byteViewSource(source: string): string {
  let out = '';
  for (const ch of source) {
    if (ch.codePointAt(0)! < 0x80) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, 'utf8')) out += String.fromCharCode(byte);
  }
  return out;
}

interface FileMatch {
  lineNumber: number;
  role: string;
  at?: number;
  text: string;
  index: number;
  length: number;
}

/**
 * One file's matches, or none the moment the coarse whole-file check says so.
 *
 * `isLiteral`/`literalBytes` are computed once per run, not per file — see
 * `grepTranscripts` — because compiling that decision from the pattern is
 * cheap and calling it thousands of times is not worth avoiding by itself, but
 * threading the already-decided answer through is free.
 *
 * The file is read as a `Buffer` first, and the *literal* coarse check —
 * `Buffer#includes` on the raw bytes — runs against that, never against a
 * decoded string. Measured 24/09/2026 over a real corpus, 11202 files, 13.6
 * GB: `readFileSync(file, 'latin1')`, which allocates a JS string the length
 * of every byte, cost 30 s end to end for an absent term; reading the same
 * files as `Buffer`s and only decoding the ones `Buffer#includes` flags cut
 * that to under 15 s, most of it the bare cost of reading 13.6 GB off disk at
 * all (measured separately at ~10.6 s). A pattern carrying real regex syntax
 * still needs a string to run `RegExp#test` against, so that path decodes
 * every file regardless — the literal path is what a plain search term gets.
 */
function scanTranscriptFile(
  file: string,
  isLiteral: boolean,
  literal: string,
  literalBytes: Buffer,
  prefilter: RegExp,
  matcher: RegExp,
  role: string | undefined,
): FileMatch[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    // Vanished between the directory walk and the read, or turned unreadable.
    // Not a match, the same as every other reader here treats a missing file.
    return [];
  }

  let raw: string | undefined;
  if (isLiteral) {
    if (!bytes.includes(literalBytes)) return [];
  } else {
    raw = bytes.toString('latin1');
    if (!prefilter.test(raw)) return [];
  }
  raw ??= bytes.toString('latin1');

  const out: FileMatch[] = [];
  let lineNumber = 0;
  for (const line of raw.split('\n')) {
    lineNumber++;
    if (line === '') continue;
    if (isLiteral ? !line.includes(literal) : !prefilter.test(line)) continue;

    let record: Record<string, unknown> | undefined;
    try {
      record = JSON.parse(Buffer.from(line, 'latin1').toString('utf8')) as Record<string, unknown>;
    } catch {
      // A torn line, or the coarse hit sat inside something that only looked
      // like the start of a record. Skipped, as every malformed line is.
      continue;
    }

    const type = typeof record.type === 'string' ? record.type : undefined;
    if (type !== 'user' && type !== 'assistant') continue;
    if (role !== undefined && type !== role) continue;

    const text = textOf(record.message);
    if (text === undefined) continue;
    const match = matcher.exec(text);
    if (!match) continue;

    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    out.push({
      lineNumber,
      role: type,
      ...(Number.isFinite(at) ? { at } : {}),
      text,
      index: match.index,
      length: match[0].length,
    });
  }
  return out;
}

/** How much of the surrounding text a snippet carries on each side of a match. */
const SNIPPET_RADIUS = 100;

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** A conversation's hits, before its cards have been looked up. */
interface RawGrepMatch {
  cliSessionId: string;
  files: string[];
  hits: GrepHit[];
}

/**
 * Search every transcript this machine's clients hold, grouped by conversation.
 *
 * `pattern`'s own flags are kept except `g`, which `RegExp#exec` and `#test`
 * would otherwise use to carry state across calls that expect a fresh search
 * every time.
 *
 * The transcript search runs to completion *before* a card is ever looked up.
 * Measured 24/09/2026 on a real store: one `scanStore` of every account's
 * cards — needed to answer "the card(s) that open it" — cost over 13 s on its
 * own, against 25,174 cards across 25 accounts, dwarfing the search itself.
 * For a genuinely rare term that matches nothing, paying that cost anyway
 * would be answering "nothing found" slower than finding nothing needs to be
 * — so `scanStore` runs once, only when there is at least one hit to attach a
 * card to, and never at all for the all-too-common empty result.
 */
export function grepTranscripts(
  store: StoreLayout,
  pattern: RegExp,
  options: GrepOptions = {},
): GrepConversation[] {
  const index = indexAllTranscripts(options.projectsDirs ?? transcriptRoots(process.env));

  const flags = pattern.flags.replace('g', '');
  // The Buffer#includes fast path is a byte-for-byte compare, so it only
  // stands in for the regex engine when nothing about the match is
  // case-insensitive — `i` changes what "the same bytes" means and the regex
  // path is what honours it.
  const isLiteral = !REGEX_META.test(pattern.source) && !flags.includes('i');
  const literalSource = isLiteral ? byteViewSource(pattern.source) : '';
  const literalBytes = Buffer.from(literalSource, 'latin1');
  const prefilter = new RegExp(byteViewSource(pattern.source), flags);
  const matcher = new RegExp(pattern.source, flags);

  const raw: RawGrepMatch[] = [];

  for (const [cliSessionId, files] of index) {
    if (options.limit !== undefined && raw.length >= options.limit) break;

    const hits: GrepHit[] = [];
    for (const file of files) {
      if (options.since !== undefined) {
        let mtime: number;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < options.since) continue;
      }

      for (const found of scanTranscriptFile(
        file,
        isLiteral,
        literalSource,
        literalBytes,
        prefilter,
        matcher,
        options.role,
      )) {
        hits.push({
          cliSessionId,
          file,
          lineNumber: found.lineNumber,
          ...(found.at !== undefined ? { at: found.at } : {}),
          role: found.role,
          snippet: snippetAround(found.text, found.index, found.length),
        });
      }
    }
    if (hits.length > 0) raw.push({ cliSessionId, files, hits });
  }

  if (raw.length === 0) return [];

  const cardsByConversation = new Map<string, GrepCard[]>();
  for (const session of scanStore(store)) {
    const id = session.data.cliSessionId;
    if (id === undefined || id === '') continue;
    const list = cardsByConversation.get(id) ?? [];
    list.push({
      account: session.account,
      sessionId: session.data.sessionId,
      ...(session.data.title !== undefined ? { title: session.data.title } : {}),
      isArchived: session.data.isArchived === true,
    });
    cardsByConversation.set(id, list);
  }

  const results: GrepConversation[] = [];
  for (const { cliSessionId, files, hits } of raw) {
    const allCards = cardsByConversation.get(cliSessionId) ?? [];
    if (
      options.accountUuid !== undefined &&
      !allCards.some((card) => card.account.accountUuid === options.accountUuid)
    ) {
      continue;
    }
    const cards =
      options.accountUuid === undefined
        ? allCards
        : allCards.filter((card) => card.account.accountUuid === options.accountUuid);

    const facts = readTranscriptFacts(files[0]!, cliSessionId);
    if (
      options.cwd !== undefined &&
      !(facts.cwd ?? '').toLowerCase().includes(options.cwd.toLowerCase())
    ) {
      continue;
    }

    results.push({
      cliSessionId,
      ...(facts.cwd !== undefined ? { cwd: facts.cwd } : {}),
      hits,
      cards,
    });
  }

  return results;
}
