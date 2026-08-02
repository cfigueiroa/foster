import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';

/**
 * Tells the user when a newer release exists.
 *
 * The install URL pins a tag, which is what makes the checksum meaningful — but
 * it also means an install never learns about later releases on its own. This is
 * the counterweight.
 *
 * Deliberately unobtrusive: the result is cached for a day, the request is given
 * a short deadline, and any failure is silent. Being offline, behind a proxy or
 * rate-limited must never slow down or break a tool whose actual work is local.
 */

const REPO = 'cfigueiroa/foster';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2500;

export interface UpdateStatus {
  current: string;
  latest: string;
  outdated: boolean;
  /** Command that installs the newer release, with the tag already substituted. */
  command: string;
}

interface Cache {
  latest: string;
  checkedAt: number;
}

export function cacheFile(): string {
  return path.join(homedir(), '.foster', 'update-check.json');
}

/** Opt out for air-gapped machines, CI, or anyone who simply prefers no network. */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FOSTER_NO_UPDATE_CHECK;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * Compares dotted numeric versions. Anything with a pre-release suffix is treated
 * as older than the same release without one, so a published 1.0.0-rc never
 * prompts someone already on 1.0.0.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const [core = '', pre] = value.replace(/^v/, '').split('-', 2);
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      hasPre: pre !== undefined,
    };
  };
  const a = parse(candidate);
  const b = parse(current);

  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const left = a.parts[i] ?? 0;
    const right = b.parts[i] ?? 0;
    if (left !== right) return left > right;
  }
  return !a.hasPre && b.hasPre;
}

function readCache(file: string): Cache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Cache;
    return typeof parsed?.latest === 'string' && typeof parsed?.checkedAt === 'number'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache), 'utf8');
  } catch {
    // A cache that cannot be written only costs one extra request later.
  }
}

async function fetchLatestTag(): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `foster/${VERSION}` },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? body.tag_name : undefined;
  } catch {
    // Offline, blocked, rate-limited, malformed: none of it is worth a word.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function installCommandFor(tag: string): string {
  return `irm https://raw.githubusercontent.com/${REPO}/${tag}/install.ps1 | iex`;
}

export interface CheckOptions {
  current?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Ignore a fresh cache entry. */
  force?: boolean;
  fetchLatest?: () => Promise<string | undefined>;
}

/** Resolves to undefined whenever the answer is unknown — never throws. */
export async function checkForUpdate(
  options: CheckOptions = {},
): Promise<UpdateStatus | undefined> {
  const {
    current = VERSION,
    file = cacheFile(),
    env = process.env,
    now = Date.now(),
    force = false,
    fetchLatest = fetchLatestTag,
  } = options;

  if (updateChecksDisabled(env)) return undefined;

  const cached = readCache(file);
  let latest =
    !force && cached && now - cached.checkedAt < CACHE_TTL_MS ? cached.latest : undefined;

  if (latest === undefined) {
    // Guarded here rather than only inside the default fetcher: the contract is
    // "never throws", and it must hold for whatever collaborator is supplied.
    let fetched: string | undefined;
    try {
      fetched = await fetchLatest();
    } catch {
      return undefined;
    }
    if (fetched === undefined) return undefined;
    latest = fetched;
    writeCache(file, { latest, checkedAt: now });
  }

  const bare = latest.replace(/^v/, '');
  return {
    current,
    latest: bare,
    outdated: isNewer(bare, current),
    command: installCommandFor(latest.startsWith('v') ? latest : `v${bare}`),
  };
}
