// The shebang is added by the bundler (see tsup.config.ts), not here.
import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import {
  candidateStoreRoots,
  layoutFor,
  listAccountDirs,
  listAgentAccountDirs,
  resolveStore,
} from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { inspectApp } from '../engine/safety.js';
import { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import { readConfig } from '../store/config.js';
import { scanAccount, summarise } from '../store/scanner.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { applyFilter, byRecency, parseSince, type SessionFilter } from './filters.js';
// Imported statically on purpose: a dynamic import makes the bundler emit a
// separate chunk, and the release ships (and checksums) a single file.
import { runInteractive } from './interactive.js';
import {
  formatDate,
  outcomeLine,
  restartNotice,
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
  const store = resolveStore(opts.store);
  const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();
  return { store, ledger };
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

  return (
    accounts.find((account) => account.accountUuid === accountUuid) ??
    listAgentAccountDirs(store).find((account) => account.accountUuid === accountUuid)
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
    throw new Error(
      'Could not determine the account currently signed in. Open Claude Desktop once, then try again.',
    );
  }
  throw new Error(
    `Found the signed-in account ${shortId(accountUuid)}, but not its organization: this account has no session directory yet.\n` +
      'Create one session in Claude Desktop so the directory exists, or pass --org <organizationUuid>.',
  );
}

/**
 * Resolve --from against the accounts on disk.
 *
 * A bare prefix match would silently foster from every account sharing those
 * leading characters, and a typo would be indistinguishable from an empty
 * result, so both are reported instead.
 */
function resolveSources(accounts: AccountRef[], prefix: string | undefined): AccountRef[] {
  if (prefix === undefined) return accounts;

  const matches = accounts.filter((account) => account.accountUuid.startsWith(prefix));
  const distinct = new Set(matches.map((account) => account.accountUuid));

  if (distinct.size === 0) throw new Error(`No account matches --from "${prefix}".`);
  if (distinct.size > 1) {
    // Full identifiers, not shortened ones: accounts that collide on a prefix
    // usually collide on their first characters too, so an abbreviation here
    // would print the same string twice and help nobody.
    const names = [...distinct].map((uuid) => `  ${uuid}`).join('\n');
    throw new Error(
      `--from "${prefix}" is ambiguous: it matches ${distinct.size} accounts.\n${names}`,
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

program
  .command('doctor')
  .description('check the environment before doing anything else')
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals<GlobalOptions>();
    const roots = candidateStoreRoots();

    console.log(pc.bold('foster'));
    console.log(`  ${updateLine(await checkForUpdate())}`);

    console.log(pc.bold('Store'));
    if (roots.length === 0 && !opts.store) {
      console.log(pc.red('  no Claude Desktop store found — pass --store <path>'));
      process.exitCode = 1;
      return;
    }
    // Reuse the roots already probed rather than walking the package directory twice.
    const store = opts.store ? resolveStore(opts.store) : layoutFor(roots[0]!);
    console.log(`  ${store.root}`);
    if (roots.length > 1)
      console.log(pc.yellow(`  (${roots.length} candidates found, using the first)`));

    const config = readConfig(store);
    console.log(pc.bold('App'));
    // This is the release the updater last saw, which can run ahead of the
    // installed build, so it is labelled for what it is.
    console.log(`  updater sees  ${config.updaterLastSeenVersion ?? 'unknown'}`);
    console.log(`  account       ${config.lastKnownAccountUuid ?? 'unknown'}`);

    const app = inspectApp(store);
    console.log(pc.bold('State'));
    if (app.running) {
      console.log(pc.yellow(`  Claude Desktop is running (${app.evidence.join('; ')})`));
      console.log(pc.dim('  Reading is fine; quit it before fostering or returning.'));
    } else {
      console.log(pc.green('  Claude Desktop is not running — safe to write'));
    }
  });

program
  .command('scan')
  .description('read-only inventory of accounts and sessions')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const config = readConfig(store);
    const accounts = summarise(store, config.lastKnownAccountUuid);
    const labels = project(ledger.read()).labels;

    if (accounts.length === 0) {
      console.log('No account directories found.');
      return;
    }

    for (const entry of accounts) {
      const label = labels.get(entry.account.accountUuid);
      const marker = entry.isCurrent ? pc.green(' (current)') : '';
      const name = label
        ? `${label} ${pc.dim(shortId(entry.account.accountUuid))}`
        : shortId(entry.account.accountUuid);
      console.log(`${pc.bold(name)}${marker}`);
      console.log(`  organization ${shortId(entry.account.organizationUuid)}`);
      console.log(`  ${entry.nativeCount} own, ${entry.copyCount} fostered in`);
    }
  });

filterOptions(program.command('list').description('list sessions available to foster'))
  .option('--all', 'also show sessions that could never appear in the sidebar')
  .action(function (this: Command) {
    const { store } = context(this);
    const accounts = listAccountDirs(store);
    const current = currentAccount(store, accounts);
    const filter = filterFrom(this.opts());

    // Filter by account before reading files: the current account holds the most
    // sessions and every one of them would be discarded straight afterwards.
    const candidates = byRecency(
      applyFilter(
        accounts
          .filter((account) => account.accountUuid !== current?.accountUuid)
          .flatMap((account) => scanAccount(store, account)),
        filter,
      ),
    );

    if (candidates.length === 0) {
      console.log('Nothing matches.');
      return;
    }

    for (const session of candidates) console.log(sessionLine(session));
    console.log(pc.bold(`\n${candidates.length} session(s)`));
  });

filterOptions(
  program
    .command('foster')
    .description('copy sessions from another account into the current one')
    .option('--from <accountUuid>', 'origin account (defaults to every non-current account)')
    .option('--org <organizationUuid>', 'target organization, for an account with no sessions yet')
    .option('--prefix <text>', 'title prefix marking fostered sessions', DEFAULT_PREFIX)
    .option('--yes', 'skip the confirmation and write')
    .option('--dry-run', 'show what would happen and write nothing'),
).action(function (this: Command) {
  const { store, ledger } = context(this);
  const opts = this.opts<{
    title?: string;
    cwd?: string;
    since?: string;
    from?: string;
    org?: string;
    prefix: string;
    yes?: boolean;
    dryRun?: boolean;
  }>();

  const accounts = listAccountDirs(store);
  const target = requireCurrentAccount(store, accounts, opts.org);
  const filter = filterFrom(opts);

  const sources = resolveSources(
    accounts.filter((account) => account.accountUuid !== target.accountUuid),
    opts.from,
  );

  // Sessions that can never appear in the sidebar are always excluded here:
  // offering them would only produce copies the app silently never lists.
  const candidates = byRecency(
    applyFilter(
      sources.flatMap((account) => scanAccount(store, account)),
      filter,
    ),
  );

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
    prefix: opts.prefix,
    dryRun,
  });

  for (const outcome of outcomes) console.log(outcomeLine(outcome));
  const counts = summariseOutcomes(outcomes);

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
  console.log(restartNotice());
});

program
  .command('return')
  .description('remove fostered copies, restoring the previous state')
  .option('--title <text>', 'only fosterings whose original title contains this text')
  .option('--yes', 'skip the confirmation and remove')
  .option('--dry-run', 'show what would happen and remove nothing')
  .action(function (this: Command) {
    const { store, ledger } = context(this);
    const opts = this.opts<{ title?: string; yes?: boolean; dryRun?: boolean }>();

    let active = listActive(project(ledger.read()));
    if (opts.title) {
      const needle = opts.title.toLowerCase();
      active = active.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(needle));
    }

    if (active.length === 0) {
      console.log('Nothing is fostered.');
      return;
    }

    const dryRun = opts.dryRun || !opts.yes;
    const outcomes = returnFosterings(active, { store, ledger, dryRun });
    for (const outcome of outcomes) console.log(outcomeLine(outcome));

    const counts = summariseOutcomes(outcomes);
    if (dryRun) {
      console.log(pc.bold(`\nDry run: ${counts.returned} would be returned.`));
      console.log(pc.dim('Re-run with --yes to remove.'));
      return;
    }

    console.log(pc.bold(`\n${counts.returned} returned, ${counts.failed} failed.`));
    console.log(restartNotice());
  });

program
  .command('status')
  .description('what is currently fostered')
  .action(function (this: Command) {
    const { ledger } = context(this);
    const active = listActive(project(ledger.read()));

    if (active.length === 0) {
      console.log('Nothing is fostered.');
      return;
    }

    for (const fostering of active) {
      console.log(
        `  ${pc.dim(formatDate(fostering.fosteredAt))}  ${fostering.originalTitle ?? shortId(fostering.originSessionId)}  ${pc.dim(`from ${shortId(fostering.origin.accountUuid)}`)}`,
      );
    }
    console.log(pc.bold(`\n${active.length} active fostering(s)`));
    console.log(pc.dim(`Ledger: ${ledger.path}`));
  });

program
  .command('label')
  .description('give an account UUID a human name')
  .argument('<accountUuid>')
  .argument('<label>')
  .action(function (this: Command, accountUuid: string, label: string) {
    const { ledger } = context(this);
    ledger.append({ kind: 'account_labelled', accountUuid, label });
    console.log(`Labelled ${shortId(accountUuid)} as ${pc.bold(label)}.`);
  });

try {
  program.parse();
} catch (error) {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
