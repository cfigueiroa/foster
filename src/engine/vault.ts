import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { comparablePath } from '../domain/paths.js';
import { parseCredential, type CliCredential } from '../store/cliCredential.js';
import { safeReaddir } from '../util/fs.js';
import { appendSynced } from './fsatomic.js';

/**
 * Every credential foster has ever seen, kept.
 *
 * Foster spent most of its life refusing to hold a credential at all, and this
 * file is the deliberate end of that. It earns its place by making one thing
 * possible — changing which account a config directory is signed in as, without
 * a logout that throws away a working credential — and the shape it takes is
 * decided by two facts that took a while to see clearly.
 *
 * **The identity of a credential is a pair, not an account.** The same account
 * signed into two config directories has two independent token families, from
 * two separate logins, whose refresh tokens rotate separately. Keying by account
 * alone conflates them, and conflating them means installing one surface's
 * credential into another — which is not a hypothetical: the house whose design
 * this borrows from wrote "each folder uses its own token family, from its own
 * login" into its vault's README, and an earlier version of this module would
 * have overwritten one with the other on a single `guard`. So the key is
 * `(surface, account)`, and the surface is a config directory.
 *
 * **Nothing is ever replaced or removed.** The obvious design is positional —
 * one live copy per account, a swap trades one for the other — and it is the one
 * this module used to implement, because a refresh token can be rotated on every
 * renewal and a copy left on a shelf quietly stops working. But positional means
 * destructive: every swap deletes a credential, and a credential deleted is a
 * thing no later feature can reach and no operator can fall back on. So the
 * shelf is append-only, in the same idiom as foster's ledger: one JSONL file per
 * `(surface, account)`, newest line wins, and every version that came before
 * stays legible underneath it.
 *
 * That trade is real and worth naming rather than burying. Keeping history means
 * more credentials at rest than the minimum, kept for ever, and a stale entry
 * can be handed back and fail to authenticate. Against that: nothing foster does
 * can ever make a credential unrecoverable, staleness is detectable (every entry
 * carries when it was taken, and a switch verifies before it commits) while
 * deletion is not, and an append-only file is trivially readable from any shell
 * that might come to share it.
 *
 * Nothing here is encrypted beyond what the filesystem does. That is not an
 * oversight: the file this copies is sitting unencrypted in the config directory
 * already, so encrypting the copy would protect the shelf and not the shop while
 * adding a key foster would then have to keep somewhere. What the vault does
 * promise is narrower and true — it lives under the user's own profile, is never
 * written to the repository, never logged, never printed and never sent
 * anywhere, and every entry names whose it is so nothing has to be opened to
 * find out.
 */

/** A credential in the vault, described without opening the credential itself. */
export interface VaultEntry {
  /** The config directory this token family belongs to. */
  surface: string;
  /** Who it belongs to — the identity that was verified when it was taken. */
  email: string;
  /** The account's stable id, when the API had been asked. Emails are labels; this is not. */
  accountUuid?: string;
  /** When foster took this copy. */
  savedAt: number;
  /** When the access token inside stops working, when the file said. */
  expiresAt?: number;
  /** How many versions are on file for this pair, this one included. */
  versions: number;
  file: string;
}

/**
 * One line of the history.
 *
 * The credential is carried as an opaque string rather than a nested object so
 * that it round-trips byte for byte — the same reason `CliCredential` keeps its
 * raw form, and the reason a field this version does not know about survives a
 * trip through the vault. The identity sits beside it, which is what makes the
 * shelf listable without opening a credential, and what lets a wrong filename be
 * caught rather than believed.
 */
interface VaultRecord {
  v: 1;
  surface: string;
  email: string;
  accountUuid?: string;
  savedAt: number;
  expiresAt?: number;
  credential: string;
}

/** Foster's own directory, the one the ledger already lives in. */
export function vaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.FOSTER_HOME ?? path.join(homedir(), '.foster');
  return path.join(base, 'vault');
}

/**
 * A filename fragment that is a filename on Windows.
 *
 * The readable half is lossy — every run of characters a filename cannot carry
 * collapses to one dash — which on its own makes two distinct inputs collide
 * whenever they differ only in what got stripped: `josé@example.test` and
 * `josç@example.test` both reduce to `jos-example.test`. That is not a cosmetic
 * clash when the name decides which credential you get back.
 *
 * So a digest of the input follows the readable part, which restores the one
 * property a name here has to have. The name is still never trusted: the
 * identity of a record is the `surface` and `email` inside it, and a record
 * whose contents disagree with its path is reported by its contents.
 */
export function slugFor(email: string): string {
  // An address is case-insensitive in every way that matters here, so the key
  // folds case: `Alice@x` and `alice@x` are one account and must be one file.
  return fragment(email.toLowerCase());
}

/**
 * A surface's fragment, folded exactly as far as the filesystem folds.
 *
 * Two spellings of one config directory are one surface — a different
 * capitalisation on Windows, a trailing separator — and giving them separate
 * histories would split one account's versions across two files that each look
 * complete. But that is a Windows truth, not a universal one: on a
 * case-sensitive filesystem `~/.claude` and `~/.Claude` are two directories,
 * and folding them together would merge two clients' credentials into one
 * history.
 *
 * So the key is `comparablePath`, which folds case only where the filesystem
 * does — and, unlike `slugFor`, nothing lowercases it afterwards. An earlier
 * version routed this through `slugFor` and inherited its `toLowerCase`, which
 * folded every platform down to the Windows answer.
 */
export function surfaceSlug(configDir: string): string {
  return fragment(comparablePath(configDir));
}

/**
 * The shared shape: a readable prefix and a digest of the key itself.
 *
 * The digest is taken over the key as given, not over the lowercased readable
 * form, so that two keys this function is meant to keep apart stay apart even
 * when their readable halves are identical.
 */
function fragment(key: string): string {
  const readable = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${readable.length > 0 ? readable : 'unknown'}-${digest}`;
}

function historyFile(root: string, surface: string, email: string): string {
  return path.join(root, surfaceSlug(surface), `${slugFor(email)}.jsonl`);
}

/**
 * Whether the vault has been pointed somewhere it should not hold credentials.
 *
 * `FOSTER_HOME` predates the vault: it was a knob for relocating a ledger, which
 * is bookkeeping, and it is now also a knob for relocating unencrypted bearer
 * tokens. Pointed at a synced folder or a share, it puts them where a sync
 * client or another account can read them. Foster cannot know an arbitrary
 * path's ACLs, but it can tell that a directory is not under the profile whose
 * protection the README claims — so it says so, rather than letting the promise
 * quietly stop being true.
 */
export function vaultOutsideProfile(root: string, home: string = homedir()): boolean {
  const relative = path.relative(home, root);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * Add a credential to a pair's history, unless it is the one already on top.
 *
 * The deduplication is what makes this safe to call from anything: `guard` on a
 * timer, a switch, a status screen that happens to have verified an identity.
 * A token that has not rotated since the last look appends nothing, so the file
 * grows once per real change rather than once per invocation.
 *
 * Appending rather than rewriting is deliberate beyond the obvious. A rewrite
 * has a window in which the file holds neither the old content nor the new;
 * an append that is torn by a crash costs the last line, which the reader
 * already skips, and leaves every earlier version untouched.
 */
export function rememberCredential(
  root: string,
  surface: string,
  email: string,
  credential: CliCredential,
  opts: { accountUuid?: string; now?: number } = {},
): { entry: VaultEntry; appended: boolean } {
  const file = historyFile(root, surface, email);
  const history = readHistory(file);
  const newest = history[history.length - 1];

  if (newest?.credential === credential.raw) {
    return { entry: entryFrom(newest, history.length, file), appended: false };
  }

  const expiresAt = credential.oauth?.expiresAt;
  const record: VaultRecord = {
    v: 1,
    surface,
    email,
    ...(opts.accountUuid ? { accountUuid: opts.accountUuid } : {}),
    savedAt: opts.now ?? Date.now(),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    credential: credential.raw,
  };

  // 0o700 rather than the default: on the POSIX side it is the difference
  // between a credential other users can read and one they cannot. Windows
  // derives the ACL from the parent instead, so this is a floor and not the
  // whole answer — which is why `vaultOutsideProfile` exists to check that the
  // parent is one worth inheriting from.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendSynced(file, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));

  return { entry: entryFrom(record, history.length + 1, file), appended: true };
}

/**
 * The most recent credential foster holds for a pair.
 *
 * The surface and email inside the record are checked against the ones asked
 * for. A file whose newest record names someone else is not returned: the path
 * is a convenience, the record is the record, and quietly handing back the wrong
 * account's credential is the one mistake in this module that could sign someone
 * into an account they did not ask for.
 */
export function currentCredential(
  root: string,
  surface: string,
  email: string,
): { entry: VaultEntry; credential: CliCredential } | undefined {
  const file = historyFile(root, surface, email);
  const history = readHistory(file);
  const newest = history[history.length - 1];
  if (!newest) return undefined;
  if (newest.email.toLowerCase() !== email.toLowerCase()) return undefined;
  if (comparablePath(newest.surface) !== comparablePath(surface)) return undefined;

  return {
    entry: entryFrom(newest, history.length, file),
    credential: parseCredential(newest.credential),
  };
}

/** Every version foster holds for a pair, oldest first. Credentials stay closed. */
export function versionsOf(root: string, surface: string, email: string): VaultEntry[] {
  const file = historyFile(root, surface, email);
  const history = readHistory(file);
  return history.map((record, index) => entryFrom(record, index + 1, file));
}

/** The newest entry for every pair the vault holds, newest first. */
export function listAll(root: string): VaultEntry[] {
  const entries: VaultEntry[] = [];

  for (const surfaceDir of safeReaddir(root)) {
    const dir = path.join(root, surfaceDir);
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const history = readHistory(file);
      const newest = history[history.length - 1];
      if (newest) entries.push(entryFrom(newest, history.length, file));
    }
  }

  return entries.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * What a record says about itself, without the credential.
 *
 * One conversion, used by every path that produces an entry, so that "what a
 * listing shows" cannot drift from "what a read returns" — and so the rule that
 * matters, that the credential never travels in an entry, is stated once.
 */
function entryFrom(record: VaultRecord, versions: number, file: string): VaultEntry {
  return {
    surface: record.surface,
    email: record.email,
    ...(record.accountUuid ? { accountUuid: record.accountUuid } : {}),
    savedAt: record.savedAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    versions,
    file,
  };
}

/**
 * Every readable record in a history, oldest first.
 *
 * A line that will not parse is skipped rather than fatal — the last one can be
 * torn by a crash mid-append, and the versions before it are still perfectly
 * good. A record carrying a version this build does not know is skipped too,
 * for the opposite reason: guessing at the shape of a credential store is how
 * you hand back something that is not what it claims to be.
 */
function readHistory(file: string): VaultRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const records: VaultRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<VaultRecord>;
      if (parsed.v !== 1) continue;
      if (typeof parsed.email !== 'string' || typeof parsed.credential !== 'string') continue;
      if (typeof parsed.surface !== 'string') continue;
      records.push({
        v: 1,
        surface: parsed.surface,
        email: parsed.email,
        ...(parsed.accountUuid ? { accountUuid: parsed.accountUuid } : {}),
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
        ...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
        credential: parsed.credential,
      });
    } catch {
      // A torn final line must not make the rest of the history unreadable.
    }
  }
  return records;
}
