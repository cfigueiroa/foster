import { cpSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { hasCredential } from '../store/cliCredential.js';
import { fileExists, isDirectory, safeReaddir } from '../util/fs.js';

/**
 * Making a config directory that is a working client rather than an empty one.
 *
 * A second account is a second config directory, and `mkdir` plus a login is
 * enough to make one that authenticates. It is not enough to make one that
 * behaves like the directory it was cloned from, and the gap is invisible: the
 * new directory has no settings, no project instructions, and — the one that
 * actually bites — no skills. Sessions run there and quietly have fewer
 * capabilities than sessions run anywhere else, with nothing in any output
 * saying so.
 *
 * So this copies the parts that make a client itself, and is deliberate about
 * three exclusions:
 *
 *  - **The credential is never copied.** Two directories holding one account's
 *    credential is precisely the state the vault's golden rule exists to
 *    prevent: the copy in use renews, the other rots, and the rot is silent. A
 *    seeded directory is signed out, and signing it in is a login.
 *  - **`projects/` is never copied.** That is the conversation history, it is
 *    large, and a second copy of it would be a second set of transcripts for
 *    every other command in foster to find and reason about.
 *  - **`.claude.json` is never copied**, which is a departure from the obvious
 *    move of copying everything that is not a credential. It holds
 *    `oauthAccount` — the cached profile that `foster clients` reads to say who
 *    is signed in where. Copy it and the new directory reports the identity of
 *    the directory it was seeded from, before anyone has logged into it at all.
 *
 * `skills/` is the interesting case and gets a link rather than a copy. Skills
 * are a warehouse, not a setting: the point of them is that every session sees
 * the same ones, and a copy starts drifting the day either side changes. A
 * junction reproduces what was true before the directory existed — one
 * warehouse, no drift — and costs nothing to undo.
 */

/** Copied outright: small, and meant to differ per client once you edit them. */
const COPY_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md'];
const COPY_DIRS = ['agents', 'commands', 'output-styles'];

/** Linked, not copied: one warehouse for every client on the machine. */
const LINK_DIRS = ['skills'];

export interface SeedPlan {
  target: string;
  from: string;
  copies: string[];
  links: string[];
  blockers: string[];
}

export interface SeedOutcome {
  ok: boolean;
  copied: string[];
  linked: string[];
  message: string;
}

/**
 * What seeding would put in a new directory.
 *
 * Refuses a target that already holds a credential above everything else: that
 * is not an empty slot, it is somebody's account, and writing settings over it
 * is a surprise nobody asked for.
 */
export function planSeed(target: string, from: string): SeedPlan {
  const blockers: string[] = [];

  if (!isDirectory(from)) {
    blockers.push(`${from} is not a config directory`);
  }
  if (path.resolve(target) === path.resolve(from)) {
    blockers.push('the new client and the one it is seeded from are the same directory');
  }
  if (hasCredential(target)) {
    blockers.push(`${target} already holds a credential — that is a client, not an empty slot`);
  } else if (isDirectory(target) && safeReaddir(target).length > 0) {
    blockers.push(`${target} is not empty`);
  }

  const copies = [
    ...COPY_FILES.filter((name) => fileExists(path.join(from, name))),
    ...COPY_DIRS.filter((name) => isDirectory(path.join(from, name))),
  ];
  const links = LINK_DIRS.filter((name) => isDirectory(path.join(from, name)));

  return { target, from, copies, links, blockers };
}

/**
 * Create it.
 *
 * Nothing here is atomic across the whole operation, and it does not need to be:
 * every step only ever *adds* to a directory that this command just refused to
 * touch unless it was empty, so a failure half way leaves a partial new client
 * and nothing else — removable with one `rm`, and re-runnable once the cause is
 * fixed.
 */
export function applySeed(plan: SeedPlan): SeedOutcome {
  if (plan.blockers.length > 0) {
    return { ok: false, copied: [], linked: [], message: plan.blockers[0]! };
  }

  mkdirSync(plan.target, { recursive: true });

  const copied: string[] = [];
  for (const name of plan.copies) {
    try {
      cpSync(path.join(plan.from, name), path.join(plan.target, name), { recursive: true });
      copied.push(name);
    } catch (error) {
      return {
        ok: false,
        copied,
        linked: [],
        message: `could not copy ${name}: ${(error as Error).message}`,
      };
    }
  }

  const linked: string[] = [];
  for (const name of plan.links) {
    try {
      symlinkSync(path.join(plan.from, name), path.join(plan.target, name), 'junction');
      linked.push(name);
    } catch (error) {
      return {
        ok: false,
        copied,
        linked,
        message: `could not link ${name}: ${(error as Error).message}`,
      };
    }
  }

  return {
    ok: true,
    copied,
    linked,
    message:
      `${plan.target} is ready, and signed out. ` +
      `Sign in with CLAUDE_CONFIG_DIR set to it, and foster keeps a copy from then on.`,
  };
}
