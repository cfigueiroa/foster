import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { commandPath } from '../src/cli/commandPath.js';

/**
 * `preAction` used to match by `command.name()` alone, so `foster app status`
 * tripped the same `identifyHeldAccounts` network call the bare, top-level
 * `foster status` is meant to (swarm package cli-json-exit, item 7) — both
 * leaves are named `status`, and only one of them is in `NAMES_ACCOUNTS`.
 */
describe('commandPath', () => {
  function program(): Command {
    const program = new Command('foster');
    program.command('status');
    program.command('sweep');
    const app = program.command('app');
    app.command('status');
    const view = program.command('view');
    view.command('set');
    return program;
  }

  it('names a top-level command by itself', () => {
    const cli = program();
    expect(commandPath(cli.commands.find((c) => c.name() === 'status')!)).toBe('status');
    expect(commandPath(cli.commands.find((c) => c.name() === 'sweep')!)).toBe('sweep');
  });

  it('prefixes a subcommand with its parent, so it never collides with an unrelated top-level name', () => {
    const cli = program();
    const app = cli.commands.find((c) => c.name() === 'app')!;
    const appStatus = app.commands.find((c) => c.name() === 'status')!;
    expect(commandPath(appStatus)).toBe('app status');
    expect(commandPath(appStatus)).not.toBe(
      commandPath(cli.commands.find((c) => c.name() === 'status')!),
    );
  });

  it('walks more than one level', () => {
    const cli = program();
    const view = cli.commands.find((c) => c.name() === 'view')!;
    const set = view.commands.find((c) => c.name() === 'set')!;
    expect(commandPath(set)).toBe('view set');
  });
});
