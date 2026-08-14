// The shebang is added by the bundler (see tsup.config.ts), not here.
import path from 'node:path';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import {
  candidateStoreRoots,
  comparablePath,
  directoryKey,
  layoutFor,
  storeIdentity,
  listAccountDirs,
  samePath,
  storeRootOfCopy,
} from '../domain/paths.js';
import { currentAccount, requireCurrentAccount } from '../engine/account.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import {
  DesktopControlError,
  deliverUrl,
  endProcess,
  inspectDesktopFor,
  packagedAppId,
  quitDesktop,
  readProcesses,
  runningStores,
  startDesktop,
  trayNote,
} from '../engine/desktop.js';
import {
  continuedNote,
  continuedSince,
  TWO_SIDEBARS,
  liveBranchNote,
  twoLiveSidebars,
} from '../engine/continued.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { assertPurgeConfirmed, purgeConversations, summarisePurge } from '../engine/purge.js';
import { findDuplicates, type DuplicateReport } from '../engine/duplicates.js';
import { knownStores, resolveStoreArg } from '../engine/stores.js';
import { inspectApp } from '../engine/safety.js';
import {
  applySwitch,
  identify,
  planSwitch,
  rememberCurrent,
  type Identity,
} from '../engine/switch.js';
import { applyPointer, planPointer } from '../engine/pointer.js';
import { applySeed, planSeed } from '../engine/seed.js';
import { listAll, vaultOutsideProfile, vaultRoot } from '../engine/vault.js';
import { Ledger } from '../ledger/log.js';
import {
  copySessionIds,
  listActive,
  project,
  selectByTarget,
  whereCopiesAre,
} from '../ledger/project.js';
import type { LedgerEvent } from '../ledger/types.js';
import { readConfig } from '../store/config.js';
import { freshIdentityOf, overviewAccounts, type AccountOverview } from '../store/accounts.js';
import { listClients, type ClaudeClient } from '../store/clients.js';
import { inUseConfigDir } from '../store/configDirs.js';
import { readAccessToken } from '../store/credential.js';
import { fetchLiveProfile, fetchLiveUsage } from '../engine/anthropicApi.js';
import { backupPinState, readPinState, writePinState } from '../store/pinstate.js';
import { findPurgeable } from '../store/purge.js';
import {
  identityLabel,
  planName,
  readIdentityFromCache,
  resolveIdentity,
  worthRecording,
} from '../store/identity.js';
import { findRestorable } from '../store/restore.js';
import { scanStore, summarise } from '../store/scanner.js';
import { runAgent } from '../agent/run.js';
import { AgentSdkNotInstalledError, installAgentSdk } from '../agent/sdk.js';
import { bareSessionId } from '../domain/naming.js';
import { resumeConversation } from '../engine/resume.js';
import {
  describeWriters,
  isSelfHostedBy,
  liveSessions,
  pidAlive,
  sessionRegistryRoots,
  type LiveCliSession,
} from '../store/liveSessions.js';
import { viewTranscript } from '../store/transcripts.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { applyFilter, parseSince, selectByIds, type SessionFilter } from '../domain/filter.js';
import {
  matchAccountPrefix,
  matchOrganizationPrefix,
  listFosterable,
  liveConversationIds,
  selectFosterSessions,
} from '../ops/foster.js';
import { partitionByStore, selectReturnTargets } from '../ops/active.js';
import { applyLabel } from '../ops/label.js';
// Imported statically on purpose: a dynamic import makes the bundler emit a
// separate chunk, and the release ships (and checksums) a single file.
import { runInteractive } from './interactive.js';
import {
  accountTree,
  formatAge,
  formatBytes,
  formatDate,
  groupByAccount,
  outcomeLine,
  purgeLine,
  renderAccount,
  renderRenewals,
  renderUsage,
  sessionLine,
  shortId,
  updateLine,
} from './render.js';

interface GlobalOptions {
  store?: string;
  ledger?: string;
}

const program = new Command();

program
  .name('foster')
  .description(
    "Bring Claude Desktop Code sessions from a previous local account into the current account's sidebar",
  )
  .version(VERSION)
  .option('--store <path>', 'path to the Claude Desktop userData directory')
  .option('--ledger <path>', "path to foster's ledger file")
  // Running the bare command opens the guided menu; the subcommands below stay
  // available for scripting and for anyone who prefers one-shot invocations.
  .action(async function (this: Command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.outputHelp();
      return;
    }
    const { store, ledger } = context(this);
    await runInteractive(store, ledger);
  });

function context(command: Command): { store: StoreLayout; ledger: Ledger } {
  const opts = command.optsWithGlobals<GlobalOptions>();
  // The ledger first: it is what lets --store take a piece of a path rather than
  // the whole thing, since the installations it has been used in are recorded
  // nowhere else.
  const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();
  return { store: resolveStoreArg(opts.store, () => ledger.read()), ledger };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Where copies are written.
 *
 * Without --to this is the account in use, which is what nearly every run wants.
 * With it, any account on disk is a legitimate destination — staging copies for
 * an account before switching to it is a real workflow — but it has to name one
 * directory exactly, so an account holding two organizations is a refusal rather
 * than a coin toss.
 */
function resolveDestination(
  store: StoreLayout,
  accounts: AccountRef[],
  opts: { to?: string; toOrg?: string },
): AccountRef {
  if (opts.to === undefined && opts.toOrg === undefined) {
    return requireCurrentAccount(store, accounts);
  }

  const matches = resolveSources(accounts, opts.to, opts.toOrg, {
    account: '--to',
    organization: '--to-org',
  });

  if (matches.length > 1) {
    const orgs = matches.map((ref) => `  ${ref.organizationUuid}`).join('\n');
    throw new Error(
      `--to matches an account with ${matches.length} organizations. Name one with --to-org:\n${orgs}`,
    );
  }
  return matches[0]!;
}

/**
 * Resolve --from against the accounts on disk.
 *
 * A bare prefix match would silently foster from every account sharing those
 * leading characters, and a typo would be indistinguishable from an empty
 * result, so both are reported instead.
 */
function resolveSources(
  candidates: AccountRef[],
  accountPrefix: string | undefined,
  organizationPrefix: string | undefined,
  flags: { account: string; organization: string } = {
    account: '--from',
    organization: '--from-org',
  },
): AccountRef[] {
  let sources = candidates;

  if (accountPrefix !== undefined) {
    sources = matchAccountPrefix(sources, accountPrefix, flags.account);
  }
  if (organizationPrefix !== undefined) {
    sources = matchOrganizationPrefix(sources, organizationPrefix, flags.organization);
  }
  return sources;
}

function filterFrom(opts: {
  title?: string;
  cwd?: string;
  since?: string;
  all?: boolean;
  archived?: boolean;
}): SessionFilter {
  const filter: SessionFilter = {
    includeUnfosterable: opts.all ?? false,
    includeArchived: opts.archived ?? false,
  };
  if (opts.title) filter.title = opts.title;
  if (opts.cwd) filter.cwd = opts.cwd;
  if (opts.since) {
    const since = parseSince(opts.since);
    if (since === undefined)
      throw new Error(`Could not read --since "${opts.since}". Try 30d, 12h or 2w.`);
    filter.since = since;
  }
  return filter;
}

function filterOptions(command: Command): Command {
  return command
    .option('--title <text>', 'only sessions whose title contains this text')
    .option('--cwd <text>', 'only sessions whose working directory contains this text')
    .option('--since <age>', 'only sessions active within this window, e.g. 30d')
    .option('--archived', 'include sessions you archived; the copy stays archived');
}

function sourceOptions(command: Command): Command {
  return command
    .option('--from <accountUuid>', 'only sessions from this account')
    .option('--from-org <organizationUuid>', 'only sessions from this organization')
    .option('--from-store <path>', 'read the sessions from another installation or profile');
}

/**
 * Where sessions are read from, which is not always where they are written.
 *
 * A second profile is a whole separate store, so its sessions are unreachable
 * from the one this process resolved. Reading from one and writing into another
 * is the same operation the engine already performs — only the scan moves.
 */
function resolveSourceStore(
  target: StoreLayout,
  fromStore: string | undefined,
  ledger: Ledger,
): StoreLayout {
  // Abbreviated the same way as --store: the two flags name the same kind of
  // thing, and one of them accepting `work` while the other demanded the whole
  // path would be a distinction without a reason.
  return fromStore ? resolveStoreArg(fromStore, () => ledger.read()) : target;
}

function sameStore(a: StoreLayout, b: StoreLayout): boolean {
  return samePath(a.root, b.root);
}

program
  .command('doctor')
  .description('check the environment before doing anything else')
  .option('--json', 'machine-readable output')
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals<GlobalOptions & { json?: boolean }>();
    const roots = candidateStoreRoots();

    if (roots.length === 0 && !opts.store) {
      if (opts.json) print({ store: null, error: 'no Claude Desktop store found' });
      else console.log(pc.red('No Claude Desktop store found — pass --store <path>'));
      process.exitCode = 1;
      return;
    }

    const { store } = context(this);
    const config = readConfig(store);
    const app = inspectApp(store);

    if (opts.json) {
      print({
        version: VERSION,
        store: store.root,
        candidates: roots.length,
        account: config.lastKnownAccountUuid ?? null,
        updaterLastSeenVersion: config.updaterLastSeenVersion ?? null,
        appRunning: app.running,
        appId: packagedAppId(store) ?? null,
      });
      return;
    }

    console.log(pc.bold('foster'));
    console.log(`  ${updateLine(await checkForUpdate())}`);

    console.log(pc.bold('Store'));
    console.log(`  ${store.root}`);
    if (process.env.CLAUDE_USER_DATA_DIR) {
      // Worth saying out loud: with this set, the app and foster are both looking
      // at a profile rather than the default install, and someone debugging "my
      // sessions are missing" should know which one they are being shown.
      console.log(pc.dim('  from CLAUDE_USER_DATA_DIR — a separate profile, not the default'));
    }
    // Counted as directories, not as paths: the packaged store answers to two
    // names, and "2 candidates found" for one directory reads as a second
    // installation that does not exist.
    //
    // Only when the store was actually discovered: with an explicit --store the
    // candidate list was never consulted, and warning about it invites the reader
    // to doubt the path they just typed.
    const distinct = new Set(roots.map(directoryKey));
    if (!opts.store && distinct.size > 1)
      console.log(pc.yellow(`  (${distinct.size} candidates found, using the first)`));

    console.log(pc.bold('App'));
    // This is the release the updater last saw, which can run ahead of the
    // installed build, so it is labelled for what it is.
    console.log(`  updater sees  ${config.updaterLastSeenVersion ?? 'unknown'}`);
    console.log(`  account       ${config.lastKnownAccountUuid ?? 'unknown'}`);
    console.log(`  launches as   ${packagedAppId(store) ?? 'unknown'}`);

    // A profile started with the --user-data-dir switch is invisible to a process
    // that did not launch it, so the running instances are the only place to learn
    // that it exists — and what to point --store at.
    //
    // Compared against every candidate root, not just the resolved one. A packaged
    // app passes its userData as the pre-virtualisation %APPDATA% path while foster
    // resolves the package path; both name the same store, and reporting the other
    // spelling as "another instance" invents a profile that does not exist.
    const known = new Set([...candidateStoreRoots(), store.root].map(comparablePath));
    const others = runningStores().filter((dir) => !known.has(comparablePath(dir)));
    if (others.length > 0) {
      console.log(pc.bold('Other running instances'));
      for (const dir of others) console.log(`  ${dir}`);
      console.log(pc.dim('  pass one to --store to work on that profile'));
    }

    console.log(pc.bold('State'));
    if (app.running) {
      console.log(pc.yellow(`  Claude Desktop is running (${app.evidence.join('; ')})`));
      console.log(pc.dim('  Fostering works anyway; sending copies back wants it closed.'));
    } else {
      console.log(pc.green('  Claude Desktop is not running'));
    }
  });

program
  .command('stores')
  .description('installations foster knows about, and what to pass to --store')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const opts = this.optsWithGlobals<GlobalOptions & { json?: boolean }>();
    const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();
    // Everything the menu offers, printed instead of picked: without this, using
    // foster from a script meant knowing a profile's path by heart.
    const stores = knownStores(ledger.read());
    // Resolved leniently, because this is the command you reach for when nothing
    // resolves: refusing to list the installations because it could not pick one
    // of them would be exactly backwards.
    const current = resolveQuietly(opts.store, () => ledger.read());
    const labels = project(ledger.read()).labels;

    if (opts.json) {
      print(
        stores.map((known) => ({
          root: known.root,
          knownBy: known.hint,
          running: known.running,
          account: known.accountUuid ?? null,
          label: known.accountUuid ? (labels.get(known.accountUuid) ?? null) : null,
          isCurrent: current ? samePath(known.root, current.root) : false,
        })),
      );
      return;
    }

    if (stores.length === 0) {
      console.log('No Claude Desktop installation found.');
      console.log(pc.dim('Pass --store <path> to name one, or start the app once.'));
      return;
    }

    for (const known of stores) {
      const marker = current && samePath(known.root, current.root) ? pc.green('*') : ' ';
      const state = known.running ? `${known.hint}, running` : known.hint;
      // Which account an installation holds is the question a second profile
      // exists to answer, and a store with none is one that fostering into will
      // refuse — better said here than discovered there.
      const who = known.accountUuid
        ? (labels.get(known.accountUuid) ?? shortId(known.accountUuid))
        : 'not signed in';
      console.log(`${marker} ${known.root} ${pc.dim(`(${state}) ${who}`)}`);
    }
    const marked = current && stores.some((known) => samePath(known.root, current.root));
    console.log(pc.dim(`\n${marked ? '* is the one in use. ' : ''}Pass any of these to --store.`));
  });

/** The store a bare command would use, or nothing when there is not one. */
function resolveQuietly(
  override: string | undefined,
  readEvents: () => LedgerEvent[],
): StoreLayout | undefined {
  try {
    return resolveStoreArg(override, readEvents);
  } catch {
    return undefined;
  }
}

program
  .command('clients')
  .summary('the Claude Code clients on this machine, and who is signed into each')
  .description(
    'The Claude Code clients on this machine — one config directory per account.\n\n' +
      'The CLI reads CLAUDE_CONFIG_DIR, and everything that makes an account — credential,\n' +
      'settings, conversations — lives under whatever it names. So a second directory is a\n' +
      'second account, both able to run at once, and this lists the directories that exist,\n' +
      "with who is signed into each, read from each client's own cached profile. The\n" +
      'credential is never opened: its presence is what "signed in" means here.',
  )
  .option('--config-dir <path...>', 'extra Claude config directories to include')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const opts = this.opts<{ configDir?: string[]; json?: boolean }>();
    const clients = listClients(process.env, opts.configDir ?? []);

    if (opts.json) {
      print(
        clients.map((client) => ({
          configDir: client.configDir,
          isDefault: client.isDefault,
          inUse: client.inUse,
          signedIn: client.signedIn,
          email: client.identity?.email ?? null,
          name: client.identity?.name ?? null,
          plan: client.identity?.plan ?? null,
          conversations: client.conversations,
          lastUsedAt: client.lastUsedAt ?? null,
          live: client.live,
        })),
      );
      return;
    }

    if (clients.length === 0) {
      console.log('No Claude Code client found.');
      console.log(pc.dim('Run claude once, or pass --config-dir <path> to name a directory.'));
      return;
    }

    for (const client of clients) {
      const marker = client.inUse ? pc.green('*') : ' ';
      const details = [
        client.isDefault ? 'default' : undefined,
        client.live > 0 ? `${client.live} live` : undefined,
        `${client.conversations} conversation${client.conversations === 1 ? '' : 's'}`,
        client.lastUsedAt !== undefined ? `used ${formatAge(client.lastUsedAt)}` : undefined,
      ].filter(Boolean);
      console.log(
        `${marker} ${client.configDir}  ${clientIdentityLine(client)}  ${pc.dim(`(${details.join(', ')})`)}`,
      );
    }

    const marked = clients.some((client) => client.inUse);
    console.log(
      pc.dim(
        `\n${marked ? '* is the one this process runs under. ' : ''}Run another by setting CLAUDE_CONFIG_DIR to its directory.`,
      ),
    );
    console.log(
      pc.dim(
        'restore, purge and live already read all of them; --config-dir adds one from elsewhere.',
      ),
    );
  });

/** The who of a client line: the cached identity when there is one, the credential's word alone otherwise. */
function clientIdentityLine(client: ClaudeClient): string {
  const label = identityLabel(client.identity);
  // A profile without a credential is a client someone signed out of: the
  // identity still names it usefully, but claiming it is signed in would send
  // the next `claude` there straight to a login screen.
  if (label) return client.signedIn ? label : `${label} ${pc.dim('(signed out)')}`;
  return client.signedIn
    ? `signed in ${pc.dim('(identity not cached yet)')}`
    : pc.dim('not signed in');
}

program
  .command('scan')
  .description('read-only inventory of accounts and sessions')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const config = readConfig(store);
    const accounts = summarise(store, config.lastKnownAccountUuid, copySessionIds(ledger.read()));
    const labels = project(ledger.read()).labels;

    if (this.opts<{ json?: boolean }>().json) {
      print(
        accounts.map((row) => ({
          accountUuid: row.account.accountUuid,
          organizationUuid: row.account.organizationUuid,
          label: labels.get(row.account.accountUuid) ?? null,
          isCurrent: row.isCurrent,
          sessions: row.nativeCount,
          fostered: row.copyCount,
        })),
      );
      return;
    }

    if (accounts.length === 0) {
      console.log('No account directories found.');
      return;
    }

    console.log(accountTree(groupByAccount(accounts), labels));
  });

sourceOptions(
  filterOptions(program.command('list').description('list sessions available to foster')),
)
  .option('--all', 'also show sessions that could never appear in the sidebar')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      from?: string;
      fromOrg?: string;
      fromStore?: string;
      all?: boolean;
      json?: boolean;
    }>();
    const sourceStore = resolveSourceStore(store, opts.fromStore, ledger);
    const accounts = listAccountDirs(sourceStore);
    // Everything in another store is a candidate; only within one store does the
    // account in use need excluding, because there its sessions are already here.
    const current = sameStore(sourceStore, store) ? currentAccount(store, accounts) : undefined;

    const sources = resolveSources(
      accounts.filter((account) => account.accountUuid !== current?.accountUuid),
      opts.from,
      opts.fromOrg,
    );
    // The whole store is read even though only these accounts are offered: what
    // makes a copy the last card of its conversation is decided by the accounts
    // that are not on offer.
    const candidates = listFosterable(sourceStore, sources, ledger, filterFrom(this.opts()));

    if (opts.json) {
      print(
        candidates.map((session) => ({
          sessionId: session.data.sessionId,
          title: session.data.title ?? null,
          cwd: session.data.cwd ?? null,
          lastActivityAt: session.data.lastActivityAt ?? null,
          accountUuid: session.account.accountUuid,
          organizationUuid: session.account.organizationUuid,
          fosterable: session.reasons.length === 0,
          reasons: session.reasons,
        })),
      );
      return;
    }

    if (candidates.length === 0) {
      console.log('Nothing matches.');
      return;
    }

    for (const session of candidates) console.log(sessionLine(session));
    console.log(pc.bold(`\n${candidates.length} session(s)`));
  });

sourceOptions(
  filterOptions(
    program
      .command('foster')
      .description('copy sessions from another account into the current one')
      .option('--session <id...>', 'only these sessions, by id or unique prefix')
      .option('--to <accountUuid>', 'write the copies into this account instead')
      .option('--to-org <organizationUuid>', 'write the copies into this organization')
      .option('--prefix <text>', 'title prefix marking fostered sessions', DEFAULT_PREFIX)
      .option('--restart', 'restart Claude Desktop afterwards, so the copies show up')
      .option('--yes', 'actually write; without it nothing is written')
      .addOption(
        // Passing both used to silently win for --dry-run, so a script that meant
        // to write quietly did not. Naming the conflict says so instead.
        new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'),
      ),
  ),
).action(async function (this: Command) {
  const { store, ledger } = context(this);
  const opts = this.opts<{
    title?: string;
    cwd?: string;
    since?: string;
    archived?: boolean;
    session?: string[];
    from?: string;
    fromOrg?: string;
    fromStore?: string;
    to?: string;
    toOrg?: string;
    prefix: string;
    restart?: boolean;
    yes?: boolean;
    dryRun?: boolean;
  }>();

  const target = resolveDestination(store, listAccountDirs(store), opts);
  const sourceStore = resolveSourceStore(store, opts.fromStore, ledger);
  const crossStore = !sameStore(sourceStore, store);
  const filter = filterFrom(opts);

  // Only the directory the copies are going to is excluded, and only when the
  // sessions come from the same store: another organization of the same account
  // is just as invisible and just as fosterable, and a different store shares no
  // directory with the destination at all.
  const sources = resolveSources(
    listAccountDirs(sourceStore).filter(
      (ref) =>
        crossStore ||
        !(
          ref.accountUuid === target.accountUuid && ref.organizationUuid === target.organizationUuid
        ),
    ),
    opts.from,
    opts.fromOrg,
  );

  // Sessions that can never appear in the sidebar are always excluded here:
  // offering them would only produce copies the app silently never lists.
  let candidates = listFosterable(sourceStore, sources, ledger, filter);

  if (opts.session?.length) {
    try {
      candidates = selectFosterSessions(candidates, opts.session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nRun "foster list" to see the ids.`);
    }
  }

  if (candidates.length === 0) {
    console.log('Nothing to foster.');
    return;
  }

  // Default to a dry run: writing is opt-in via --yes.
  const dryRun = opts.dryRun || !opts.yes;
  const outcomes = fosterSessions(candidates, {
    store,
    ledger,
    target,
    sourceStore: sourceStore.root,
    prefix: opts.prefix,
    dryRun,
    includeArchived: Boolean(opts.archived),
    // A conversation with a live writer branches when its copy is opened, which
    // is the one failure that reads as foster losing work. Reported, never
    // refused: copying the session you are working in is the ordinary case.
    live: liveConversationIds(),
    // Naming sessions one by one is a decision about those sessions, and only
    // that brings back a copy the user deleted in the app.
    explicit: Boolean(opts.session?.length),
  });

  for (const outcome of outcomes) console.log(outcomeLine(outcome));
  const counts = summariseOutcomes(outcomes);

  // Named outright when the sessions came from elsewhere: the destination is
  // stated everywhere already, and a copy arriving from another installation is
  // exactly the case where "from where?" is not obvious.
  if (crossStore) console.log(pc.dim(`\nfrom ${sourceStore.root}`));

  // Said on the dry run too: it is the moment before anything is written, which
  // is exactly when knowing changes what someone does next.
  const writers = describeWriters(
    outcomes.map((outcome) => outcome.live).filter((id): id is string => Boolean(id)),
    sessionRegistryRoots(process.env),
  );

  if (dryRun) {
    console.log(
      pc.bold(`\nDry run: ${counts.fostered} would be fostered, ${counts.skipped} skipped.`),
    );
    if (writers.length > 0) console.log(pc.yellow(`\n${liveBranchNote(writers)}`));
    console.log(pc.dim('Re-run with --yes to write.'));
    return;
  }

  console.log(
    pc.bold(`\n${counts.fostered} fostered, ${counts.skipped} skipped, ${counts.failed} failed.`),
  );
  if (writers.length > 0) console.log(pc.yellow(`\n${liveBranchNote(writers)}`));
  if (counts.fostered > 0 && twoLiveSidebars(sourceStore, store)) {
    console.log(pc.yellow(`\n${TWO_SIDEBARS}`));
  }
  await finish(store, Boolean(opts.restart));
});

program
  .command('restore')
  .description('bring back sessions deleted in the app, from the conversations they left behind')
  .option('--title <text>', 'only conversations whose title contains this text')
  .option('--session <id...>', 'only these conversations, by id or unique prefix')
  .option('--to <accountUuid>', 'write them into this account instead')
  .option('--to-org <organizationUuid>', 'write them into this organization')
  .option('--config-dir <path...>', 'extra Claude config directories to search for conversations')
  .option('--prefix <text>', 'title prefix marking restored sessions', DEFAULT_PREFIX)
  .option('--restart', 'restart Claude Desktop afterwards')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      to?: string;
      toOrg?: string;
      configDir?: string[];
      prefix: string;
      restart?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    const target = resolveDestination(store, listAccountDirs(store), opts);
    let candidates = findRestorable(store, process.env, opts.configDir ?? []).map(
      (entry) => entry.session,
    );

    if (opts.title) {
      candidates = applyFilter(candidates, { title: opts.title });
    }
    if (opts.session?.length) {
      const { selected, unmatched } = selectByIds(candidates, opts.session);
      if (unmatched.length > 0) {
        throw new Error(
          `No deleted conversation matches --session ${unmatched.join(', ')}.\n` +
            'Run "foster restore" with no --yes to see what is available.',
        );
      }
      candidates = selected;
    }

    if (candidates.length === 0) {
      console.log('Nothing to restore: no deleted session still has its conversation on disk.');
      return;
    }

    const dryRun = opts.dryRun || !opts.yes;
    const outcomes = fosterSessions(candidates, {
      store,
      ledger,
      target,
      prefix: opts.prefix,
      dryRun,
    });

    for (const outcome of outcomes) console.log(outcomeLine(outcome));
    const counts = summariseOutcomes(outcomes);

    if (dryRun) {
      console.log(pc.bold(`\nDry run: ${counts.fostered} would be restored.`));
      console.log(pc.dim('Re-run with --yes to write.'));
      return;
    }

    console.log(pc.bold(`\n${counts.fostered} restored, ${counts.failed} failed.`));
    await finish(store, Boolean(opts.restart));
  });

program
  .command('purge')
  .description('destroy the conversations behind deleted sessions — permanently, with no undo')
  .option('--title <text>', 'only conversations whose title contains this text')
  .option('--session <id...>', 'only these conversations, by id or unique prefix')
  .option('--config-dir <path...>', 'extra Claude config directories to search for conversations')
  .option('--this-store-only', 'judge "still referenced" from this installation alone')
  .option('--json', 'machine-readable list of what would be destroyed')
  .option('--yes', 'actually destroy; requires --confirm as well')
  .option('--confirm <count>', 'the number this run destroys, as printed by the dry run')
  .addOption(new Option('--dry-run', 'show what would happen and destroy nothing').conflicts('yes'))
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      configDir?: string[];
      thisStoreOnly?: boolean;
      json?: boolean;
      yes?: boolean;
      confirm?: string;
      dryRun?: boolean;
    }>();

    // Every installation gets a say in whether a conversation is still in use,
    // because a card in a profile foster is not pointed at right now is still a
    // card, and the session it opens is still there after a restart. Narrowing
    // that to one store is available, and is a worse question to ask. The store
    // in use is not in this list because findPurgeable always counts it.
    const referenceStores = opts.thisStoreOnly
      ? []
      : knownStores(ledger.read()).map((known) => layoutFor(known.root));

    let candidates = findPurgeable({
      store,
      referenceStores,
      env: process.env,
      configDirs: opts.configDir ?? [],
    });

    if (opts.title) {
      const needle = opts.title.toLowerCase();
      candidates = candidates.filter((item) =>
        (item.facts.title ?? '').toLowerCase().includes(needle),
      );
    }
    if (opts.session?.length) {
      const wanted = opts.session.map((id) => bareSessionId(id).toLowerCase());
      const matches = (item: (typeof candidates)[number], id: string) =>
        item.cliSessionId.toLowerCase().startsWith(id);
      // Refused rather than quietly narrowed, as every other identifier flag in
      // foster is. A typo that filtered to nothing fell through to "no deleted
      // session still has its conversation on disk", which reads as "you have
      // nothing left to clean up" and is not what happened.
      const unmatched = wanted.filter((id) => !candidates.some((item) => matches(item, id)));
      if (unmatched.length > 0) {
        throw new Error(
          `No purgeable conversation matches --session ${unmatched.join(', ')}.\n` +
            'Run "foster purge" with no --yes to see what is available.',
        );
      }
      candidates = candidates.filter((item) => wanted.some((id) => matches(item, id)));
    }

    const held = new Set(
      liveSessions(sessionRegistryRoots(process.env, opts.configDir ?? [])).map((session) =>
        session.sessionId.toLowerCase(),
      ),
    );
    // Settled before anything is printed, so the number the user is asked to
    // confirm is the number that will actually be destroyed — a conversation
    // held open by a live process is skipped, and confirming a total that
    // included it would be confirming something that never happens.
    const doomed = candidates.filter((item) => !held.has(item.cliSessionId.toLowerCase()));

    if (opts.json) {
      // The doomed set, not every candidate: this flag says it lists what would
      // be destroyed, and a script that feeds its length to --confirm has to get
      // the same answer the command reached. Held conversations go to stderr so
      // they are not lost, and stdout stays parseable.
      print(
        doomed.map((item) => ({
          cliSessionId: item.cliSessionId,
          title: item.facts.title ?? null,
          cwd: item.facts.cwd ?? null,
          lastActivityAt: item.facts.lastActivityAt ?? null,
          deletedAt: item.deletedAt ?? null,
          files: item.files,
          bytes: item.bytes,
        })),
      );
      const heldHere = candidates.length - doomed.length;
      if (heldHere > 0) {
        console.error(
          pc.dim(
            `${heldHere} more held open by a live claude process, and not listed: they cannot be purged now.`,
          ),
        );
      }
      return;
    }

    if (candidates.length === 0) {
      console.log('Nothing to purge: no deleted session still has its conversation on disk.');
      return;
    }

    const dryRun = opts.dryRun || !opts.yes;

    if (!dryRun) assertPurgeConfirmed(opts.confirm, doomed.length);

    const outcomes = purgeConversations(candidates, { ledger, dryRun, held });
    for (const outcome of outcomes) console.log(purgeLine(outcome, dryRun));

    const counts = summarisePurge(outcomes);
    if (dryRun) {
      console.log(
        pc.bold(
          `\nDry run: ${counts.purged} conversation(s) would be destroyed, ` +
            `${formatBytes(counts.bytes)} in total.`,
        ),
      );
      console.log(
        pc.red('This cannot be undone, and foster keeps no copy. Read the list before confirming.'),
      );
      console.log(pc.dim(`Re-run with --yes --confirm ${counts.purged} to destroy them.`));
      return;
    }

    console.log(
      pc.bold(
        `\n${counts.purged} destroyed (${formatBytes(counts.bytes)}), ` +
          `${counts.skipped} skipped, ${counts.failed} failed.`,
      ),
    );
    // No restart offer, and nothing to see afterwards: these conversations had no
    // card in any sidebar — that is what made them purgeable — so the app's view
    // is exactly as it was.
    console.log(pc.dim("The app's deletion markers were left where they are."));
  });

program
  .command('return')
  .description('remove fostered copies, restoring the previous state')
  .option('--title <text>', 'only fosterings whose original title contains this text')
  .option('--session <id...>', 'only these origin sessions, by id or unique prefix')
  .option('--to <accountUuid>', 'only copies written into this account')
  .option('--to-org <organizationUuid>', 'only copies written into this organization')
  .option('--all-stores', 'include copies written into other installations')
  .option('--duplicates', 'only copies of a conversation their account already had')
  .option('--branches', 'only copies of a conversation their account already had a branch of')
  .option('--restart', 'restart Claude Desktop afterwards')
  .option('--yes', 'actually remove; without it nothing is removed')
  .addOption(new Option('--dry-run', 'show what would happen and remove nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      to?: string;
      toOrg?: string;
      allStores?: boolean;
      duplicates?: boolean;
      branches?: boolean;
      restart?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    const { selected: active, elsewhere } = selectReturnTargets(store, ledger, {
      allStores: opts.allStores,
      to: opts.to,
      toOrg: opts.toOrg,
      duplicates: opts.duplicates,
      branches: opts.branches,
      title: opts.title,
      sessionIds: opts.session,
    });

    if (elsewhere > 0) {
      console.log(
        pc.dim(
          `${elsewhere} more ${elsewhere === 1 ? 'copy is' : 'copies are'} in other installations — pass --all-stores to include them.`,
        ),
      );
    }

    if (active.length === 0) {
      console.log('Nothing is fostered.');
      return;
    }

    const dryRun = opts.dryRun || !opts.yes;
    // Measured before the copies go: for entries written before the ledger kept
    // the conversation id, the copy itself is where that id is read from.
    const continued = continuedSince(store, active);
    const outcomes = returnFosterings(active, { store, ledger, dryRun });
    for (const outcome of outcomes) console.log(outcomeLine(outcome));

    const counts = summariseOutcomes(outcomes);
    if (dryRun) {
      console.log(pc.bold(`\nDry run: ${counts.returned} would be returned.`));
      console.log(pc.dim('Re-run with --yes to remove.'));
      return;
    }

    console.log(pc.bold(`\n${counts.returned} returned, ${counts.failed} failed.`));
    if (continued.length > 0)
      console.log(
        pc.dim(`
${continuedNote(continued.length)}`),
      );
    await finish(store, Boolean(opts.restart));
  });

/**
 * Two rows for one conversation, and who put them there.
 *
 * The distinction is the point: foster removes what foster wrote, and a pair the
 * app made is reported so it is not blamed on the wrong tool, and so nobody goes
 * looking for a foster command that would delete somebody else's file.
 */
function reportDuplicates(report: DuplicateReport): void {
  if (report.copies.length > 0) {
    const one = report.copies.length === 1;
    console.log(
      pc.yellow(
        `${report.copies.length} of them duplicate${one ? 's' : ''} a conversation this account already had.` +
          `\nRemove ${one ? 'it' : 'them'} with: foster return --duplicates`,
      ),
    );
  }
  if (report.branches.length > 0) {
    const one = report.branches.length === 1;
    console.log(
      pc.yellow(
        `${report.branches.length} of them ${one ? 'is a branch' : 'are branches'} of a conversation this account already had.` +
          '\nSame work, forked: each side holds turns the other never got, so read both before' +
          `\nchoosing. Remove ${one ? 'it' : 'them'} with: foster return --branches`,
      ),
    );
  }
  if (report.appMade > 0) {
    const one = report.appMade === 1;
    console.log(
      pc.dim(
        `${report.appMade} conversation${one ? '' : 's'} here ${one ? 'has' : 'have'} more than one card the app itself made.` +
          '\nfoster did not write those and will not remove them. Deleting one in the app is safe:' +
          '\nthe conversation is not in the card.',
      ),
    );
  }
}

/** Shared tail of the two writing commands: restart now, or say why it matters. */
async function finish(store: StoreLayout, restart: boolean): Promise<void> {
  if (!restart) {
    console.log(
      pc.dim('Restart Claude Desktop to see the change, or re-run with --restart to do it here.'),
    );
    return;
  }
  // Named outright rather than as a flag to add here: --terminate belongs to
  // "foster app restart", and the writing commands have no such option.
  await restartDesktop(store, false, 'Run "foster app restart --terminate"');
}

program
  .command('status')
  .description('what is currently fostered')
  .option('--all', 'list every copy instead of summarising by account')
  .option('--to <accountUuid>', 'only copies written into this account')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ all?: boolean; to?: string; json?: boolean }>();
    let active = listActive(project(ledger.read()));
    if (opts.to !== undefined) active = selectByTarget(active, opts.to, undefined);

    if (opts.json) {
      print(
        active.map((f) => ({
          originSessionId: f.originSessionId,
          copySessionId: f.copySessionId,
          copyPath: f.copyPath,
          store: storeRootOfCopy(f.copyPath),
          cliSessionId: f.cliSessionId ?? null,
          originalTitle: f.originalTitle ?? null,
          origin: f.origin,
          target: f.target,
          fosteredAt: f.fosteredAt,
        })),
      );
      return;
    }

    if (active.length === 0) {
      console.log('Nothing is fostered.');
      return;
    }

    // The ledger spans every installation, so with two profiles in play the list
    // silently mixed them: a copy sitting in the other profile read exactly like
    // one in the store being worked on. Only said when it is true of the run.
    const { elsewhere } = partitionByStore(active, store);
    // Marked here for the same reason it is said after a return: the row in the
    // original account still carries the date it had the day it was fostered.
    const continued = new Set(continuedSince(store, active).map((c) => c.fostering.copySessionId));

    // Summary first, list on request. "What has foster done?" is a question
    // about shape — how many, and where — and answering it with one line per
    // copy stopped answering it at all: on this machine that was 1262 lines,
    // and finding out which account they were in meant piping the JSON through
    // a script. The per-copy list is still here, one flag away.
    if (!opts.all) {
      const labels = project(ledger.read()).labels;
      for (const line of whereCopiesAre(active).split('\n')) {
        const uuid = line.trim().split(/\s+/)[0]!;
        const name = labels.get(uuid);
        console.log(name ? `${line}  ${pc.dim(name)}` : line);
      }
      console.log(pc.bold(`\n${active.length} active fostering(s)`));
      console.log(pc.dim('foster status --all lists them; --to <accountUuid> narrows to one.'));
      reportDuplicates(findDuplicates(store, active));
      if (elsewhere.length > 0) {
        console.log(
          pc.dim(
            `${elsewhere.length} of them ${elsewhere.length === 1 ? 'is' : 'are'} in another installation — return needs --all-stores, or --store on that one.`,
          ),
        );
      }
      console.log(pc.dim(`Ledger: ${ledger.path}`));
      return;
    }

    for (const fostering of active) {
      const carried = continued.has(fostering.copySessionId) ? pc.dim(' (continued since)') : '';
      const where = elsewhere.includes(fostering)
        ? pc.dim(` in ${storeRootOfCopy(fostering.copyPath)}`)
        : '';
      console.log(
        `  ${pc.dim(formatDate(fostering.fosteredAt))}  ${fostering.originalTitle ?? shortId(fostering.originSessionId)}  ${pc.dim(`from ${shortId(fostering.origin.accountUuid)}`)}${carried}${where}`,
      );
    }
    console.log(pc.bold(`\n${active.length} active fostering(s)`));
    reportDuplicates(findDuplicates(store, active));
    if (elsewhere.length > 0) {
      console.log(
        pc.dim(
          `${elsewhere.length} of them ${elsewhere.length === 1 ? 'is' : 'are'} in another installation — return needs --all-stores, or --store on that one.`,
        ),
      );
    }
    console.log(pc.dim(`Ledger: ${ledger.path}`));
  });

program
  .command('label')
  .description('give an account a human name — the one in use, or any you name')
  .argument('[accountUuid]', 'the account to name; omit it for the one you are signed into')
  .argument('[label]')
  .option('--from-cache', 'name the signed-in account with its cached name and email')
  .option('--forget', "discard what foster remembers about an account's identity")
  .action(function (this: Command, first?: string, second?: string) {
    const { store, ledger } = context(this);
    const accounts = listAccountDirs(store);
    const currentAccountUuid = readConfig(store).lastKnownAccountUuid;

    // The way out of a wrong sighting. `whoami` reads a volatile source and
    // writes down what it found, so a misread survives the cache that produced
    // it — and nothing else can dislodge it, because a correcting sighting has
    // to *find* something, and by then the profile is usually gone from the
    // files foster is allowed to read. The label is left alone: a name you chose
    // is not the thing that was wrong.
    if (this.opts<{ forget?: boolean }>().forget) {
      if (second !== undefined) {
        throw new Error('--forget discards a remembered identity; it does not take a name.');
      }
      const accountUuid = first ?? currentAccountUuid;
      if (!accountUuid) {
        throw new Error(
          'No account is recorded as signed in, so there is nothing to forget.\n' +
            'Name the account outright: foster label <accountUuid> --forget.',
        );
      }
      const known = project(ledger.read()).identities.get(accountUuid);
      if (!known) {
        console.log(`foster remembers no identity for ${shortId(accountUuid)}.`);
        return;
      }
      ledger.append({ kind: 'account_identity_forgotten', accountUuid });
      console.log(`Forgot ${identityLabel(known) ?? 'the identity'} for ${shortId(accountUuid)}.`);
      console.log(
        pc.dim('The sighting stays in the log; it is no longer read as current.\n') +
          pc.dim('Next time the app caches a profile, foster will record it afresh.'),
      );
      return;
    }

    // --from-cache is the one-step version of `whoami` then `label`: read the
    // signed-in account's identity from the app's cache and use it as the name.
    if (this.opts<{ fromCache?: boolean }>().fromCache) {
      if (first !== undefined) {
        throw new Error('--from-cache names the signed-in account; do not also pass one.');
      }
      if (!currentAccountUuid) {
        throw new Error('No account is signed in, so there is nothing to read a name for.');
      }
      // The same resolution `whoami` uses, so the two never disagree: the cache
      // for what it still holds, the ledger for what it has forgotten.
      const identity = resolveIdentity(
        readIdentityFromCache(store, currentAccountUuid),
        project(ledger.read()).identities.get(currentAccountUuid),
      );
      const fromCache = identityLabel(identity);
      if (!fromCache) {
        throw new Error(
          "Nothing is known about this account — the app's cache holds no profile for it,\n" +
            'and foster has not recorded one. Name it by hand instead: foster label "a name".',
        );
      }
      ledger.append({
        kind: 'account_labelled',
        accountUuid: currentAccountUuid,
        label: fromCache,
      });
      console.log(`Labelled ${shortId(currentAccountUuid)} as ${pc.bold(fromCache)}.`);
      console.log(pc.dim("Read from the app's cache — not over the network."));
      return;
    }

    const { accountUuid, label } = applyLabel(
      ledger,
      first,
      second,
      accounts.map((ref) => ref.accountUuid),
      currentAccountUuid,
    );
    console.log(`Labelled ${shortId(accountUuid)} as ${pc.bold(label)}.`);
    // The pairing foster cannot make for itself is the one the app is showing on
    // screen: the email lives in the OAuth token cache, which foster does not read.
    if (first !== undefined && second === undefined) {
      console.log(pc.dim('That is the account the sidebar is reading right now.'));
    }
  });

program
  .command('whoami')
  .description("the signed-in account's name, email and plan, read from the app's own cache")
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const accountUuid = readConfig(store).lastKnownAccountUuid;
    const json = this.opts<{ json?: boolean }>().json;

    if (!accountUuid) {
      if (json) return print({ accountUuid: null, email: null, name: null, plan: null });
      console.log('No account is signed in. Open Claude Desktop once first.');
      return;
    }

    // Printed before the cache read, so this command always says something even
    // if the read below finds nothing — the account is the one fact that never
    // depends on the cache.
    if (!json) console.log(`account  ${accountUuid}`);

    // Read at rest, never over the network: the app cached its own profile in the
    // web-origin LevelDB, which is page data rather than a credential. What the
    // cache no longer holds comes from the ledger, which is why this answer does
    // not change with the app's compaction schedule.
    const cached = readIdentityFromCache(store, accountUuid);
    const known = project(ledger.read()).identities.get(accountUuid);
    const identity = resolveIdentity(cached, known);

    // Written down so the next run still knows it after the app has forgotten —
    // but only when it adds something. A reading command that appended on every
    // invocation would fill an append-only log with identical lines.
    if (cached && worthRecording(cached, known)) {
      ledger.append({
        kind: 'account_identity_seen',
        accountUuid,
        ...(cached.email ? { email: cached.email } : {}),
        ...(cached.name ? { name: cached.name } : {}),
        ...(cached.plan ? { plan: cached.plan } : {}),
        ...(cached.profile ? { profile: cached.profile } : {}),
      });
    }

    if (json) {
      return print({
        accountUuid,
        email: identity?.email ?? null,
        name: identity?.name ?? null,
        plan: identity?.plan ?? null,
        remembered: identity?.remembered ?? false,
        seenAt: identity?.seenAt ?? null,
      });
    }

    if (identity?.name) console.log(`name     ${pc.bold(identity.name)}`);
    if (identity?.email) console.log(`email    ${identity.email}`);
    if (identity?.plan) console.log(`plan     ${identity.plan}`);
    // Said when any of it came from memory rather than from the cache. The plan
    // ages out of the cache within hours of a sign-in, so this is the ordinary
    // case rather than the exception, and a remembered answer that pretends to be
    // fresh is the kind of small lie that costs trust later.
    if (identity?.seenAt !== undefined) {
      const when = formatDate(identity.seenAt);
      console.log(
        pc.dim(
          identity.remembered
            ? `\nNot in the app's cache now; this is what foster recorded on ${when}.`
            : `\nThe plan is no longer in the app's cache; that part was recorded on ${when}.`,
        ),
      );
    }
    if (!identity?.email && !identity?.name && !identity?.plan) {
      console.log(
        pc.dim(
          "Nothing found in the app's cache for this account.\n" +
            'The profile may be stored differently in this app version. You can still name it by hand:\n' +
            '  foster label "a name"',
        ),
      );
      return;
    }
    console.log(pc.dim(`\nName the account with this in one step:  foster label --from-cache`));
  });

program
  .command('accounts')
  .description('every account on this machine: who, which plan, and whether it is still paid for')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const rows = overviewAccounts(store, ledger);

    // Recorded here for the same reason `whoami` records: this is the moment the
    // current account's profile is in hand, and the next time it is asked about
    // may be from another account, when the cache describes someone else.
    recordCurrentIdentity(rows, ledger);

    if (this.opts<{ json?: boolean }>().json) {
      return print(
        rows.map((row) => ({
          accountUuid: row.accountUuid,
          organizationUuids: row.organizationUuids,
          label: row.label ?? null,
          isCurrent: row.isCurrent,
          sessions: row.sessions,
          fostered: row.copies,
          coworkOnly: row.agentOnly,
          name: row.identity?.name ?? null,
          email: row.identity?.email ?? null,
          plan: row.identity?.plan ?? null,
          profile: row.identity?.profile ?? null,
          remembered: row.remembered,
          seenAt: row.seenAt ?? null,
        })),
      );
    }

    if (rows.length === 0) {
      console.log('No accounts in this installation yet.');
      return;
    }

    for (const row of rows) {
      console.log('');
      for (const line of renderAccount(row)) console.log(line);
    }

    const unseen = rows.filter((row) => !row.identity).length;
    console.log('');
    console.log(
      pc.dim(
        `${rows.length} account(s). Only the one in use can be read fresh — the app caches the\n` +
          'profile of the session it is in, and foster keeps what it saw for the others.',
      ),
    );
    if (unseen > 0) {
      console.log(
        pc.dim(
          `${unseen} of them ${unseen === 1 ? 'has' : 'have'} never been seen signed in here; signing into one fills its row in.`,
        ),
      );
    }
  });

/** Writes down the current account's profile when it says something the ledger does not. */
function recordCurrentIdentity(rows: AccountOverview[], ledger: Ledger): void {
  const fresh = freshIdentityOf(rows);
  const identity = fresh?.identity;
  if (!fresh || !identity) return;
  if (!worthRecording(identity, project(ledger.read()).identities.get(fresh.accountUuid))) return;

  ledger.append({
    kind: 'account_identity_seen',
    accountUuid: fresh.accountUuid,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.plan ? { plan: identity.plan } : {}),
    ...(identity.profile ? { profile: identity.profile } : {}),
  });
}

program
  .command('usage')
  .description(
    "the signed-in account's live usage — the 5-hour and weekly limits, read from the API",
  )
  .option('--json', 'machine-readable output')
  .action(async function (this: Command) {
    const { store } = context(this);
    const json = this.opts<{ json?: boolean }>().json;

    // The one command that reads the credential and goes to the network. Said
    // plainly on failure, because every reason it can fail is ordinary: not on
    // Windows, an older app without the V2 token cache, a profile copied from
    // another machine that this user cannot unseal, an expired token.
    const auth = readAccessToken(store);
    if (!auth) {
      if (json) return print({ error: 'no-token' });
      console.log('Could not read a usable token for the signed-in account.');
      console.log(
        pc.dim(
          "This reads the app's own OAuth token, which only works on Windows, only for the\n" +
            'account signed in now, and only on the machine it was signed in on.',
        ),
      );
      return;
    }

    const [profile, usage] = await Promise.all([fetchLiveProfile(auth), fetchLiveUsage(auth)]);

    if (json) return print({ profile: profile ?? null, usage: usage ?? null });

    if (profile) {
      const plan = planName(profile.rateLimitTier) ?? planName(profile.organizationType);
      const who = [profile.name, profile.email].filter(Boolean).join(' · ');
      if (who) console.log(who);
      if (plan) {
        console.log(
          `${pc.bold(plan)}${profile.rateLimitTier ? pc.dim(`  (${profile.rateLimitTier})`) : ''} · ${profile.subscriptionStatus ?? 'unknown'}`,
        );
      }
      console.log('');
    }

    if (!usage) {
      console.log('The usage endpoint did not answer. Nothing was changed.');
      return;
    }
    for (const line of renderUsage(usage)) console.log(line);
  });

program
  .command('renewals')
  .description('when each account resets and renews — usage windows and billing dates in one place')
  .option('--json', 'machine-readable output')
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const rows = overviewAccounts(store, ledger);

    // The current account's resets are live; fetch them if the token is there,
    // and carry on without them if it is not. Billing dates come from the rows.
    const auth = readAccessToken(store);
    const usage = auth ? await fetchLiveUsage(auth) : undefined;

    if (this.opts<{ json?: boolean }>().json) {
      return print({
        usage: usage ?? null,
        accounts: rows.map((row) => ({
          accountUuid: row.accountUuid,
          label: row.label ?? null,
          isCurrent: row.isCurrent,
          nextChargeDate: row.identity?.profile?.nextChargeDate ?? null,
          planEndingAt: row.identity?.profile?.planEndingAt ?? null,
          subscriptionStatus: row.identity?.profile?.subscriptionStatus ?? null,
          remembered: row.remembered,
          seenAt: row.seenAt ?? null,
        })),
      });
    }

    for (const line of renderRenewals(rows, usage)) console.log(line);
    console.log(
      pc.dim(
        '\nUsage resets are live and belong to the account in use. Billing dates are per\n' +
          'account, from the profile foster last saw — dated when they were not read fresh.',
      ),
    );
  });

/**
 * The config directory a credential command works on.
 *
 * The default is the one this process resolves to, which is the same directory
 * `clients` marks with a star — so `foster switch` with no `--config-dir`
 * changes the account a plain `claude` in this terminal would use, and nothing
 * else. The rule itself belongs to `configDirs`, which owns what a client is.
 */
function targetConfigDir(opts: { configDir?: string }): string {
  return opts.configDir ?? inUseConfigDir();
}

function describeIdentity(identity: Identity): string {
  const who = identity.email ?? 'nobody';
  if (identity.verified) return who;
  return identity.note ? `${who} (${identity.note})` : `${who} (unverified)`;
}

program
  .command('switch')
  .summary('sign a config directory in as another account, without a logout')
  .description(
    'Change which account a Claude Code config directory is signed in as.\n\n' +
      "The credential that is there goes into foster's vault under its own identity, and the\n" +
      'one asked for comes out of it — a positional swap, so exactly one copy of each account\n' +
      'is live at any time. Nothing is logged out, and the next `claude` to start in that\n' +
      'directory runs as the new account. Foster never logs in: an account it has no vault\n' +
      'entry for is a login you do once, after which it can be switched to freely.\n\n' +
      'Run it with no email to see the current account and what the vault holds.',
  )
  .argument('[email]', 'the account to switch to')
  .option('--config-dir <path>', 'the client to switch; defaults to the one in use')
  .option('--offline', 'skip the API check, and say so instead of claiming it passed')
  .option('--json', 'machine-readable output')
  .option('--yes', 'actually switch; without it nothing is written')
  .action(async function (this: Command, email: string | undefined) {
    const { ledger } = context(this);
    const opts = this.opts<{
      configDir?: string;
      offline?: boolean;
      json?: boolean;
      yes?: boolean;
    }>();
    const configDir = targetConfigDir(opts);
    const root = vaultRoot();

    if (!email) {
      // Reads, and only reads. This screen used to refresh the rolling copy on
      // the way past, on the reasoning that it had just verified the identity
      // and the write was nearly free. The write is not the problem — writing a
      // live credential to disk from a command that presents as a status screen
      // is. Every other write in this tool is behind --yes, and someone running
      // `foster switch` to see who they are has consented to nothing. Keeping
      // the shadow current belongs to `foster guard`, which says so in its name.
      const current = await identify(configDir, { ...(opts.offline ? { offline: true } : {}) });
      // Only this client's accounts. A credential taken from another config
      // directory belongs to a different token family and cannot be installed
      // here, so listing it would offer something this screen cannot deliver.
      const here = listAll(root).filter((entry) => samePath(entry.surface, configDir));

      if (opts.json) {
        return print({
          configDir,
          current: { email: current.email ?? null, verified: current.verified },
          accounts: here.map((entry) => ({
            email: entry.email,
            savedAt: entry.savedAt,
            versions: entry.versions,
          })),
        });
      }

      console.log(`Client        ${configDir}`);
      console.log(`Signed in as  ${describeIdentity(current)}`);
      console.log(
        `Switchable    ${here.length > 0 ? here.map((e) => e.email).join(', ') : '(none)'}`,
      );
      console.log(
        pc.dim(
          '\nThe vault keeps every credential foster has seen for this client, newest first;\n' +
            'a switch installs the newest and removes nothing. `foster guard` records the\n' +
            'account in use — this screen only reads.',
        ),
      );
      return;
    }

    const plan = await planSwitch({
      configDir,
      target: email,
      vaultRoot: root,
      ...(opts.offline ? { offline: true } : {}),
    });

    if (plan.blockers.length > 0) {
      for (const blocker of plan.blockers) console.log(pc.yellow(`  ! ${blocker}`));
      process.exitCode = 1;
      return;
    }

    if (plan.clobberers.length > 0) {
      console.log(
        pc.yellow(
          `  ! ${plan.clobberers.length} live session(s) in this client can rewrite the credential:`,
        ),
      );
      for (const one of plan.clobberers) {
        console.log(pc.yellow(`      pid ${one.pid}${one.cwd ? `  ${one.cwd}` : ''}`));
      }
      console.log(
        pc.dim(
          '      They hold their token in memory and rewrite the file when it renews,\n' +
            '      which would put the old account back. Finish there first, or accept it:\n' +
            '      the vault keeps both, so that is recoverable rather than impossible.',
        ),
      );
    }

    if (plan.incomingExpired) {
      console.log(
        pc.yellow(
          `  ! the stored credential for ${email} says it has expired; the check below decides`,
        ),
      );
    }

    if (!opts.yes) {
      const taken = plan.takenAt ? `, taken ${formatAge(plan.takenAt)}` : '';
      const kept = plan.versions > 1 ? ` (${plan.versions} versions on file)` : '';
      console.log(
        `Dry run: ${configDir} would go from ${describeIdentity(plan.from)} to ${plan.to}${taken}${kept}.`,
      );
      console.log('Re-run with --yes to switch.');
      return;
    }

    const outcome = await applySwitch(plan, { vaultRoot: root });
    if (outcome.ok) {
      ledger.append({
        kind: 'account_switched',
        configDir,
        ...(plan.from.email ? { from: plan.from.email } : {}),
        to: outcome.landed ?? plan.to,
        ...(plan.takenAt ? { takenAt: plan.takenAt } : {}),
        liveWriters: plan.clobberers.length,
      });
      console.log(outcome.message);
      return;
    }

    process.exitCode = 1;
    console.log(pc.red(outcome.message));
  });

program
  .command('vault')
  .summary('the credentials foster is holding, and whose they are')
  .description(
    'Every credential foster has kept, grouped by the client it belongs to and read from\n' +
      "each record's own fields rather than its filename — without opening a credential.\n\n" +
      'The vault is append-only. Nothing here is ever replaced or removed: a switch installs\n' +
      'the newest record for a client and account, and every version underneath it stays. So\n' +
      'a row saying "3 versions" means three distinct credentials were seen for that pair,\n' +
      'and all three are still on disk.',
  )
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const entries = listAll(vaultRoot());

    if (this.opts<{ json?: boolean }>().json) {
      return print(
        entries.map((entry) => ({
          surface: entry.surface,
          email: entry.email,
          accountUuid: entry.accountUuid ?? null,
          savedAt: entry.savedAt,
          expiresAt: entry.expiresAt ?? null,
          versions: entry.versions,
        })),
      );
    }

    if (entries.length === 0) {
      console.log('The vault is empty.');
      console.log(
        pc.dim(
          'It fills as you use it: `foster guard` records the account in use, and a switch\n' +
            'records the account it displaces.',
        ),
      );
    }

    let surface = '';
    for (const entry of entries) {
      if (entry.surface !== surface) {
        surface = entry.surface;
        console.log(`  ${surface}`);
      }
      // formatAge answers "how long since this was last used", and returns
      // "never used" for a timestamp of zero — which is what a record without a
      // savedAt folds to. On a row about when something was *taken* that reads
      // as a contradiction of the row it is on.
      const age = entry.savedAt ? `taken ${formatAge(entry.savedAt)}` : 'taken at an unknown time';
      const kept = entry.versions > 1 ? `, ${entry.versions} versions kept` : '';
      console.log(`      ${entry.email}  (${age}${kept})`);
    }

    const root = vaultRoot();
    console.log(pc.dim(`\n${root}`));
    if (vaultOutsideProfile(root)) {
      console.log(
        pc.yellow(
          '  ! FOSTER_HOME puts this outside your user profile. Credentials here are\n' +
            '    unencrypted, and foster cannot vouch for who else can read that path.',
        ),
      );
    }
  });

program
  .command('guard')
  .summary('record whoever is signed into a client, so the vault can put them back')
  .description(
    'Add the credential a client currently holds to its history, if it is not already the\n' +
      'newest one there.\n\n' +
      'This is what makes an account switchable: foster can only install a credential it has\n' +
      'seen, and it only sees one by being pointed at a client while that account is signed\n' +
      'in. It is also what makes a clobber survivable — another process overwriting the live\n' +
      'file cannot reach what is already recorded.\n\n' +
      'Foster is one-shot, so this is the seam for anything that wants a fixed cadence: a\n' +
      'scheduled task, a watchdog, a shell prompt. A token that has not rotated since the\n' +
      'last look records nothing, so calling it often is cheap.',
  )
  .option('--config-dir <path>', 'the client to guard; defaults to the one in use')
  .option('--json', 'machine-readable output')
  .action(async function (this: Command) {
    const opts = this.opts<{ configDir?: string; json?: boolean }>();
    const configDir = targetConfigDir(opts);
    const root = vaultRoot();

    const identity = await identify(configDir);
    const { recorded, appended } = rememberCurrent(configDir, identity, root);

    if (opts.json) {
      return print({
        configDir,
        email: identity.email ?? null,
        verified: identity.verified,
        recorded,
        appended,
      });
    }

    console.log(`${configDir}  ${describeIdentity(identity)}`);
    console.log(
      !recorded
        ? pc.dim('Nothing recorded: the vault only files a credential under a verified identity.')
        : appended
          ? pc.dim('Recorded — this credential was new.')
          : pc.dim('Already the newest on file; nothing appended.'),
    );
  });

program
  .command('point')
  .summary('repoint a directory link at another client')
  .description(
    'Flip a junction so that whatever runs with CLAUDE_CONFIG_DIR set to it follows a\n' +
      'different account.\n\n' +
      'This is the other way to change accounts, and it changes them for one consumer rather\n' +
      'than for the machine: each account keeps its own config directory, logged into once,\n' +
      'and the link decides which of them is live. No credential moves and nothing is logged\n' +
      'out.\n\n' +
      'The path is resolved on every file open, so a process that started before the flip\n' +
      'writes through it after — a link does not isolate a running process from a switch.',
  )
  .argument('<link>', 'the junction to repoint')
  .option('--to <configDir>', 'the client it should point at')
  .option('--yes', 'actually repoint; without it nothing is written')
  .action(function (this: Command, link: string) {
    const opts = this.opts<{ to?: string; yes?: boolean }>();
    if (!opts.to) throw new Error('--to names the client the link should point at');

    const plan = planPointer(link, opts.to);
    for (const blocker of plan.blockers) console.log(pc.yellow(`  ! ${blocker}`));
    if (plan.blockers.length > 0) {
      process.exitCode = 1;
      return;
    }

    if (!opts.yes) {
      const now = plan.state.target ?? `(${plan.state.kind})`;
      console.log(`Dry run: ${link} would go from ${now} to ${opts.to}.`);
      console.log('Re-run with --yes to repoint.');
      return;
    }

    const outcome = applyPointer(plan);
    if (!outcome.ok) process.exitCode = 1;
    console.log(outcome.ok ? outcome.message : pc.red(outcome.message));
  });

const client = program
  .command('client')
  .description('make a config directory that is a working client');

client
  .command('new')
  .summary('seed a new config directory from an existing one')
  .description(
    'Create a config directory that behaves like the one it was seeded from.\n\n' +
      'A bare mkdir plus a login authenticates, but the sessions run there quietly have\n' +
      'fewer capabilities than sessions anywhere else: no settings, no project\n' +
      'instructions, no skills, and nothing in any output saying so.\n\n' +
      'Settings, CLAUDE.md, agents, commands and output styles are copied. Skills are\n' +
      'linked rather than copied, because they are a warehouse and a copy starts drifting\n' +
      'the day either side changes. The credential, `projects/` and the cached profile in\n' +
      '`.claude.json` are never copied — the first would put one account in two places, the\n' +
      'second is the whole conversation history, and the third would make the new directory\n' +
      "report somebody else's identity before anyone had signed into it.",
  )
  .argument('<path>', 'the config directory to create')
  .option('--from <configDir>', 'the client to seed from; defaults to the one in use')
  .option('--yes', 'actually create it; without it nothing is written')
  .action(function (this: Command, target: string) {
    const opts = this.opts<{ from?: string; yes?: boolean }>();
    const plan = planSeed(target, opts.from ?? targetConfigDir({}));

    for (const blocker of plan.blockers) console.log(pc.yellow(`  ! ${blocker}`));
    if (plan.blockers.length > 0) {
      process.exitCode = 1;
      return;
    }

    if (!opts.yes) {
      console.log(`Dry run: ${target} would be seeded from ${plan.from}.`);
      if (plan.copies.length > 0) console.log(`  copy  ${plan.copies.join(', ')}`);
      if (plan.links.length > 0) console.log(`  link  ${plan.links.join(', ')}`);
      console.log('Re-run with --yes to create it.');
      return;
    }

    const outcome = applySeed(plan);
    if (!outcome.ok) {
      process.exitCode = 1;
      console.log(pc.red(outcome.message));
      return;
    }
    if (outcome.copied.length > 0) console.log(`  copied  ${outcome.copied.join(', ')}`);
    if (outcome.linked.length > 0) console.log(`  linked  ${outcome.linked.join(', ')}`);
    console.log(outcome.message);
  });

program
  .command('labels')
  .description('list the names given to accounts')
  .action(function (this: Command) {
    const { ledger } = context(this);
    const labels = project(ledger.read()).labels;
    if (labels.size === 0) {
      console.log('No accounts have been named.');
      return;
    }
    for (const [accountUuid, name] of labels) console.log(`  ${shortId(accountUuid)}  ${name}`);
  });

program
  .command('pin')
  .summary('pin sessions in the sidebar, or see what is pinned')
  .description(
    'Pin or unpin sessions in the Claude Desktop sidebar.\n\n' +
      'Pinning is not part of a session file. The app keeps it in its own IndexedDB, keyed on the\n' +
      'session id — and foster mints a fresh id for every copy, so a copy of a pinned session\n' +
      'always arrives unpinned. That is the gap this closes.\n\n' +
      'The database belongs to the app and is locked while it runs, so Claude Desktop has to be\n' +
      'closed. A copy of it is taken before anything is written.',
  )
  .option('--session <id...>', 'sessions to pin, by id or unique prefix')
  .option('--remove', 'unpin them instead')
  .option('--backup-dir <path>', 'where to copy the database before writing')
  .option('--start', 'start Claude Desktop afterwards')
  .option('--yes', 'actually write; without it nothing is written')
  .addOption(new Option('--dry-run', 'show what would happen and write nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      session?: string[];
      remove?: boolean;
      backupDir?: string;
      start?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    const state = readPinState(store);
    if (!state) {
      console.log('Nothing has ever been pinned in this installation.');
      console.log(
        pc.dim(
          'foster copies the record the app writes rather than inventing one, because that record\n' +
            'carries a serialiser version it has no business guessing. Pin any session in the\n' +
            'sidebar once, and foster can do the rest from then on.',
        ),
      );
      return;
    }

    if (state.notices.length > 0) {
      for (const note of state.notices) {
        console.log(pc.yellow(`warning: ${note}`));
      }
    }

    const onDisk = new Map(scanStore(store).map((found) => [found.data.sessionId, found]));

    if (!opts.session?.length) {
      console.log(`${state.ids.length} pinned in ${store.root}:`);
      for (const id of state.ids) {
        const found = onDisk.get(id);
        const title =
          found?.data.title ?? pc.dim('(no session file — pinned id points at nothing)');
        console.log(`  ${shortId(id)}  ${title}`);
      }
      console.log(pc.dim(`\nRead from ${state.logPath}`));
      return;
    }

    const wanted = opts.remove
      ? selectPinnedIds(state.ids, opts.session)
      : selectByIds([...onDisk.values()], opts.session);
    const selected = opts.remove
      ? (wanted as { selected: string[] }).selected
      : (wanted as { selected: DiscoveredSession[] }).selected.map((found) => found.data.sessionId);

    if (wanted.unmatched.length > 0) {
      throw new Error(
        `No ${opts.remove ? 'pinned session' : 'session'} matches --session ${wanted.unmatched.join(', ')}.\n` +
          'Run "foster pin" with no arguments to see what is there.',
      );
    }

    // Pinning reaches across the whole store, but the sidebar does not: the app
    // loads one account's directory and marks what it finds there, so an id from
    // any other account joins the list and is never drawn. Refusing is the only
    // honest answer — writing it would report a pin that cannot appear, and the
    // ids of other accounts are exactly what "foster list" puts in front of you.
    if (!opts.remove) {
      const sidebar = currentAccount(store, listAccountDirs(store));
      const elsewhere = (wanted as { selected: DiscoveredSession[] }).selected.filter(
        (found) =>
          sidebar &&
          (found.account.accountUuid !== sidebar.accountUuid ||
            found.account.organizationUuid !== sidebar.organizationUuid),
      );
      if (elsewhere.length > 0) {
        const names = elsewhere
          .map((found) => `  ${shortId(found.data.sessionId)}  ${found.data.title ?? ''}`)
          .join('\n');
        throw new Error(
          `${elsewhere.length} of those ${elsewhere.length === 1 ? 'sessions belongs' : 'sessions belong'} to another account, which the sidebar never shows:\n${names}\n` +
            'Foster them into the account in use first, then pin the copies.',
        );
      }
    }

    // The app appends on toggle, so appending is what keeps foster's writes
    // indistinguishable from the sidebar's own.
    const next = opts.remove
      ? state.ids.filter((id) => !selected.includes(id))
      : [...state.ids, ...selected.filter((id) => !state.ids.includes(id))];

    if (next.length === state.ids.length) {
      console.log(
        opts.remove
          ? 'Nothing to do: none of those are pinned.'
          : 'Nothing to do: all of those are already pinned.',
      );
      return;
    }

    const verb = opts.remove ? 'unpin' : 'pin';
    for (const id of selected) {
      if (opts.remove ? state.ids.includes(id) : !state.ids.includes(id)) {
        console.log(`${verb} ${shortId(id)}  ${onDisk.get(id)?.data.title ?? ''}`);
      }
    }

    if (opts.dryRun || !opts.yes) {
      console.log(pc.bold(`\nDry run: ${state.ids.length} pinned would become ${next.length}.`));
      console.log(pc.dim('Re-run with --yes to write.'));
      return;
    }

    // Checked here rather than at the top so that reading and dry runs keep
    // working while the app is up — it is only the write that cannot share the
    // database, because LevelDB holds unflushed writes in memory and would put
    // them over the top of foster's.
    const app = inspectApp(store);
    if (app.running) {
      throw new Error(
        `Claude Desktop is running (${app.evidence.join('; ')}).\n` +
          'Its IndexedDB is locked and holds writes that are not on disk yet, so changing the\n' +
          'pin list now would be overwritten the moment it flushes. Close it first — ' +
          '"foster app quit --terminate" will.',
      );
    }

    const backup = backupPinState(
      store,
      opts.backupDir ?? path.join(path.dirname(ledger.path), 'backups', `pin-state-${Date.now()}`),
    );
    console.log(pc.dim(`Database copied to ${backup}`));

    writePinState(state, next);
    console.log(pc.bold(`\n${state.ids.length} pinned is now ${next.length}.`));

    if (opts.start) {
      const started = await startDesktop(store);
      console.log(
        started ? 'Claude Desktop is up.' : 'Started it; it has not taken the store yet.',
      );
    }
  });

/** The removal counterpart of selectByIds, matching against the pin list itself. */
function selectPinnedIds(
  pinned: string[],
  wanted: string[],
): { selected: string[]; unmatched: string[] } {
  const selected = new Set<string>();
  const unmatched: string[] = [];

  for (const id of wanted) {
    const needle = bareSessionId(id).toLowerCase();
    // Matched against what is pinned rather than what is on disk, so an id left
    // behind by a session that no longer exists can still be taken off the list.
    const matches = pinned.filter((candidate) =>
      bareSessionId(candidate).toLowerCase().startsWith(needle),
    );
    if (matches.length === 0) {
      unmatched.push(id);
      continue;
    }
    for (const match of matches) selected.add(match);
  }

  return { selected: [...selected], unmatched };
}

program
  .command('transcript')
  .summary("read a conversation's transcript")
  .description(
    "Read part of a conversation's transcript — the JSONL under ~/.claude*/projects.\n" +
      'The id is the cliSessionId that `list --json` and `status --json` report.\n' +
      'Reads the most recent part by default; --head reads the start instead.',
  )
  .argument('<cliSessionId>', 'the conversation id')
  .option('--head', 'read the start of the conversation instead of the most recent part')
  .option('--chars <n>', 'how much to read', '20000')
  .option('--json', 'facts and text as JSON')
  .action(function (this: Command, cliSessionId: string) {
    const opts = this.opts<{ head?: boolean; chars: string; json?: boolean }>();
    const chars = Number(opts.chars);
    if (!Number.isInteger(chars) || chars <= 0) {
      throw new Error(`--chars must be a positive integer, not "${opts.chars}".`);
    }

    const view = viewTranscript(
      bareSessionId(cliSessionId),
      process.env,
      opts.head ? 'head' : 'tail',
      chars,
    );

    if (opts.json) {
      print(view);
      return;
    }
    console.error(
      pc.dim(
        `${view.path}\n${view.title ?? '(untitled)'} — ${view.sizeBytes} bytes` +
          (view.truncated ? `, showing the ${view.part}` : ''),
      ),
    );
    // The text goes to stdout on its own so the command pipes cleanly.
    console.log(view.text);
  });

program
  .command('resume')
  .summary('send one prompt to an existing conversation, headlessly')
  .description(
    'Send one prompt to an existing conversation via `claude -p --resume` and print the answer.\n\n' +
      'This appends to the conversation, so it refuses when a live claude process is holding\n' +
      'the conversation open — two writers on one transcript is how transcripts get corrupted.\n' +
      '`foster live` shows what is being held right now.',
  )
  .argument('<cliSessionId>', 'the conversation id')
  .argument('<prompt...>', 'what to say to it')
  .option('--timeout <seconds>', 'give up after this long', '300')
  .action(function (this: Command, cliSessionId: string, prompt: string[]) {
    const opts = this.opts<{ timeout: string }>();
    const timeout = Number(opts.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`--timeout must be a positive number of seconds, not "${opts.timeout}".`);
    }

    const result = resumeConversation(cliSessionId, prompt.join(' '), {
      timeoutMs: timeout * 1000,
    });
    if ('refused' in result) {
      console.error(pc.yellow(result.refused));
      process.exitCode = 1;
      return;
    }
    console.log(result.output);
  });

program
  .command('live')
  .description('conversations a claude process is holding open right now')
  .option('--json', 'machine-readable output')
  .option('--stop <id...>', 'end the process holding these conversations, by id or unique prefix')
  .option('--yes', 'actually end them; without it nothing is stopped')
  .action(async function (this: Command) {
    const opts = this.opts<{ json?: boolean; stop?: string[]; yes?: boolean }>();
    const sessions = liveSessions(sessionRegistryRoots(process.env));

    if (opts.stop?.length) {
      await stopWriters(sessions, opts.stop, Boolean(opts.yes), Boolean(opts.json));
      return;
    }

    if (opts.json) {
      print(
        sessions.map((s) => ({
          pid: s.pid,
          cliSessionId: s.sessionId,
          cwd: s.cwd ?? null,
          registryFile: s.registryFile,
        })),
      );
      return;
    }

    if (sessions.length === 0) {
      console.log('No live claude sessions.');
      return;
    }
    for (const s of sessions) {
      console.log(`  ${String(s.pid).padStart(6)}  ${s.sessionId}  ${pc.dim(s.cwd ?? '')}`);
    }
    console.log(pc.dim('\nThese conversations have a writer; `foster resume` will refuse them.'));
    console.log(pc.dim('`foster live --stop <id>` ends one, so its copy can be opened.'));
  });

/**
 * End the processes writing the named conversations.
 *
 * The only way to release a conversation from outside the session holding it, and
 * the reason it exists: a copy cannot be opened without branching while a writer
 * is there, and "finish in the other window" is not always possible — the window
 * may be one you cannot get back to.
 *
 * It is a kill, and says so. There is no polite signal to send: the CLI has no
 * message loop to close, so ending it is `taskkill /F` and whatever the session
 * had not yet written is gone. What is already in the transcript stays — the file
 * is append-only, and a torn final line is what every tolerant reader here
 * expects. Refusing the session foster is running inside follows the rule the app
 * already has: a command must not kill the thing it is running in, part-way
 * through, leaving nobody to report what happened.
 */
async function stopWriters(
  sessions: LiveCliSession[],
  wanted: string[],
  apply: boolean,
  json: boolean,
): Promise<void> {
  // Resolved one prefix at a time, refusing rather than guessing — the rule every
  // other identifier flag here follows, and the one this command needs most. A
  // prefix that matched several used to end all of them, so a short id typed for
  // the session someone had in mind killed the others silently, and a kill is not
  // an operation anyone gets to take back.
  const selected = new Map<string, LiveCliSession>();
  for (const id of wanted) {
    const matches = sessions.filter((s) => s.sessionId.toLowerCase().startsWith(id.toLowerCase()));
    if (matches.length === 0) {
      throw new Error(`No live session matches ${id}.\nRun "foster live" to see what is running.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `"${id}" is ambiguous: it matches ${matches.length} live sessions.\n` +
          matches.map((s) => `  ${s.sessionId}  ${s.cwd ?? ''}`).join('\n'),
      );
    }
    selected.set(matches[0]!.sessionId, matches[0]!);
  }

  const rows = readProcesses();
  const results: { pid: number; cliSessionId: string; cwd: string | null; outcome: string }[] = [];
  for (const session of selected.values()) {
    const self = isSelfHostedBy(session.pid, () => rows);
    const where = session.cwd ? ` in ${session.cwd}` : '';

    const row = { pid: session.pid, cliSessionId: session.sessionId, cwd: session.cwd ?? null };

    if (self) {
      results.push({ ...row, outcome: 'refused-self' });
      if (!json) {
        console.log(
          pc.yellow(
            `  ! ${session.pid}  ${session.sessionId}${where}\n` +
              '    This is the session foster is running in. Ending it would kill this command\n' +
              '    part-way through. Close it yourself, or run foster from another terminal.',
          ),
        );
      }
      continue;
    }

    if (!apply) {
      results.push({ ...row, outcome: 'would-end' });
      if (!json) console.log(`  × ${session.pid}  ${session.sessionId}${pc.dim(where)}`);
      continue;
    }

    endProcess(session.pid);
    // Waited for rather than asked once. `taskkill /F` returns when termination
    // has been requested, not when the process object is gone, so the pid can
    // still answer for a moment afterwards — and reporting a kill that worked as
    // "did not end" sends someone hunting for a window that has already closed.
    // `quitDesktop` waits for the same reason.
    const gone = await settles(() => !pidAlive(session.pid));
    results.push({ ...row, outcome: gone ? 'ended' : 'still-running' });
    if (!json) {
      console.log(
        gone
          ? `  ✕ ${session.pid}  ${session.sessionId}${pc.dim(where)}`
          : pc.yellow(`  ! ${session.pid} did not end.`),
      );
    }
  }

  if (json) {
    print(results);
    return;
  }

  if (!apply) {
    console.log(
      pc.red(
        '\nDry run. Ending a session is a kill: anything it had not written yet is lost,' +
          '\nand what is already in the transcript stays.',
      ),
    );
    console.log(pc.dim('Re-run with --yes to end them.'));
  }
}

/** Polls a condition briefly, for a state change that is requested rather than immediate. */
async function settles(done: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

program
  .command('agent')
  .summary("run a Claude agent with foster's operations as its tools")
  .description(
    "Run a Claude agent with foster's operations as its tools.\n\n" +
      'The agent gets an in-process MCP server (foster_session_mgmt) wrapping the same engine\n' +
      "as the CLI, plus Claude Code's full toolset (shell, files, web). One switch governs all\n" +
      'of it: without --yes the run is read-only — foster mutations are dry runs and built-in\n' +
      'tools that write or execute are denied. With --yes everything runs, and removing copies\n' +
      'still requires Claude Desktop to be closed.\n\n' +
      'Needs the Claude Agent SDK, installed once with --setup, and a signed-in Claude Code\n' +
      'CLI (or ANTHROPIC_API_KEY) for the model itself.',
  )
  .argument('[task]', 'what the agent should do, in plain language')
  .option(
    '--yes',
    'allow writing: foster mutations apply, and shell/file/web tools run unrestricted',
  )
  // Haiku on purpose: the tools do the heavy lifting and most agent tasks here
  // are orchestration, so the cheap tier is the right default; --model opus is
  // one flag away for the tasks that need judgment.
  .option('--model <model>', 'model for the run — haiku, sonnet, opus or a full id', 'haiku')
  .option('--max-turns <n>', 'stop the agent after this many turns', '50')
  .option(
    '--setup',
    'install the Claude Agent SDK into ~/.foster/agent, then run the task if given',
  )
  .action(async function (this: Command, task?: string) {
    const opts = this.opts<{ yes?: boolean; model: string; maxTurns: string; setup?: boolean }>();

    if (opts.setup) installAgentSdk();
    if (!task) {
      if (!opts.setup) throw new Error('Give the agent a task: foster agent "<what to do>"');
      return;
    }

    const maxTurns = Number(opts.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error(`--max-turns must be a positive integer, not "${opts.maxTurns}".`);
    }

    const { store, ledger } = context(this);
    if (!opts.yes) {
      console.log(
        pc.dim(
          'Read-only run: foster mutations are dry runs and tools that write or execute are denied (--yes lifts both).',
        ),
      );
    }

    try {
      process.exitCode = await runAgent({
        task,
        store,
        ledger,
        allowWrites: Boolean(opts.yes),
        maxTurns,
        model: opts.model,
      });
    } catch (error) {
      if (error instanceof AgentSdkNotInstalledError) {
        console.error(pc.red(error.message));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

/* ------------------------------------------------------------------ *
 * Claude Desktop
 * ------------------------------------------------------------------ */

const app = program
  .command('app')
  .description('inspect or restart Claude Desktop')
  .action(function (this: Command) {
    reportDesktop(this);
  });

app
  .command('status')
  .description('whether the app is running, and what it is hosting')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    reportDesktop(this);
  });

function reportDesktop(command: Command): void {
  const { store } = context(command);
  // The instance running this store, so `--store <profile> app status` describes
  // that profile rather than whichever app was found first.
  const state = inspectDesktopFor(storeIdentity(store.root));

  if (command.opts<{ json?: boolean }>().json) {
    print({ ...state, appId: packagedAppId(store) ?? null });
    return;
  }

  if (!state.running) {
    console.log('Claude Desktop is not running.');
    return;
  }
  console.log(`Claude Desktop is running (pid ${state.mainPid}).`);
  if (state.startedAt) console.log(pc.dim(`  started ${formatAge(state.startedAt)}`));
  if (state.codeSessions > 0)
    console.log(pc.dim(`  hosting ${state.codeSessions} Claude Code session(s)`));
  if (state.selfHosted)
    console.log(pc.yellow('  foster is running inside it, so it cannot close it'));
}

app
  .command('quit')
  .description('ask Claude Desktop to close')
  .option('--terminate', 'end the process — required while the app keeps a tray icon')
  .action(async function (this: Command) {
    const { store } = context(this);
    await closeDesktop(store, Boolean(this.opts<{ terminate?: boolean }>().terminate));
  });

app
  .command('start')
  .description('start Claude Desktop')
  .action(async function (this: Command) {
    const { store } = context(this);
    const started = await startDesktop(store);
    console.log(started ? 'Claude Desktop is up.' : 'Started it; it has not taken the store yet.');
  });

app
  .command('link <url>')
  .summary('hand a claude:// link to this installation')
  .description(
    'Hand a claude:// link to the installation --store names.\n\n' +
      'Windows registers the protocol for the installed package, so a sign-in callback always\n' +
      'lands there — which is why a second profile can sit on the sign-in screen for ever while\n' +
      'the default installation opens instead. This delivers the link to the profile itself.\n\n' +
      'The link is never printed or recorded. A sign-in code is single-use and short-lived, so\n' +
      'cancel the browser prompt that offers to open Claude, and do this promptly.',
  )
  .action(function (this: Command, url: string) {
    const { store } = context(this);
    deliverUrl(store, url);
    console.log(`Handed to the installation at ${store.root}.`);
  });

app
  .command('restart')
  .description('close Claude Desktop and start it again, rebuilding the sidebar')
  .option('--terminate', 'end the process — required while the app keeps a tray icon')
  .action(async function (this: Command) {
    const { store } = context(this);
    await restartDesktop(store, Boolean(this.opts<{ terminate?: boolean }>().terminate));
  });

/**
 * The way out of a refusal, in the words of the command the user actually typed.
 *
 * "Re-run with --terminate" is only true where that flag exists. Reached from a
 * write that was asked to restart the app, it named an option `foster foster`
 * has never had, so following the advice answered "unknown option '--terminate'".
 */
const RERUN_WITH_TERMINATE = 'Re-run with --terminate';

async function closeDesktop(
  store: StoreLayout,
  terminate: boolean,
  retry: string = RERUN_WITH_TERMINATE,
): Promise<boolean> {
  const result = await quitDesktop(store, { terminate });
  if (result.outcome === 'not-running') {
    console.log('Claude Desktop was not running.');
    return true;
  }
  if (result.outcome === 'quit') {
    console.log('Claude Desktop is closed.');
    return true;
  }
  if (result.outcome === 'needs-terminate') {
    // Not an escalation this can make on its own: with the tray on there is no
    // way to ask, and ending the process skips the app's own shutdown.
    console.log(pc.yellow(trayNote(retry)));
    process.exitCode = 1;
    return false;
  }
  console.log(pc.yellow('Claude Desktop is still running. Quit it from the tray icon.'));
  process.exitCode = 1;
  return false;
}

async function restartDesktop(
  store: StoreLayout,
  terminate: boolean,
  retry?: string,
): Promise<void> {
  if (inspectApp(store).running && !(await closeDesktop(store, terminate, retry))) return;
  const started = await startDesktop(store);
  console.log(
    started
      ? 'Claude Desktop is up, with the sidebar rebuilt.'
      : 'Started it; it has not taken the store yet.',
  );
}

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(message));
    if (error instanceof DesktopControlError) console.error(pc.dim('Nothing was changed.'));
    process.exitCode = 1;
  }
}

await main();
