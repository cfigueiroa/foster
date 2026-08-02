// The shebang is added by the bundler (see tsup.config.ts), not here.
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import {
  candidateStoreRoots,
  comparablePath,
  directoryKey,
  storeIdentity,
  listAccountDirs,
  listAgentAccountDirs,
  pickActiveOrganization,
  samePath,
  storeRootOfCopy,
} from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import {
  DesktopControlError,
  deliverUrl,
  inspectDesktopFor,
  packagedAppId,
  quitDesktop,
  runningStores,
  startDesktop,
} from '../engine/desktop.js';
import {
  continuedSince,
  TWO_SIDEBARS,
  twoLiveSidebars,
  type ContinuedFostering,
} from '../engine/continued.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { knownStores, resolveStoreArg } from '../engine/stores.js';
import { inspectApp } from '../engine/safety.js';
import { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import type { LedgerEvent } from '../ledger/types.js';
import { readConfig } from '../store/config.js';
import { findRestorable } from '../store/restore.js';
import { scanAccount, summarise } from '../store/scanner.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { applyFilter, byRecency, parseSince, selectByIds, type SessionFilter } from './filters.js';
// Imported statically on purpose: a dynamic import makes the bundler emit a
// separate chunk, and the release ships (and checksums) a single file.
import { runInteractive } from './interactive.js';
import {
  accountTree,
  formatAge,
  formatDate,
  groupByAccount,
  outcomeLine,
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
 * The account the app currently populates its sidebar from.
 *
 * The organization is only discoverable from a directory name, so a brand-new
 * account — which has a config entry but no session directory yet — falls back to
 * the agent-mode tree the app creates before any Code session exists.
 */
function currentAccount(
  store: StoreLayout,
  accounts: AccountRef[],
  organizationUuid?: string,
): AccountRef | undefined {
  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) return undefined;
  if (organizationUuid) return { accountUuid, organizationUuid };

  // An account can own several organizations; only one is the directory the
  // sidebar reads, and the config does not record which.
  return (
    pickActiveOrganization(
      accounts.filter((account) => account.accountUuid === accountUuid),
      store,
    ) ?? listAgentAccountDirs(store).find((account) => account.accountUuid === accountUuid)
  );
}

function requireCurrentAccount(
  store: StoreLayout,
  accounts: AccountRef[],
  organizationUuid?: string,
): AccountRef {
  const account = currentAccount(store, accounts, organizationUuid);
  if (account) return account;

  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) {
    // Naming the store matters once profiles are in play: each one signs in
    // separately, and "open Claude Desktop once" reads as advice about the app
    // the reader already has open — which is usually the other installation.
    throw new Error(
      `No account is recorded for ${store.root}.\n` +
        'Open Claude Desktop on that installation and sign in once — each installation signs in separately.',
    );
  }
  throw new Error(
    `Found the signed-in account ${shortId(accountUuid)}, but not its organization: this account has no session directory yet.\n` +
      'Create one session in Claude Desktop so the directory exists, or pass --to-org <organizationUuid>.',
  );
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
    sources = matchOrExplain(
      sources,
      accountPrefix,
      'account',
      flags.account,
      (r) => r.accountUuid,
    );
  }
  if (organizationPrefix !== undefined) {
    sources = matchOrExplain(
      sources,
      organizationPrefix,
      'organization',
      flags.organization,
      (ref) => ref.organizationUuid,
    );
  }
  return sources;
}

/**
 * Narrows by identifier prefix, refusing rather than guessing.
 *
 * A bare prefix match would silently take every identifier sharing those leading
 * characters, and a typo would be indistinguishable from an empty result.
 */
function matchOrExplain(
  refs: AccountRef[],
  prefix: string,
  kind: 'account' | 'organization',
  flag: string,
  identifier: (ref: AccountRef) => string,
): AccountRef[] {
  const matches = refs.filter((ref) => identifier(ref).startsWith(prefix));
  const distinct = new Set(matches.map(identifier));

  if (distinct.size === 0) throw new Error(`No ${kind} matches ${flag} "${prefix}".`);
  if (distinct.size > 1) {
    // Full identifiers, not shortened ones: values that collide on a prefix
    // usually collide on their first characters too, so an abbreviation here
    // would print the same string twice and help nobody.
    const names = [...distinct].map((uuid) => `  ${uuid}`).join('\n');
    throw new Error(
      `${flag} "${prefix}" is ambiguous: it matches ${distinct.size} ${kind}s.\n${names}`,
    );
  }
  return matches;
}

function filterFrom(opts: {
  title?: string;
  cwd?: string;
  since?: string;
  all?: boolean;
}): SessionFilter {
  const filter: SessionFilter = { includeUnfosterable: opts.all ?? false };
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
    .option('--since <age>', 'only sessions active within this window, e.g. 30d');
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
  .command('scan')
  .description('read-only inventory of accounts and sessions')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const config = readConfig(store);
    const accounts = summarise(store, config.lastKnownAccountUuid);
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

    // Filter by account before reading files: the current account holds the most
    // sessions and every one of them would be discarded straight afterwards.
    const sources = resolveSources(
      accounts.filter((account) => account.accountUuid !== current?.accountUuid),
      opts.from,
      opts.fromOrg,
    );
    const candidates = byRecency(
      applyFilter(
        sources.flatMap((account) => scanAccount(sourceStore, account)),
        filterFrom(this.opts()),
      ),
    );

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
  let candidates = byRecency(
    applyFilter(
      sources.flatMap((account) => scanAccount(sourceStore, account)),
      filter,
    ),
  );

  if (opts.session?.length) {
    const { selected, unmatched } = selectByIds(candidates, opts.session);
    if (unmatched.length > 0) {
      throw new Error(
        `No session matches --session ${unmatched.join(', ')}.\nRun "foster list" to see the ids.`,
      );
    }
    candidates = byRecency(selected);
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

  if (dryRun) {
    console.log(
      pc.bold(`\nDry run: ${counts.fostered} would be fostered, ${counts.skipped} skipped.`),
    );
    console.log(pc.dim('Re-run with --yes to write.'));
    return;
  }

  console.log(
    pc.bold(`\n${counts.fostered} fostered, ${counts.skipped} skipped, ${counts.failed} failed.`),
  );
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
  .command('return')
  .description('remove fostered copies, restoring the previous state')
  .option('--title <text>', 'only fosterings whose original title contains this text')
  .option('--session <id...>', 'only these origin sessions, by id or unique prefix')
  .option('--all-stores', 'include copies written into other installations')
  .option('--restart', 'restart Claude Desktop afterwards')
  .option('--yes', 'actually remove; without it nothing is removed')
  .addOption(new Option('--dry-run', 'show what would happen and remove nothing').conflicts('yes'))
  .action(async function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{
      title?: string;
      session?: string[];
      allStores?: boolean;
      restart?: boolean;
      yes?: boolean;
      dryRun?: boolean;
    }>();

    let active = listActive(project(ledger.read()));

    // The ledger spans every installation foster has written into, so without
    // this a return run in one profile would quietly delete copies sitting in
    // another. Scoped to the store in use, and the rest are counted out loud.
    if (!opts.allStores) {
      const elsewhere = active.filter((f) => !samePath(storeRootOfCopy(f.copyPath), store.root));
      active = active.filter((f) => samePath(storeRootOfCopy(f.copyPath), store.root));
      if (elsewhere.length > 0) {
        console.log(
          pc.dim(
            `${elsewhere.length} more ${elsewhere.length === 1 ? 'copy is' : 'copies are'} in other installations — pass --all-stores to include them.`,
          ),
        );
      }
    }
    if (opts.title) {
      const needle = opts.title.toLowerCase();
      active = active.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(needle));
    }
    if (opts.session?.length) {
      const wanted = opts.session.map((id) => id.replace(/^local_/, '').toLowerCase());
      active = active.filter((f) =>
        wanted.some((id) =>
          f.originSessionId
            .replace(/^local_/, '')
            .toLowerCase()
            .startsWith(id),
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
    reportContinued(continued);
    await finish(store, Boolean(opts.restart));
  });

/**
 * Says out loud that a conversation carried on after it was fostered.
 *
 * The copy and the original are the same conversation, so nothing is lost when
 * the copy goes. But the card in the original account is frozen at the moment of
 * the foster, so the row comes back wearing an old date and an old title, which
 * reads exactly like work being rolled back. Better said than discovered.
 */
function reportContinued(continued: ContinuedFostering[]): void {
  if (continued.length === 0) return;

  const one = continued.length === 1;
  console.log(
    pc.dim(
      `${continued.length} of these carried on after being fostered. Nothing is lost: ${one ? 'it is' : 'they are'}\n` +
        `the same conversation, and opening ${one ? 'it' : 'them'} in the original account brings everything\n` +
        'back. Only the date and title on the row are the old ones, and the app refreshes\n' +
        'those as soon as you open it.',
    ),
  );
}

/** Shared tail of the two writing commands: restart now, or say why it matters. */
async function finish(store: StoreLayout, restart: boolean): Promise<void> {
  if (!restart) {
    console.log(
      pc.dim('Restart Claude Desktop to see the change, or re-run with --restart to do it here.'),
    );
    return;
  }
  await restartDesktop(store, false);
}

program
  .command('status')
  .description('what is currently fostered')
  .option('--json', 'machine-readable output')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const active = listActive(project(ledger.read()));

    if (this.opts<{ json?: boolean }>().json) {
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
    const elsewhere = active.filter((f) => !samePath(storeRootOfCopy(f.copyPath), store.root));
    // Marked here for the same reason it is said after a return: the row in the
    // original account still carries the date it had the day it was fostered.
    const continued = new Set(continuedSince(store, active).map((c) => c.fostering.copySessionId));

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
  .description('give an account UUID a human name')
  .argument('<accountUuid>')
  .argument('<label>')
  .action(function (this: Command, accountUuid: string, name: string) {
    const { ledger } = context(this);
    ledger.append({ kind: 'account_labelled', accountUuid, label: name });
    console.log(`Labelled ${shortId(accountUuid)} as ${pc.bold(name)}.`);
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

async function closeDesktop(store: StoreLayout, terminate: boolean): Promise<boolean> {
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
    console.log(
      pc.yellow(
        'Claude Desktop keeps running in its tray icon, so asking the window to close\n' +
          'would only hide it. Ending the process is the only way, and it skips the\n' +
          "app's shutdown: a change from the last few seconds may not be saved, and\n" +
          'Cowork sandboxes will not be stopped cleanly.\n' +
          'Re-run with --terminate to do it, or quit from the tray icon yourself.',
      ),
    );
    process.exitCode = 1;
    return false;
  }
  console.log(pc.yellow('Claude Desktop is still running. Quit it from the tray icon.'));
  process.exitCode = 1;
  return false;
}

async function restartDesktop(store: StoreLayout, terminate: boolean): Promise<void> {
  if (inspectApp(store).running && !(await closeDesktop(store, terminate))) return;
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
