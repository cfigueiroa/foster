// The shebang is added by the bundler (see tsup.config.ts), not here.
import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import { candidateStoreRoots, listAccountDirs, resolveStore } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { inspectApp } from '../engine/safety.js';
import { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import { readConfig } from '../store/config.js';
import { scanAccount, scanStore, summarise } from '../store/scanner.js';
import { VERSION } from '../version.js';
import { applyFilter, byRecency, parseSince, type SessionFilter } from './filters.js';
import { formatDate, outcomeLine, restartNotice, sessionLine, shortId } from './render.js';

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
  .option('--ledger <path>', "path to foster's ledger file");

function context(command: Command): { store: StoreLayout; ledger: Ledger } {
  const opts = command.optsWithGlobals<GlobalOptions>();
  const store = resolveStore(opts.store);
  const ledger = opts.ledger ? new Ledger(opts.ledger) : new Ledger();
  return { store, ledger };
}

/** The account the app currently populates its sidebar from. */
function currentAccount(store: StoreLayout): AccountRef | undefined {
  const uuid = readConfig(store).lastKnownAccountUuid;
  if (!uuid) return undefined;
  return listAccountDirs(store).find((account) => account.accountUuid === uuid);
}

function requireCurrentAccount(store: StoreLayout): AccountRef {
  const account = currentAccount(store);
  if (!account) {
    throw new Error(
      'Could not determine the account currently signed in. Open Claude Desktop once, then try again.',
    );
  }
  return account;
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

function selectionOptions(command: Command): Command {
  return command
    .option('--title <text>', 'only sessions whose title contains this text')
    .option('--cwd <text>', 'only sessions whose working directory contains this text')
    .option('--since <age>', 'only sessions active within this window, e.g. 30d')
    .option('--all', 'include sessions that cannot appear in the sidebar');
}

program
  .command('doctor')
  .description('check the environment before doing anything else')
  .action(function (this: Command) {
    const opts = this.optsWithGlobals<GlobalOptions>();
    const roots = candidateStoreRoots();

    console.log(pc.bold('Store'));
    if (roots.length === 0 && !opts.store) {
      console.log(pc.red('  no Claude Desktop store found — pass --store <path>'));
      process.exitCode = 1;
      return;
    }
    const store = resolveStore(opts.store);
    console.log(`  ${store.root}`);
    if (roots.length > 1)
      console.log(pc.yellow(`  (${roots.length} candidates found, using the first)`));

    const config = readConfig(store);
    console.log(pc.bold('App'));
    console.log(`  version   ${config.appVersion ?? 'unknown'}`);
    console.log(`  account   ${config.lastKnownAccountUuid ?? 'unknown'}`);

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

selectionOptions(program.command('list').description('list sessions available to foster')).action(
  function (this: Command) {
    const { store } = context(this);
    const current = currentAccount(store);
    const filter = filterFrom(this.opts());

    const candidates = byRecency(
      applyFilter(
        scanStore(store).filter((s) => s.account.accountUuid !== current?.accountUuid),
        filter,
      ),
    );

    if (candidates.length === 0) {
      console.log('Nothing matches.');
      return;
    }

    for (const session of candidates) console.log(sessionLine(session));
    console.log(pc.bold(`\n${candidates.length} session(s)`));
  },
);

selectionOptions(
  program
    .command('foster')
    .description('copy sessions from another account into the current one')
    .option('--from <accountUuid>', 'origin account (defaults to every non-current account)')
    .option('--prefix <text>', 'title prefix marking fostered sessions', DEFAULT_PREFIX)
    .option('--yes', 'skip the confirmation and write')
    .option('--dry-run', 'show what would happen and write nothing'),
).action(function (this: Command) {
  const { store, ledger } = context(this);
  const opts = this.opts<{ from?: string; prefix: string; yes?: boolean; dryRun?: boolean }>();
  const target = requireCurrentAccount(store);
  const filter = filterFrom(this.opts());

  const sources = listAccountDirs(store).filter(
    (account) =>
      account.accountUuid !== target.accountUuid &&
      (!opts.from || account.accountUuid.startsWith(opts.from)),
  );

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
