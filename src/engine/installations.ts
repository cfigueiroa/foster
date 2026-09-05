import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { candidateStoreRoots, comparablePath, samePath } from '../domain/paths.js';
import { configDirCandidates } from '../store/configDirs.js';
import { fileExists, isDirectory, safeReaddir } from '../util/fs.js';
import type { LedgerEvent } from '../ledger/types.js';

/**
 * A Desktop *profile* — a userData root the app has not been told to share with
 * any other account. `profile` is the CLI's word for it; the module is called
 * `installations` because `profile` already names something else in the domain
 * (`AccountProfile`, the cached identity a config directory claims).
 *
 * Registering one is bookkeeping, not provisioning. What makes a directory a
 * working profile is Claude Desktop running with `--user-data-dir` pointed at
 * it once — the app populates everything from `config.json` to `Local State`
 * on that first launch. `profile new` only reserves the root: a plain mkdir,
 * nothing written inside it, because the one file foster could put there would
 * be wrong the moment the app wrote its own. `profile register` is the other
 * half — naming a root that already went through that first launch, so a
 * profile started outside foster is not stuck typing its path by hand forever.
 *
 * Both refuse the same handful of paths, for the same underlying reason: a
 * profile's credential cache is sealed by DPAPI to one Windows user on one
 * machine (`src/store/credential.ts`), so it is never copied, synced, restored
 * from backup, or moved between users — doing any of that just signs it out in
 * silence. A path that could tempt someone into copying one (a network share),
 * or that already belongs to something else (the installed app, a CLI config
 * directory, somebody's unrelated folder), is refused up front instead of
 * discovered later as a profile that quietly stopped working.
 */

/** Profile names double as `wt` tab titles and `pwsh -Command` arguments — see `rescue.ts`. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Files and directories the app itself creates — their presence is the only proof a directory has actually been launched into, rather than merely made. */
function hasStoreMarks(root: string): boolean {
  return (
    fileExists(path.join(root, 'config.json')) ||
    fileExists(path.join(root, 'Local State')) ||
    isDirectory(path.join(root, 'claude-code-sessions'))
  );
}

function isUncPath(target: string): boolean {
  return /^\\\\/.test(target) || /^\/\//.test(target);
}

/** Whether `candidate` is `ancestor` itself, or sits somewhere inside it. */
function isSameOrInside(candidate: string, ancestor: string): boolean {
  const a = comparablePath(candidate);
  const b = comparablePath(ancestor);
  return a === b || a.startsWith(b + path.sep);
}

/** MSIX unpacks the installed app under `...\Packages\Claude<hash>\...` — see `domain/paths.ts`. */
function isUnderPackagedClaude(root: string): boolean {
  return /[\\/]packages[\\/]claude[^\\/]*[\\/]/i.test(`${root}${path.sep}`);
}

/**
 * Every name currently registered, folded from the ledger the way
 * `ledger/project.ts` folds everything else: later events win, and a
 * `profile_forgotten` removes the name rather than leaving a tombstone,
 * because forgetting is meant to free the name for reuse.
 */
function registeredProfiles(events: LedgerEvent[]): Map<string, string> {
  const registered = new Map<string, string>();
  for (const event of events) {
    if (event.kind === 'profile_registered') registered.set(event.name, path.resolve(event.root));
    else if (event.kind === 'profile_forgotten') registered.delete(event.name);
  }
  return registered;
}

export interface PlanProfileOptions {
  /** The ledger's own events, so a name or root already claimed is caught before anything is written. */
  events: LedgerEvent[];
  env?: NodeJS.ProcessEnv;
  /**
   * True for `register`, which adopts a directory the app has already run in;
   * false (the default) is `new`, which expects an empty slot for the app to
   * populate on its own first launch.
   */
  adopt?: boolean;
}

export interface ProfilePlan {
  root: string;
  name: string;
  /** Whether the target directory already exists, before anything runs. */
  exists: boolean;
  adopt: boolean;
  blockers: string[];
}

/**
 * What registering a profile at `targetPath` under `name` would do, or why it
 * refuses to. No filesystem write happens here — every check reads only.
 */
export function planProfile(
  targetPath: string,
  name: string,
  opts: PlanProfileOptions,
): ProfilePlan {
  const env = opts.env ?? process.env;
  const adopt = opts.adopt ?? false;
  const root = path.resolve(targetPath);
  const blockers: string[] = [];

  if (!NAME_PATTERN.test(name)) {
    blockers.push(
      `"${name}" is not a valid profile name — lowercase letters, digits and hyphens, starting ` +
        'with a letter or digit, up to 32 characters (it ends up in terminal tab titles).',
    );
  }

  const clash = registeredProfiles(opts.events).get(name);
  if (clash !== undefined && !samePath(clash, root)) {
    blockers.push(`"${name}" is already registered to ${clash}.`);
  }

  const unc = isUncPath(targetPath);
  if (unc) {
    blockers.push(
      `${targetPath} is a network path. The credential cache is sealed by DPAPI to one Windows ` +
        'user on one machine, and a share only invites copying a profile that cannot survive it.',
    );
  }

  if (
    candidateStoreRoots(env).some((known) => isSameOrInside(root, known)) ||
    isUnderPackagedClaude(root)
  ) {
    blockers.push(
      `${root} sits inside a Claude Desktop installation root — a profile needs a userData ` +
        'directory of its own.',
    );
  }

  if (configDirCandidates(env).some((dir) => isSameOrInside(root, dir))) {
    blockers.push(`${root} is a CLI config directory (or sits inside one), not a Desktop profile.`);
  }

  // A UNC target is refused outright above; stat-ing it would still be a real
  // network round trip on Windows (a nonexistent server takes seconds to fail
  // over), so it is skipped rather than paid for a directory that is refused
  // either way.
  const exists = !unc && isDirectory(root);
  const marks = exists && hasStoreMarks(root);

  if (adopt) {
    if (!exists) {
      blockers.push(
        `${root} does not exist — register adopts a directory the app has already run in.`,
      );
    } else if (!marks) {
      blockers.push(
        `${root} has none of the marks of a Claude Desktop profile (config.json, Local State, ` +
          'claude-code-sessions) — there is nothing here to register.',
      );
    }
  } else if (exists && safeReaddir(root).length > 0 && !marks) {
    blockers.push(
      `${root} exists, is not empty, and has none of the marks of a Claude Desktop profile — ` +
        "that looks like somebody else's folder, not an empty slot.",
    );
  }

  return { root, name, exists, adopt, blockers };
}

export interface ProfileOutcome {
  ok: boolean;
  message: string;
}

/**
 * Create (or adopt) it.
 *
 * For `new` the only write is the directory itself — recursive `mkdir`, and
 * nothing put inside it, because Claude Desktop populates a profile on its own
 * first launch there (README: "What about switching accounts?"). For
 * `register` there is nothing to write at all: the directory already exists,
 * by the time `planProfile` stopped objecting to it.
 */
export function applyProfile(plan: ProfilePlan): ProfileOutcome {
  if (plan.blockers.length > 0) {
    return { ok: false, message: plan.blockers[0]! };
  }

  if (!plan.adopt) {
    mkdirSync(plan.root, { recursive: true });
  }

  return {
    ok: true,
    message: plan.adopt
      ? `${plan.root} is registered as "${plan.name}".`
      : `${plan.root} is ready as "${plan.name}", empty until Claude Desktop first launches there.`,
  };
}

export interface ForgetPlan {
  name: string;
  /** The root the name pointed at, when it was registered. */
  root?: string;
  blockers: string[];
}

/**
 * What forgetting `name` would do. Forgetting only ever removes the ledger's
 * memory of the name — the directory it pointed at is never touched, and
 * nothing here or in `applyProfile` deletes it.
 */
export function planForget(name: string, events: LedgerEvent[]): ForgetPlan {
  const root = registeredProfiles(events).get(name);
  const blockers: string[] = [];
  if (root === undefined) {
    blockers.push(`"${name}" is not a registered profile.`);
  }
  return { name, root, blockers };
}
