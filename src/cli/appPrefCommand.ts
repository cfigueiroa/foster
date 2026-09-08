import type { Command } from 'commander';
import pc from 'picocolors';
import { hostedByDesktop, quitDesktop, startDesktop, trayNote } from '../engine/desktop.js';
import { inspectApp } from '../engine/safety.js';
import {
  parsePrefValue,
  readAppPrefs,
  specOf,
  writeAppPref,
  type PrefReading,
  type PrefSpec,
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
 * Writing takes `--yes`, wants the app closed — it rewrites this file from
 * memory, so a write made underneath it can simply vanish — and says out loud
 * when the preference being changed is one the app puts in the way on purpose.
 * It does not refuse those: this is the user's machine and the user's settings,
 * and a tool that declines to change them is answering a question nobody asked.
 *
 * `--restart` closes the app, writes, and starts it again, because "close the
 * app first" is an instruction a tool that can close the app should not be
 * handing back. `--set` takes more than one change, so a run that has to stop
 * the app stops it once.
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
        'The app reads this file at start-up and rewrites it from memory, so a change wants the\n' +
        'app closed. --restart does that for you: closes it, writes, starts it again. --set can\n' +
        'be repeated, so several changes cost one stop.\n\n' +
        'Three of them decide what the app does to a Code session: ccBranchPrefix names the branch\n' +
        'a session creates, and ccMaxWarmWorktrees with ccWorktreeReapAfterHours decide when the\n' +
        'worktree it is sitting in gets reaped.',
    )
    .option('--all', 'include preferences that have never been set')
    .option(
      '--set <name=value...>',
      'change one preference; repeatable, and applied in one stop of the app',
    )
    .option('--unset', 'remove the setting, letting the app default take over')
    .option('--restart', 'close the app around the change and start it again')
    .option('--json', 'machine-readable output')
    .option('--yes', 'actually write; without it nothing is changed')
    .action(async function (this: Command, name: string | undefined, value: string | undefined) {
      const { store } = context(this);
      const opts = this.opts<{
        all?: boolean;
        set?: string[];
        unset?: boolean;
        restart?: boolean;
        json?: boolean;
        yes?: boolean;
      }>();

      const changes = plannedChanges(name, value, opts.set, Boolean(opts.unset));

      if (changes.length === 0) {
        if (name === undefined) {
          listPrefs(store, Boolean(opts.all), Boolean(opts.json));
          return;
        }
        readOne(store, name, Boolean(opts.json));
        return;
      }

      // Everything is parsed and checked before the app is touched. A typo in the
      // third of three values must not be discovered with the app already closed.
      const planned = changes.map((change) => resolve(store, change));

      for (const item of planned) {
        if (item.spec.guard) {
          console.log(
            pc.yellow(
              `${item.name} is one of the settings the app puts in the way on purpose — permissions,\n` +
                'trusted folders, private-network access or computer control. Changing it here does\n' +
                "what the app's own screen would do, without the screen that explains it.",
            ),
          );
        }
      }

      if (!opts.yes) {
        for (const item of planned) {
          console.log(
            `Would set ${pc.bold(item.name)}: ${format(item.from)} -> ${format(item.to)}` +
              (item.unset ? pc.dim(' (back to the default)') : ''),
          );
        }
        console.log(pc.dim('Re-run with --yes to write.'));
        return;
      }

      const running = inspectApp(store).running;
      if (running && !opts.restart) {
        throw new Error(
          'Claude Desktop is running, and it rewrites this file from memory — a change written\n' +
            'now can be lost without warning. Add --restart to close it, write, and start it again.',
        );
      }

      // Closing the app from a session it is hosting kills the session part-way
      // through, which is why quitDesktop refuses. Say so before writing rather
      // than after: a change applied with the app up is a change that may not
      // survive, and the user would have no reason to suspect it.
      if (running && hostedByDesktop(process.env)) {
        throw new Error(
          'foster is running inside Claude Desktop, so it cannot close the app to make this\n' +
            'change stick. Run the same command from a terminal outside the app.',
        );
      }

      let closed = false;
      if (running) {
        const result = await quitDesktop(store);
        if (result.outcome === 'needs-terminate' || result.outcome === 'hides-to-tray') {
          console.log(pc.yellow(trayNote('Re-run with --terminate')));
          process.exitCode = 1;
          return;
        }
        if (result.outcome !== 'quit' && result.outcome !== 'not-running') {
          throw new Error('Claude Desktop is still running; nothing was written.');
        }
        closed = true;
        console.log('Claude Desktop is closed.');
      }

      for (const item of planned) {
        const { write, backup } = writeAppPref(store, item.name, item.parsed, {
          ...(item.unset ? { unset: true } : {}),
        });
        console.log(
          `${pc.bold(write.name)}: ${format(write.from)} -> ${format(write.to)}` +
            (write.unset ? pc.dim(' (default)') : ''),
        );
        console.log(pc.dim(`  backup: ${backup}`));
      }

      if (closed) {
        await startDesktop(store);
        console.log('Claude Desktop is up.');
      } else {
        console.log(
          pc.dim('The app reads this at start-up; it will see the change when it opens.'),
        );
      }
    });
}

export interface Change {
  name: string;
  value?: string;
  unset: boolean;
}

/**
 * What this invocation was asked to change, from either spelling.
 *
 * `--set name=value` exists so that several changes cost one stop of the app;
 * the positional pair stays because one change is the common case and
 * `foster app pref sidebarMode code` reads better than the flag.
 */
export function plannedChanges(
  name: string | undefined,
  value: string | undefined,
  sets: string[] | undefined,
  unset: boolean,
): Change[] {
  const changes: Change[] = [];
  if (name !== undefined && (value !== undefined || unset)) {
    changes.push({ name, unset, ...(value === undefined ? {} : { value }) });
  }
  for (const pair of sets ?? []) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      throw new Error(`--set wants name=value, not "${pair}".`);
    }
    changes.push({ name: pair.slice(0, at), value: pair.slice(at + 1), unset: false });
  }
  return changes;
}

export interface Planned extends Change {
  spec: PrefSpec;
  parsed: unknown;
  from: unknown;
  to: unknown;
}

export function resolve(store: StoreLayout, change: Change): Planned {
  const spec = specOf(change.name);
  if (!spec) {
    throw new Error(
      `"${change.name}" is not a preference this build knows about. Run "foster app pref --all" to see the list.`,
    );
  }

  let parsed: unknown;
  if (!change.unset) {
    const outcome = parsePrefValue(spec, change.value ?? '');
    if (!outcome.ok) throw new Error(`${change.name} ${outcome.reason}.`);
    parsed = outcome.value;
  }

  const before = readAppPrefs(store, true).find((p) => p.name === change.name);
  return {
    ...change,
    spec,
    parsed,
    from: before?.value,
    to: change.unset ? spec.fallback : parsed,
  };
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
