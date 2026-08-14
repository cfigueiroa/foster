import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AccountSighting, KnownIdentity, ResolvedIdentity } from '../domain/identity.js';
import type { AccountProfile } from '../domain/profile.js';
import type { StoreLayout } from '../domain/types.js';
import { isDirectory, safeReaddir } from '../util/fs.js';
import { readConfig } from '../store/config.js';
import { readProfileFromResponseCache } from './profile.js';

export type CachedIdentity = AccountSighting;
export type { ResolvedIdentity };

/**
 * The human name behind an account UUID, read from the app's own cache.
 *
 * The account's email and display name are not in any file foster is allowed to
 * read outright: the token cache is a credential, and the authoritative copy is
 * behind the API. But the app, having fetched its own profile once, keeps a copy
 * at rest, in the web-origin storage under `Local Storage/` and `IndexedDB/`.
 * That copy is cached page data, the same category as the session files, so it
 * can be read.
 *
 * It is read the crudest way on purpose: every candidate file is loaded as bytes,
 * capped by size, and searched as text. An earlier version parsed the Local
 * Storage LevelDB with the same reader foster uses for the pin list — and that
 * reader, written for one narrow database, corrupted the heap on a real Local
 * Storage table and took the process down with a status no `try` can catch
 * (0xC0000374). Parsing the app's storage means trusting a format that is the
 * app's to change; reading bytes and looking for an email trusts nothing. It
 * finds less — a value that only exists inside a compressed block is missed — but
 * it cannot crash, and a best-effort read that crashes is not best-effort.
 *
 * Two honesties beyond that. It is best-effort: a version that stores the profile
 * differently makes this find nothing rather than something wrong, and the manual
 * `label` is always there. And what this file reads describes only the account
 * signed in now, because web storage belongs to the current session — the other
 * accounts are known through the ledger, which keeps what was seen on the visit
 * that saw it, so a name is available for an account you are not in.
 */

/**
 * Whether a sighting is worth writing down.
 *
 * The ledger is append-only, so a command that records on every run turns a
 * reading command into a source of noise: three `whoami` calls in a row wrote
 * three identical events, and the log is meant to be readable by a person. A
 * sighting earns its line only when it says something the record does not
 * already — the first time an account is seen, or when a field has actually
 * changed, which is a renamed account or a changed plan.
 */
export function worthRecording(
  cached: CachedIdentity | undefined,
  known: AccountSighting | undefined,
): boolean {
  if (!cached?.email && !cached?.name && !cached?.plan && !cached?.profile) return false;
  if (!known) return true;
  return (
    (Boolean(cached.email) && cached.email !== known.email) ||
    (Boolean(cached.name) && cached.name !== known.name) ||
    (Boolean(cached.plan) && cached.plan !== known.plan) ||
    changedProfileField(cached.profile, known.profile)
  );
}

/**
 * Whether any part of the profile now says something the record does not.
 *
 * Needed as its own comparison because the fields that change are exactly the
 * ones not in the label. A subscription going from active to cancelling moves
 * `subscriptionStatus` and `planEndingAt` and nothing else — under a name and
 * plan check alone, the one event worth having in the log is the one that would
 * never be written.
 */
function changedProfileField(fresh: AccountProfile | undefined, known: AccountProfile | undefined) {
  if (!fresh) return false;
  if (!known) return true;
  return Object.entries(fresh).some(
    ([field, value]) => value !== undefined && value !== known[field as keyof AccountProfile],
  );
}

/**
 * The identity to use, from the cache when it says something and from memory
 * when it does not.
 *
 * This is the answer to a source that cannot be read more carefully, only more
 * often. The profile lands in the app's web storage on sign-in and leaves when
 * Chromium compacts that database — the plan was readable here minutes after
 * signing in and absent from every non-credential file an hour later — so a
 * command that only reads gets a different answer depending on when it runs.
 * Reading and *remembering* turns that into a stable one: whatever the cache
 * still offers wins, because it is current, and anything it has forgotten falls
 * back to what foster wrote down when it was there.
 */
export function resolveIdentity(
  cached: CachedIdentity | undefined,
  known: KnownIdentity | undefined,
): ResolvedIdentity | undefined {
  if (!cached && !known) return undefined;

  // The profile merges field by field for the same reason the identity does: a
  // fresh read of the bootstrap response knows the subscription but not the
  // card, and the card was recorded on a visit when the billing screen had been
  // open. Fresh wins per field; remembered fills the gaps.
  const profile =
    cached?.profile || known?.profile ? { ...known?.profile, ...cached?.profile } : undefined;

  const merged: ResolvedIdentity = {
    ...((cached?.email ?? known?.email) ? { email: cached?.email ?? known?.email } : {}),
    ...((cached?.name ?? known?.name) ? { name: cached?.name ?? known?.name } : {}),
    ...((cached?.plan ?? known?.plan) ? { plan: cached?.plan ?? known?.plan } : {}),
    ...(profile ? { profile: profile as AccountProfile } : {}),
  };
  if (!merged.email && !merged.name && !merged.plan && !merged.profile) return undefined;

  // Only called remembered when the cache contributed nothing at all. A partial
  // read — the usual case once the plan has aged out — is still a fresh sighting
  // of what it did find, and saying otherwise would age the whole answer wrongly.
  const fresh = Boolean(cached?.email || cached?.name || cached?.plan || cached?.profile);
  if (!fresh && known) return { ...merged, remembered: true, seenAt: known.seenAt };
  if (known && !cached?.plan && known.plan) return { ...merged, seenAt: known.seenAt };
  return merged;
}

/**
 * An address, shaped strictly enough that noise cannot spell one by accident: no
 * empty label, no doubled dot, and a trailing label that is letters only.
 */
const ADDRESS = String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,24}`;
// The account's address specifically — read out of a field that says it is one,
// and never from a bare address sitting nearby.
//
// The bare pattern was the flaw, and the source is why. These are Snappy-
// compressed LevelDB blocks read as raw bytes, so most of what a pattern scans
// here is not text at all: across one real store, 350 of 676 matches for a plain
// address were decompression noise — `3@T.tf`, `v@I.rI`, `6@ai.television.ses`.
// One of those was recorded as an account's email and, the ledger being what it
// is, stayed. Requiring the key, and both quotes around the value, asks for
// something noise does not accidentally produce; distance alone never could,
// because the noise is nearest of all.
const EMAIL = new RegExp(
  String.raw`"(?:email|email_address|emailAddress|primary_email|primaryEmail|account_email|accountEmail)"\s*:\s*"(${ADDRESS})"`,
  'i',
);
// A person's name field specifically — not a bare `"name"`, which the app's cache
// attaches to organizations, workspaces and a dozen other things, and which is
// what once put a workspace called "Sales" where the account holder belonged.
const NAME = /"(?:full_name|fullName|display_name|displayName)"\s*:\s*"([^"]{1,80})"/;
// The plan is stored under one of several names and with an unpredictable value —
// "max", "claude_max", "default_claude_max_20x" — so the field is matched loosely
// and the tier is read out of the value by keyword rather than trusted verbatim.
const PLAN =
  /"(?:subscription_?type|subscriptionType|plan|billing_?type|membership|tier|rate_?limit_?tier|rateLimitTier)"\s*:\s*"([^"]{1,60})"/i;

/**
 * The account's identity from cache, or undefined when nothing can be tied to it.
 *
 * Two anchors, chosen for what each reliably sits beside. The email is tied to
 * the account's own UUID — the profile keeps them in one small object, while a
 * stranger's address quoted in a conversation is off in another record — and it
 * must additionally be written down as an email, under a field that names it.
 * Proximity alone was not enough: nearness is a claim about text, and half of
 * what these files hold is compressed bytes read as text, which is nearer to
 * everything than the profile ever is. The name
 * and plan are then tied to the *email*, not the UUID: the cache is live app
 * state, thick with `name` fields for workspaces and organizations near the
 * account id, and only the email marks the one object that is actually the
 * person's. Anchoring the name to the id once labelled this account with a
 * workspace called "Sales"; anchoring it to the email does not.
 */
export function readIdentityFromCache(
  store: StoreLayout,
  accountUuid = readConfig(store).lastKnownAccountUuid,
): CachedIdentity | undefined {
  if (!accountUuid) return undefined;

  // The response cache first, because it holds the profile itself: an object
  // that names the account and carries its own email, so nothing is inferred
  // from proximity and the tier arrives whole rather than as the word "Max".
  // The search below is the fallback it was always meant to be — for a version
  // that keeps the profile somewhere else, or a cache already evicted.
  const profile = readProfileFromResponseCache(store, accountUuid);
  if (profile) {
    return {
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.name ? { name: profile.name } : {}),
      ...planFrom(profile),
      profile,
    };
  }

  const needle = accountUuid.toLowerCase();
  const found: CachedIdentity = {};

  for (const text of readCandidateFiles(store)) {
    const uuids = occurrences(text, needle, true);
    const email = found.email ?? nearest(text, uuids, EMAIL, (m) => m[1], MAX_DISTANCE);
    if (email) found.email = email;

    // The profile object is the one that holds the account's email. Name and plan
    // are read from beside it — a tight reach for the name, which shares the
    // object, a looser one for the plan, which can sit in a sibling. With no email
    // in this file there is no trustworthy anchor, so neither is guessed from the
    // id alone.
    const anchor = email ? occurrences(text, email) : [];
    if (anchor.length > 0) {
      found.name ??= nearest(text, anchor, NAME, (m) => m[1]?.trim(), NAME_DISTANCE);
      found.plan ??= nearest(text, anchor, PLAN, (m) => planName(m[1]), PLAN_DISTANCE);
    }
    if (found.email && found.name && found.plan) return found;
  }

  return found.email || found.name || found.plan ? found : undefined;
}

/**
 * The tier from a profile, preferring the rate limit tier because it is the only
 * field that distinguishes the two sizes of Max. The organization's type is the
 * fallback, and says "claude_max" without saying which.
 */
function planFrom(profile: AccountProfile): { plan?: string } {
  const plan = planName(profile.rateLimitTier) ?? planName(profile.organizationType);
  return plan ? { plan } : {};
}

/**
 * The subscription tier as the app would name it, read out of a raw plan value.
 *
 * The stored string is not the label — it is "max", or "default_claude_max_20x",
 * or "claude_pro" — so the tier is recognised by the word inside it rather than
 * shown as-is. An unrecognised value yields nothing, because a mangled tier on a
 * label is worse than no tier.
 */
export function planName(raw: string | undefined): string | undefined {
  const value = raw?.toLowerCase() ?? '';
  const tier = value.includes('enterprise')
    ? 'Enterprise'
    : value.includes('team')
      ? 'Team'
      : value.includes('max')
        ? 'Max'
        : value.includes('pro')
          ? 'Pro'
          : value.includes('free')
            ? 'Free'
            : undefined;
  if (!tier) return undefined;

  // Max is sold in two sizes and they are different subscriptions at different
  // prices. The raw tier is the only thing on this machine that says which —
  // `default_claude_max_20x` against `default_claude_max_5x` — so collapsing
  // both to "Max" threw away the one detail someone comparing two accounts
  // actually needs. Kept only for Max, because no other tier has a multiple.
  const multiple = /(\d+)\s*x/.exec(value);
  return tier === 'Max' && multiple ? `Max ${multiple[1]}x` : tier;
}

/**
 * The text of every file worth searching, each decoded a few plausible ways.
 *
 * Both stores are read the same crude way — bytes, size-capped — because neither
 * is parsed. Local Storage is small and holds the display name; the IndexedDB
 * blob tree holds the large values, the email among them, as plain files. The
 * IndexedDB LevelDB itself is skipped: it is the conversation database, big and
 * the source of the crash, and nothing here needs it.
 */
function* readCandidateFiles(store: StoreLayout): Generator<string> {
  const localStorage = path.join(store.root, 'Local Storage', 'leveldb');
  for (const name of safeReaddir(localStorage)) {
    if (name.endsWith('.ldb') || name.endsWith('.log')) {
      yield* readFileText(path.join(localStorage, name));
    }
  }

  yield* walkBlobs(path.join(store.root, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob'), {
    files: MAX_BLOB_FILES,
  });
}

/** The blob tree, walked breadth-unaware but bounded, each file read as text. */
function* walkBlobs(root: string, budget: { files: number }): Generator<string> {
  for (const entry of safeReaddir(root)) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry);
    try {
      if (isDirectory(full)) {
        yield* walkBlobs(full, budget);
        continue;
      }
    } catch {
      continue;
    }
    budget.files -= 1;
    yield* readFileText(full);
  }
}

/**
 * A file's bytes, decoded to the strings they might be — or nothing.
 *
 * Size-capped before it is opened: a file past the limit is a conversation store
 * or a document, never a profile record, and reading it is the memory the crude
 * approach exists to avoid spending. The bytes are offered as UTF-8 and as
 * UTF-16LE because Chromium stores strings both ways; a wrong decoding simply
 * fails to match the patterns.
 */
function* readFileText(file: string): Generator<string> {
  try {
    if (fileSize(file) > MAX_FILE_BYTES) return;
    trace(`${path.basename(file)} (${fileSize(file)} bytes)`);
    const bytes = readFileSync(file);
    yield bytes.toString('latin1');
    yield bytes.toString('utf16le');
  } catch {
    // A file that vanished, is locked, or cannot be read is skipped; the search
    // across the rest is what matters, and its failure is not an error.
  }
}

/**
 * The match closest to one of the anchor strings, if it is close enough.
 *
 * Closeness is the whole safeguard. What is being read sits beside its anchor in
 * one small object; the same field for something else — a workspace's name, a
 * stranger's address — is in another record, further away. Taking the match
 * nearest an anchor, and only within a bound, keeps the wrong one from winning in
 * a way a plain "somewhere in the same file" cannot. The anchors are the
 * positions of a string already located: the account id for the email, the email
 * for the name and plan.
 */
function nearest(
  text: string,
  anchors: { at: number; length: number }[],
  pattern: RegExp,
  pick: (match: RegExpExecArray) => string | undefined,
  maxDistance: number,
): string | undefined {
  if (anchors.length === 0) return undefined;

  const source = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
  );
  let best: { value: string; distance: number } | undefined;

  for (let match = source.exec(text); match; match = source.exec(text)) {
    const value = pick(match);
    if (!value) continue;
    // Between spans, not between start points: an anchor can be many characters
    // long, so a field beside it but after it starts far from its beginning while
    // a neighbour before it starts near — measuring start-to-start would prefer
    // the neighbour. The gap between the two spans is what "beside" really means.
    const start = match.index;
    const end = match.index + match[0].length;
    const distance = Math.min(...anchors.map((a) => gap(a.at, a.at + a.length, start, end)));
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { value, distance };
    }
  }

  return best?.value;
}

/** The number of characters between two spans, or 0 when they touch or overlap. */
function gap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, bStart - aEnd, aStart - bEnd);
}

/** Every occurrence of a substring, as anchor spans. Case-insensitive when asked. */
function occurrences(text: string, sub: string, fold = false): { at: number; length: number }[] {
  const haystack = fold ? text.toLowerCase() : text;
  const needle = fold ? sub.toLowerCase() : sub;
  const out: { at: number; length: number }[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    out.push({ at, length: needle.length });
  }
  return out;
}

/**
 * How far from the account id its email may be. A profile object — id, email,
 * name and a few fields — is a few hundred characters, so an email beyond this is
 * in another record and not the account's.
 */
const MAX_DISTANCE = 600;

/** How far from the email its owner's name may be. They share one small object. */
const NAME_DISTANCE = 300;

/**
 * How far from the email the plan may be. Much looser than the name, because the
 * plan lives on the account's organization, and the organization's settings — a
 * long block of feature flags — sit between the email and the `rate_limit_tier`
 * that names the tier. Measured at ~2100 characters on a real profile; the reach
 * clears that with headroom, and is still anchored to the email, so a second
 * organization's tier stays further away than the account's own.
 */
const PLAN_DISTANCE = 5000;

/**
 * The largest file this will read. Nothing being looked for lives in a big file;
 * a big file is a conversation store or a stored document, and loading one is the
 * cost — in memory, and in the crash that motivated all of this — that reading
 * bytes crudely is meant to avoid.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** How many blob files the walk will look at before giving up — a bound, not a target. */
const MAX_BLOB_FILES = 4000;

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * A breadcrumb before each file is opened, printed only when FOSTER_DEBUG is set.
 *
 * The read can be killed in a way no `try` catches — a heap fault, an
 * out-of-memory abort, a security tool that mistakes reading browser storage for
 * theft — and a crash that leaves no error is diagnosable only by what was about
 * to be read. The last line this prints before silence names the file that did it.
 */
function trace(message: string): void {
  if (process.env.FOSTER_DEBUG) process.stderr.write(`[foster] ${message}\n`);
}

/**
 * A one-line label from a cached identity, or undefined when there is nothing.
 *
 * Name and email together when both are known — "John — john@…" is what tells
 * two accounts apart at a glance — and whichever one is present otherwise.
 */
export function identityLabel(identity: CachedIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  // Whatever is known, joined by the middle dot the app itself uses between an
  // account's name and its plan. Name first, then email, then plan as a trailing
  // tag; each is dropped when absent, so a partial read still reads cleanly.
  const parts = [identity.name, identity.email, identity.plan].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
