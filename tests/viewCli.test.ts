import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeStore, NEW_ACCOUNT, session, writeSession } from './helpers/store.js';
import type { StoreLayout } from '../src/domain/types.js';

/**
 * `view set` and `view copy` had no `--json` at all (swarm package
 * cli-json-exit, item 5). Adding it surfaced a real, pre-existing bug this
 * test also guards: the parent `view` command already declares `--to` and
 * `--json` of its own (for the bare `foster view`), and Commander resolves a
 * flag against the first command in the chain that declares it — silently,
 * regardless of where on the command line it lands. `this.opts()` on `set`/
 * `copy` came back with neither `to` nor (once added) `json` at all;
 * `this.optsWithGlobals()` is the fix, verified here against a real fork in
 * `--to`'s ambiguity check and in the JSON output itself.
 *
 * Subprocess, not a rendering- or engine-level test, for the same reason
 * `consolidateCli.test.ts` is: `index.ts` runs the program on import
 * (`tests/helpGroups.test.ts`'s own note), so the CLI wiring itself —
 * Commander's own option resolution, in this case — can only be exercised by
 * actually running it.
 */

const TSX_CLI = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join('src', 'cli', 'index.ts');

function runCli(
  args: string[],
  env: { store: string; ledger: string },
): { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'foster-view-cli-home-'));
  try {
    const result = execFileSync(
      process.execPath,
      [TSX_CLI, CLI, '--store', env.store, '--ledger', env.ledger, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout: result, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** A store with one signed-in account, the way `requireCurrentAccount` needs. */
function signedInStore(): StoreLayout {
  const store = makeStore();
  writeSession(store, NEW_ACCOUNT, session());
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  return store;
}

describe('foster view set --json (CLI wiring)', () => {
  it('prints JSON, not the plain-text preview, once --json is passed after the subcommand', () => {
    const store = signedInStore();
    const ledgerPath = path.join(mkdtempSync(path.join(tmpdir(), 'foster-view-cli-l-')), 'l.jsonl');

    const result = runCli(['view', 'set', '--json', '--status', 'active'], {
      store: store.root,
      ledger: ledgerPath,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { dryRun: boolean; plan: { changes: unknown[] } };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan.changes).toHaveLength(1);
  }, 30_000);

  it('reaches its own --to as well, not just --json', () => {
    const store = makeStore();
    const ledgerPath = path.join(
      mkdtempSync(path.join(tmpdir(), 'foster-view-cli-l2-')),
      'l.jsonl',
    );
    const to = '00000000-0000-4000-8000-000000000099';

    const result = runCli(['view', 'set', '--to', to, '--status', 'active'], {
      store: store.root,
      ledger: ledgerPath,
    });

    // No such account here — proof `--to` actually reached `resolveDestination`
    // rather than being silently swallowed by the parent `view` command's own
    // `--to`, which would have fallen back to the (nonexistent) signed-in one
    // instead of naming this account at all.
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(to.slice(0, 8));
  }, 30_000);
});
