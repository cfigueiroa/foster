import { homedir } from 'node:os';
import path from 'node:path';
import { samePath } from '../domain/paths.js';
import {
  hasCredential,
  readCliCredential,
  writeCliCredential,
  type CliCredential,
} from '../store/cliCredential.js';
import { readClientIdentity } from '../store/clients.js';
import {
  liveSessions,
  writerAlive,
  type LiveCliSession,
  type WriterCheck,
} from '../store/liveSessions.js';
import type { OAuthToken } from '../store/credential.js';
import { fetchLiveProfile } from './anthropicApi.js';
import { currentCredential, rememberCredential } from './vault.js';

/**
 * Changing which account a config directory is signed in as.
 *
 * This is the write foster refused to make for its whole life, so the reasoning
 * is worth having in front of the code rather than in a commit message.
 *
 * The refusal was never squeamishness about the file. It was that foster had no
 * business holding a credential, and everything it did could be done without
 * one. That stopped being true the moment the tool grew a second account: the
 * question "which of my accounts still has quota" is answerable, the answer is
 * useless if acting on it means a logout that destroys a working credential,
 * and no other tool on the machine is positioned to know both halves.
 *
 * What the widened rule is, exactly:
 *
 *  - Foster **copies** credentials into its own vault and installs them back out
 *    of it. It never mints one, never refreshes one, never removes one, and
 *    never sends one anywhere except as a bearer header to `api.anthropic.com`
 *    to ask who it belongs to.
 *  - Foster **never logs in**. OAuth is interactive and stays the user's. A
 *    credential foster cannot verify is a credential it puts back, with a plain
 *    request for a fresh login — never a silent shrug that leaves a directory
 *    signed in as nobody.
 *  - Every switch is **reversible by the command next to it**, and stays
 *    reversible: the outgoing credential is recorded before the incoming one is
 *    written, and nothing in this module ever takes a recording away.
 *
 * The hazard that remains, stated rather than papered over: a `claude` process
 * that is already running holds its token in memory and rewrites this file when
 * it renews. Switch under one and the old account can come back minutes later,
 * over the top of the new one. Foster cannot stop that — no lock exists to take
 * — so it does the two things it can. It names the processes that could do it,
 * with pids, before writing. And the account that gets overwritten is still in
 * its own history, so the damage is a command to undo rather than a login.
 */

/** A process that could rewrite the credential out from under a switch. */
export interface Clobberer {
  pid: number;
  cwd?: string;
}

export interface Identity {
  email?: string;
  /** The account's stable id, when the API answered. Emails are labels; this is not. */
  accountUuid?: string;
  /** True when the API answered; false when this is a cached or absent answer. */
  verified: boolean;
  /** Why it is not verified — offline, no credential, expired token. */
  note?: string;
}

export interface SwitchPlan {
  configDir: string;
  /** Who the directory is signed in as now. */
  from: Identity;
  /** Who it would be signed in as after. */
  to: string;
  /** When the credential that would be installed was taken. */
  takenAt?: number;
  /** How many versions the vault holds for this pair — the rest stay after a switch. */
  versions: number;
  /** True when the incoming credential's own clock says it is already expired. */
  incomingExpired: boolean;
  /** Processes registered in this directory that could overwrite the result. */
  clobberers: Clobberer[];
  /** Reasons this cannot proceed. Empty means it can. */
  blockers: string[];
}

export interface SwitchOutcome {
  ok: boolean;
  /** Who the directory ended up signed in as, verified against the API. */
  landed?: string;
  /** True when the previous credential was put back after a failed check. */
  rolledBack: boolean;
  message: string;
}

/**
 * Convert a CLI credential into the shape the API client expects.
 *
 * The unit differs and the difference is silent: the CLI writes `expiresAt` in
 * milliseconds, and `OAuthToken.expiresAt` is seconds, because it came from the
 * Desktop cache which uses seconds. Passing milliseconds through unconverted
 * makes every token look valid until the year 57000, so the freshness check that
 * exists to avoid a pointless round trip would never fire. Converting here keeps
 * the mistake in one place.
 */
export function asOAuthToken(credential: CliCredential): OAuthToken | undefined {
  const token = credential.accessToken;
  if (!token) return undefined;

  const expiresAtMs = credential.oauth?.expiresAt;
  return {
    token,
    ...(typeof expiresAtMs === 'number' ? { expiresAt: Math.floor(expiresAtMs / 1000) } : {}),
  };
}

/**
 * Who a config directory is signed in as.
 *
 * Two sources, in order of authority. The API answers for the token itself and
 * cannot be stale, which is what makes it the one that decides a switch worked.
 * The CLI's own cached profile answers offline, and is what the rest of foster
 * already reads — but it is written by the CLI, so immediately after a swap it
 * still names the account that just left. Both are reported, and which one spoke
 * is never hidden: `verified` is the difference between "the API says this" and
 * "a file on disk said this at some point".
 */
export async function identify(
  configDir: string,
  opts: { home?: string; offline?: boolean; now?: number } = {},
): Promise<Identity> {
  const home = opts.home ?? homedir();
  const cached = cachedEmail(configDir, home);
  const credential = readCliCredential(configDir);

  if (!credential) return { verified: false, note: 'no credential here' };
  if (opts.offline) {
    return {
      ...(cached ? { email: cached } : {}),
      verified: false,
      note: 'not checked against the API',
    };
  }
  if (credential.expired(opts.now)) {
    return {
      ...(cached ? { email: cached } : {}),
      verified: false,
      note: 'the access token has expired; the CLI renews it on its next run',
    };
  }

  const auth = asOAuthToken(credential);
  const profile = auth ? await fetchLiveProfile(auth, opts.now) : undefined;
  if (profile?.email) {
    return {
      email: profile.email,
      ...(profile.accountUuid ? { accountUuid: profile.accountUuid } : {}),
      verified: true,
    };
  }

  return {
    ...(cached ? { email: cached } : {}),
    verified: false,
    note: 'the API did not answer; this is the CLI’s cached copy',
  };
}

/**
 * What a switch would do, computed without writing anything.
 *
 * The credential it would install is the newest one the vault holds for this
 * `(surface, account)` pair. There is no second shelf to fall back to and no
 * ordering to get right: the history is append-only, so "newest" is the whole
 * selection rule, and the versions underneath it stay exactly where they are
 * whether the switch happens or not.
 */
export async function planSwitch(opts: {
  configDir: string;
  target: string;
  vaultRoot: string;
  home?: string;
  offline?: boolean;
  now?: number;
  alive?: WriterCheck;
}): Promise<SwitchPlan> {
  const from = await identify(opts.configDir, {
    home: opts.home,
    offline: opts.offline,
    now: opts.now,
  });

  const chosen = currentCredential(opts.vaultRoot, opts.configDir, opts.target);

  const blockers: string[] = [];
  if (!chosen) {
    blockers.push(
      `the vault has no credential for ${opts.target} in ${opts.configDir}. ` +
        'Sign into that account once in this directory and foster keeps every copy from then on. ' +
        'A credential taken from another config directory is a different token family and ' +
        'is deliberately not offered here.',
    );
  }

  // The refusal that all of this turns on: a credential is about to be
  // overwritten, and the only safe place to put the one being displaced is a
  // vault entry named after its owner. An unverified answer is not good enough
  // to name it with — the CLI's cached profile lags a swap by one run, so after
  // one switch it confidently names the account that just left. Filing under it
  // would overwrite that account's real entry with somebody else's credential,
  // and the vault would then hand the wrong one back. Nothing here is worth
  // guessing at, so an identity foster cannot verify stops the switch instead.
  //
  // This is also what makes `--offline` honest. Skipping the check leaves the
  // identity unverified, so an offline run plans and refuses rather than
  // writing the credential and reverting it a moment later.
  if (hasCredential(opts.configDir) && !from.verified) {
    blockers.push(
      `foster cannot establish which account ${opts.configDir} is signed in as ` +
        `(${from.note ?? 'unverified'}), and will not overwrite a credential it has nowhere ` +
        'safe to file. Retry with the API reachable, and without --offline.',
    );
  }

  // Only a verified answer can say "you are already here". The cached one is
  // wrong exactly when it matters: right after a switch, it still names the
  // previous account and would refuse the switch back to it.
  if (from.verified && from.email && from.email.toLowerCase() === opts.target.toLowerCase()) {
    blockers.push(`${opts.target} is already the account here`);
  }

  return {
    configDir: opts.configDir,
    from,
    to: opts.target,
    ...(chosen ? { takenAt: chosen.entry.savedAt } : {}),
    versions: chosen?.entry.versions ?? 0,
    incomingExpired: chosen?.credential.expired(opts.now) ?? false,
    clobberers: clobberersIn(opts.configDir, opts.alive ?? writerAlive),
    blockers,
  };
}

/**
 * Do it.
 *
 * The order is the whole safety argument, so it is worth reading as a sequence
 * rather than as steps:
 *
 *  1. The outgoing credential is recorded **first**. If everything after this
 *     fails, or the machine loses power, the account that was here is in its own
 *     history and switching back is a command.
 *  2. The incoming credential is written atomically, so no `claude` starting
 *     mid-write sees half a file.
 *  3. The result is **verified against the API**, not against the file we just
 *     wrote. Writing a file proves nothing about whether it authenticates; a
 *     stored credential can have gone stale since it was taken, which is the
 *     ordinary failure here and not an exotic one.
 *  4. A failed check puts the previous credential back and says what happened.
 *
 * What does not appear in that sequence is any deletion, and its absence is the
 * design rather than an omission. A positional vault would take the incoming
 * entry off the shelf on the way past, on the grounds that it is now in use and
 * a second copy will rot. This one leaves it, because a credential foster
 * removes is one no later feature can reach and no operator can fall back on —
 * and because the staleness that motivated removing it is detectable, while the
 * removal is not.
 */
export async function applySwitch(
  plan: SwitchPlan,
  opts: { vaultRoot: string; home?: string; now?: number },
): Promise<SwitchOutcome> {
  if (plan.blockers.length > 0) {
    return { ok: false, rolledBack: false, message: plan.blockers[0]! };
  }

  const incoming = currentCredential(opts.vaultRoot, plan.configDir, plan.to);
  if (!incoming) {
    return {
      ok: false,
      rolledBack: false,
      message: `the vault has no credential for ${plan.to} in ${plan.configDir}`,
    };
  }

  // The same refusal as the plan's, restated at the moment of writing. The plan
  // can be minutes old by now — a token expires, the network drops — and this is
  // the last point at which the outgoing credential still exists anywhere.
  const outgoing = readCliCredential(plan.configDir);
  if (outgoing && !(plan.from.verified && plan.from.email)) {
    return {
      ok: false,
      rolledBack: false,
      message:
        `refusing to overwrite the credential in ${plan.configDir}: foster could not verify ` +
        'which account it belongs to, so it has nowhere safe to file it and would destroy it.',
    };
  }
  if (outgoing) {
    rememberCredential(opts.vaultRoot, plan.configDir, plan.from.email!, outgoing, {
      accountUuid: plan.from.accountUuid,
      now: opts.now,
    });
  }

  writeCliCredential(plan.configDir, incoming.credential);

  const landed = await identify(plan.configDir, { home: opts.home, now: opts.now });

  if (landed.verified && landed.email?.toLowerCase() === plan.to.toLowerCase()) {
    // Recorded rather than moved. The entry that was installed stays exactly
    // where it was — this only notes that the same bytes are now the live ones,
    // and the deduplication means it usually appends nothing at all.
    rememberCredential(opts.vaultRoot, plan.configDir, landed.email, incoming.credential, {
      accountUuid: landed.accountUuid,
      now: opts.now,
    });

    return {
      ok: true,
      landed: landed.email,
      rolledBack: false,
      // The caveat is part of the outcome because the alternative is foster
      // contradicting itself in the next command: `clients` reads the profile
      // the CLI cached, and the CLI has not run yet, so it will name the account
      // that just left. Foster will not rewrite the app's cache to cover this.
      message:
        `${plan.configDir} is now signed in as ${landed.email}.\n` +
        `Until a \`claude\` runs there, its cached profile still names ` +
        `${plan.from.email ?? 'the previous account'}, so \`foster clients\` will too.`,
    };
  }

  if (outgoing) {
    writeCliCredential(plan.configDir, outgoing);
    return {
      ok: false,
      rolledBack: true,
      message:
        `the credential for ${plan.to} did not check out ` +
        `(${landed.note ?? `the API answered for ${landed.email ?? 'nobody'}`}). ` +
        'The previous account was put back. A credential that has sat unused can expire ' +
        `on its own — sign into ${plan.to} again to refresh it.`,
    };
  }

  return {
    ok: false,
    rolledBack: false,
    message:
      `the credential for ${plan.to} did not check out, and there was no previous ` +
      'credential here to put back. This directory is signed in as nobody until a login.',
  };
}

/**
 * Record whoever is signed in here, if there is anything new to record.
 *
 * The vault is filled by this and by a switch, and by nothing else. It only ever
 * writes for a **verified** identity: filing a credential under a guessed
 * address is how the vault would come to hold a record labelled with the wrong
 * account, which is the one way this module could hand back the wrong credential
 * later — and an append-only store cannot take a wrong label back.
 *
 * A token that has not rotated since the last look appends nothing, so calling
 * this on a timer is cheap and the history grows once per real change.
 */
export function rememberCurrent(
  configDir: string,
  identity: Identity,
  vaultRoot: string,
  now: number = Date.now(),
): { recorded: boolean; appended: boolean } {
  if (!identity.verified || !identity.email) return { recorded: false, appended: false };
  const credential = readCliCredential(configDir);
  if (!credential) return { recorded: false, appended: false };

  const { appended } = rememberCredential(vaultRoot, configDir, identity.email, credential, {
    accountUuid: identity.accountUuid,
    now,
  });
  return { recorded: true, appended };
}

/** Live `claude` processes registered in a config directory. */
export function clobberersIn(configDir: string, alive: WriterCheck): Clobberer[] {
  const seen = new Map<number, Clobberer>();
  for (const session of liveSessions([path.join(configDir, 'sessions')], alive)) {
    if (!seen.has(session.pid)) seen.set(session.pid, toClobberer(session));
  }
  return [...seen.values()];
}

function toClobberer(session: LiveCliSession): Clobberer {
  return { pid: session.pid, ...(session.cwd ? { cwd: session.cwd } : {}) };
}

/**
 * The email the CLI last cached for a directory.
 *
 * Deliberately `clients`' own reader rather than a second one. The rule it
 * encodes is not obvious — the default directory keeps its cached profile
 * *beside* itself at `~/.claude.json`, a directory the variable has pointed at
 * keeps one within, and the default has to prefer the outer copy because an
 * inner one can be a relic — and two implementations of a rule like that agree
 * until the day one of them is corrected.
 *
 * The caveat travels with it: the CLI writes this file, so it lags a swap by
 * exactly one `claude` run, which is why nothing here treats it as verified.
 */
function cachedEmail(configDir: string, home: string): string | undefined {
  const isDefault = samePath(configDir, path.join(home, '.claude'));
  return readClientIdentity(configDir, isDefault, home)?.email;
}
