import type { Command } from 'commander';
import pc from 'picocolors';
import { inspectApp } from '../engine/safety.js';
import {
  parsePrefValue,
  readAppPrefs,
  specOf,
  writeAppPref,
  type PrefReading,
} from '../store/appPrefs.js';
import type { StoreLayout } from '../domain/types.js';

/**
 * `foster app pref` — the app's own settings, read and written where the app
 * keeps them.
 *
 * Reading is the half that pays for itself immediately: several of these decide
 * what the app does to a Code session, and foster spent three releases guessing
 * at one of them (#87, #89, #92). `ccMaxWarmWorktrees` and
 * `ccWorktreeReapAfterHours` are the pair that reaps the worktree a session is
 * sitting in; `ccBranchPrefix` names the branch it creates.
 *
 * Writing takes `--yes`, refuses while the app is running — it rewrites this
 * file from memory, so a write made underneath it can simply vanish — and says
 * out loud when the preference being changed is one the app puts in the way on
 * purpose. It does not refuse those: this is the user's machine and the user's
 * settings, and a tool that declines to change them is answering a question
 * nobody asked.
 */
export function registerAppPref(
  app: Command,
  context: (command: Command) => { store: StoreLayout },
): void {
  app
    .command('pref [name] [value]')
    .summary("read or change Claude Desktop's own settings")
    .description(
      'Claude Desktop keeps its preferences in claude_desktop_config.json, under a top-level\n' +
        '`preferences` object, with its own defaults underneath — so a setting nobody has touched\n' +
        'is absent rather than written out.\n\n' +
        'With no name, lists what has been set. --all lists every preference this build knows,\n' +
        'default included. With a name, reads one; with a name and a value, changes it.\n\n' +
        'Three of them decide what the app does to a Code session: ccBranchPrefix names the branch\n' +
        'a session creates, and ccMaxWarmWorktrees with ccWorktreeReapAfterHours decide when the\n' +
        'worktree it is sitting in gets reaped.',
    )
    .option('--all', 'include preferences that have never been set')
    .option('--unset', 'remove the setting, letting the app default take over')
    .option('--json', 'machine-readable output')
    .option('--yes', 'actually write; without it nothing is changed')
    .action(function (this: Command, name: string | undefined, value: string | undefined) {
      const { store } = context(this);
      const opts = this.opts<{
        all?: boolean;
        unset?: boolean;
        json?: boolean;
        yes?: boolean;
      }>();

      if (name === undefined) {
        listPrefs(store, Boolean(opts.all), Boolean(opts.json));
        return;
      }

      const spec = specOf(name);
      if (value === undefined && !opts.unset) {
        readOne(store, name, Boolean(opts.json));
        return;
      }

      if (!spec) {
        throw new Error(
          `"${name}" is not a preference this build knows about. Run "foster app pref --all" to see the list.`,
        );
      }

      // Parsed before anything else is decided, so a typo in the value is a
      // refusal rather than a backup file and a half-finished change.
      let parsed: unknown;
      if (!opts.unset) {
        const outcome = parsePrefValue(spec, value ?? '');
        if (!outcome.ok) throw new Error(`${name} ${outcome.reason}.`);
        parsed = outcome.value;
      }

      const before = readAppPrefs(store, true).find((p) => p.name === name);
      const to = opts.unset ? spec.fallback : parsed;

      if (spec.guard) {
        console.log(
          pc.yellow(
            `${name} is one of the settings the app puts in the way on purpose — permissions,\n` +
              'trusted folders, private-network access or computer control. Changing it here does\n' +
              "what the app's own screen would do, without the screen that explains it.",
          ),
        );
      }

      if (!opts.yes) {
        console.log(
          `Would set ${pc.bold(name)}: ${format(before?.value)} -> ${format(to)}${opts.unset ? pc.dim(' (back to the default)') : ''}`,
        );
        console.log(pc.dim('Re-run with --yes to write.'));
        return;
      }

      // The app rewrites this file from what it holds in memory, so a write made
      // while it is up can be undone by the next thing the user clicks.
      const running = inspectApp(store);
      if (running.running) {
        throw new Error(
          'Claude Desktop is running, and it rewrites this file from memory — a change written\n' +
            'now can be lost without warning. Close it first: foster app quit.',
        );
      }

      const { write, backup } = writeAppPref(store, name, parsed, {
        ...(opts.unset ? { unset: true } : {}),
      });
      console.log(
        `${pc.bold(write.name)}: ${format(write.from)} -> ${format(write.to)}${write.unset ? pc.dim(' (default)') : ''}`,
      );
      console.log(pc.dim(`  backup: ${backup}`));
      console.log(pc.dim('  the app reads this at start-up; restart it to see the change.'));
    });
}

function format(value: unknown): string {
  if (value === undefined) return pc.dim('(absent)');
  return JSON.stringify(value);
}

/**
 * The same value, cut down to something a list can hold.
 *
 * Several of these are maps keyed by account, or the whole sidebar state; one of
 * them printed in full is longer than the rest of the listing put together, and
 * it carries identifiers that have no business scrolling past on a shared
 * screen. The full value is one `foster app pref <name>` away, or `--json`.
 */
function short(value: unknown, width = 56): string {
  const text = format(value);
  if (value === undefined || text.length <= width) return text;
  const kind = Array.isArray(value) ? 'list' : 'object';
  const size = Array.isArray(value)
    ? `${value.length} item(s)`
    : `${Object.keys(value as object).length} key(s)`;
  return typeof value === 'object' && value !== null
    ? pc.dim(`(${kind}, ${size})`)
    : `${text.slice(0, width - 1)}…`;
}

function listPrefs(store: StoreLayout, all: boolean, json: boolean): void {
  const rows = readAppPrefs(store, all);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No preference has been set; the app is running on its defaults.');
    console.log(pc.dim('foster app pref --all lists every one this build knows.'));
    return;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const row of rows) {
    const mark = row.spec.guard ? pc.yellow(' !') : '  ';
    const where = row.stored ? '' : pc.dim(' (default)');
    console.log(`${row.name.padEnd(width)}${mark} ${short(row.value)}${where}`);
  }
  console.log('');
  console.log(
    pc.dim(
      `${rows.filter((r) => r.stored).length} set, ${rows.length} listed` +
        (rows.some((r) => r.spec.guard) ? ' · ! marks a setting the app guards' : ''),
    ),
  );
}

function readOne(store: StoreLayout, name: string, json: boolean): void {
  const row: PrefReading | undefined = readAppPrefs(store, true).find((p) => p.name === name);
  if (!row) {
    throw new Error(
      `"${name}" is not a preference this build knows about. Run "foster app pref --all" to see the list.`,
    );
  }
  if (json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  console.log(`${row.name} ${format(row.value)}${row.stored ? '' : pc.dim(' (default)')}`);
  if (row.spec.choices) console.log(pc.dim(`  one of: ${row.spec.choices.join(', ')}`));
  if (row.spec.guard) console.log(pc.yellow('  the app guards this one on purpose'));
}
