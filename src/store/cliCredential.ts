import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { writeFileAtomic } from '../util/fsatomic.js';
import { fileExists } from '../util/fs.js';

/**
 * The CLI's credential file — the one foster is now allowed to move.
 *
 * This is a different file from the one `store/credential.ts` reads, and the
 * distinction decides everything downstream, so it is worth stating plainly:
 *
 *  - **The Desktop app's** token lives in its config as a DPAPI-sealed,
 *    AES-GCM blob. Foster reads it, never writes it, and could not usefully
 *    write it: the app holds its account in memory and re-seals on its own
 *    schedule.
 *  - **The CLI's** token lives at `<configDir>/.credentials.json` as plain
 *    JSON of about 1.4 KB. Every `claude` process reads it at birth. Nothing
 *    else binds a config directory to an account — which is exactly why
 *    replacing this file replaces the account the next process runs as, and
 *    why no restart of anything is required for it to take effect.
 *
 * Two properties of the file shape the rules around it:
 *
 *  - **It is live.** When the access token expires the running process renews
 *    it and rewrites the file in place. So a copy taken now is a copy of a
 *    moving thing, and a copy taken long enough ago may name a refresh token
 *    that has since been rotated out of existence.
 *  - **A session already running holds its token in memory.** It stays on the
 *    old account until it exits, and can rewrite this file at any moment while
 *    it does — the race that every design in `switch.ts` has to answer for.
 */

/** The OAuth block, as much of it as matters here. Never rendered, never logged. */
export interface CliOAuth {
  accessToken?: string;
  refreshToken?: string;
  /** Milliseconds since the epoch, as the CLI writes it. */
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * A credential file, held as the bytes that were on disk.
 *
 * The bytes are kept verbatim rather than re-serialised from the parse, because
 * a swap must put back exactly what it took: a field this version of foster does
 * not know about is a field a re-serialisation would silently drop, and dropping
 * an unknown field out of a credential is how you produce a file that parses,
 * looks fine, and does not authenticate.
 *
 * `toJSON` is overridden on purpose. Every `--json` path in this tool serialises
 * whatever it is handed, and a future caller that reaches one of those with a
 * credential in the payload would print a bearer token to a terminal, a pipe, or
 * a log file. Making the object refuse to serialise itself turns that class of
 * mistake into a visible placeholder instead of a leak.
 */
export class CliCredential {
  constructor(
    readonly raw: string,
    readonly oauth: CliOAuth | undefined,
  ) {}

  /** The bearer token, when the file carried one. */
  get accessToken(): string | undefined {
    return this.oauth?.accessToken;
  }

  /** True when the file says the access token has already stopped working. */
  expired(now: number = Date.now()): boolean {
    const at = this.oauth?.expiresAt;
    return typeof at === 'number' && at <= now;
  }

  /** Deliberately unserialisable: see the class comment. */
  toJSON(): string {
    return '[credential]';
  }

  /**
   * The other half of the same guard.
   *
   * `toJSON` covers `JSON.stringify`, which is one of the two ways a value ends
   * up as text in Node and not the one a stray `console.log` uses. That path
   * goes through `util.inspect`, which walks the object's own properties and
   * would print `raw` — a live bearer and refresh token — to the terminal and
   * into anything capturing it. An unhandled rejection carrying this object
   * prints the same way, with no call site to blame.
   */
  [inspect.custom](): string {
    return '[credential]';
  }
}

/** Where a config directory keeps its credential. */
export function credentialPath(configDir: string): string {
  return path.join(configDir, '.credentials.json');
}

/**
 * The credential in a config directory, or nothing when there is none to read.
 *
 * A missing file is the ordinary case — an account that has never been signed
 * into — and so is a file this cannot parse, which happens when a write was torn
 * or when a future CLI changes the shape. Both yield undefined rather than an
 * exception, for the same reason the rest of foster returns undefined from its
 * readers: a credential that cannot be read is a credential that cannot be
 * moved, and that is a refusal to report, not a crash.
 */
export function readCliCredential(configDir: string): CliCredential | undefined {
  let raw: string;
  try {
    raw = readFileSync(credentialPath(configDir), 'utf8');
  } catch {
    return undefined;
  }

  return new CliCredential(raw, parseOAuth(raw));
}

/** The same read, from a file rather than a directory — for vault entries. */
export function parseCredential(raw: string): CliCredential {
  return new CliCredential(raw, parseOAuth(raw));
}

/**
 * Put a credential into a config directory.
 *
 * Atomic, because a `claude` process starting mid-write would read a truncated
 * file and report itself signed out. The bytes go in exactly as they came.
 */
export function writeCliCredential(configDir: string, credential: CliCredential): void {
  writeFileAtomic(credentialPath(configDir), credential.raw);
}

/** Whether a login has left a credential here. Presence only; nothing is opened. */
export function hasCredential(configDir: string): boolean {
  return fileExists(credentialPath(configDir));
}

function parseOAuth(raw: string): CliOAuth | undefined {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: unknown };
    const oauth = parsed.claudeAiOauth;
    return typeof oauth === 'object' && oauth !== null ? (oauth as CliOAuth) : undefined;
  } catch {
    return undefined;
  }
}
