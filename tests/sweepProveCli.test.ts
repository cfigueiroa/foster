import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster sweep --yes --prove --json` end to end — the one behaviour change
 * (D2, speed item) a rendering- or engine-level test cannot tell apart from
 * the bug it fixes: `runSweepCommand` (`src/cli/index.ts`) now reuses the
 * `Lineage`/scan `runSweep` itself built, through `onScan`, instead of
 * building a second one for `--prove`. On a real (`--yes`) run that reuse is
 * only safe for `kin` — the target's own cards have to be read *after* the
 * write, or `--prove` would measure the account exactly as it stood before
 * the sweep it is supposed to be auditing, and report a gap in a
 * conversation the very same run just closed.
 *
 * `index.ts` runs the program on import (`tests/helpGroups.test.ts`'s own
 * note), so the only way to exercise this wiring is a real subprocess — the
 * same approach `consolidateCli.test.ts` uses, and for the same reason.
 */

const TSX_CLI = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join('src', 'cli', 'index.ts');

const CONVERSATION = '00000000-0000-4000-8000-0000000000e1';

function record(id: string): string {
  return JSON.stringify({ uuid: id, type: 'user', timestamp: '2026-08-06T05:12:01.370Z' });
}

/** A `CLAUDE_CONFIG_DIR` whose `projects` folder holds one plain conversation. */
function configDir(): string {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-prove-cli-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${CONVERSATION}.jsonl`),
    `${[record('00000000-0000-4000-8000-0000000000e2')].join('\n')}\n`,
    'utf8',
  );
  return config;
}

function runCli(
  args: string[],
  env: { store: string; ledger: string; configDir: string },
): { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'foster-prove-cli-home-'));
  try {
    const result = execFileSync(
      process.execPath,
      [TSX_CLI, CLI, '--store', env.store, '--ledger', env.ledger, ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: env.configDir,
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout: result, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('foster sweep --prove --json (CLI wiring)', () => {
  it('proves complete after the very run that closed the gap, not against the scan it started with', () => {
    const store = makeStore();
    const cwd = configDir();
    const ledgerPath = path.join(
      mkdtempSync(path.join(tmpdir(), 'foster-prove-cli-l-')),
      'l.jsonl',
    );

    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000e3',
        cliSessionId: CONVERSATION,
        cwd: '/workspace/project',
        title: 'Work',
      }),
    );
    // `--to` has to resolve to a known account directory even with no card of
    // its own yet — the same setup `tests/sweep.test.ts` does directly.
    mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });

    const result = runCli(
      ['sweep', '--to', NEW_ACCOUNT.accountUuid, '--yes', '--prove', '--json'],
      { store: store.root, ledger: ledgerPath, configDir: cwd },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      fostered: { counts: { fostered: number } };
      prove: { conversations: number; gaps: unknown[]; complete: boolean };
    };
    expect(parsed.fostered.counts.fostered).toBe(1);
    // The whole point: the copy this very run just wrote is what `--prove`
    // has to see. Read against the pre-write scan instead, it would still
    // show the target holding nothing for this conversation.
    expect(parsed.prove.gaps).toEqual([]);
    expect(parsed.prove.complete).toBe(true);
  }, 30_000);
});
