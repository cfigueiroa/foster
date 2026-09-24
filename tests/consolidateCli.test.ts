import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeStore, NEW_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster consolidate --yes --json` used to print the plan and return before
 * `repointCards`/`returnFosterings` ever ran — `--yes --json` together wrote
 * nothing, silently, and exited 0 (swarm package cli-json-exit, item 1).
 *
 * `index.ts` runs the program on import (`tests/helpGroups.test.ts`'s own
 * note), so the only way to exercise the actual CLI wiring — as opposed to
 * the engine functions it calls, already covered by `consolidate.test.ts` —
 * is to run it as a real subprocess. Slow, and used sparingly: this is the
 * one behaviour change in this package that a rendering- or engine-level test
 * cannot tell apart from the bug it fixes.
 */

// Not the `.bin/tsx` shim: on Windows, `execFileSync` on a `.cmd` file needs a
// shell (`EINVAL` otherwise), and spawning through a shell is one more layer
// to get the quoting of a UUID-bearing argv right. `tsx`'s own CLI entry run
// under this same Node avoids both.
const TSX_CLI = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join('src', 'cli', 'index.ts');

const ROOT = '00000000-0000-4000-8000-0000000000e0';
const TRUNK = '00000000-0000-4000-8000-0000000000e1';
const TIP = '00000000-0000-4000-8000-0000000000e2';

function record(id: string): string {
  return JSON.stringify({ uuid: id, type: 'user', timestamp: '2026-08-06T05:12:01.370Z' });
}

const META = JSON.stringify({ type: 'custom-title', customTitle: 'Work' });

/** A CLAUDE_CONFIG_DIR whose `projects` folder holds one lopsided fork. */
function configDir(): string {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-cs-cli-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  const shared = [record(ROOT), record('00000000-0000-4000-8000-0000000000e3')];
  writeFileSync(path.join(dir, `${TRUNK}.jsonl`), `${[META, ...shared].join('\n')}\n`, 'utf8');
  writeFileSync(
    path.join(dir, `${TIP}.jsonl`),
    `${[META, ...shared, ...Array.from({ length: 4 }, (_, i) => record(`00000000-0000-4000-8000-0000000000e${4 + i}`))].join('\n')}\n`,
    'utf8',
  );
  return config;
}

/** Runs the real CLI as a subprocess, isolated from this machine's own home. */
function runCli(
  args: string[],
  env: { store: string; ledger: string; configDir: string },
): { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'foster-cs-cli-home-'));
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

describe('foster consolidate --json (CLI wiring)', () => {
  it('--yes --json actually writes before it reports, and reports what it wrote', () => {
    const store = makeStore();
    const cwd = configDir();
    const ledgerPath = path.join(mkdtempSync(path.join(tmpdir(), 'foster-cs-cli-l-')), 'l.jsonl');

    const cardPath = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000e9', cliSessionId: TRUNK }),
    );
    // The other half, carded in an account next door, so the fork is visible.
    writeSession(
      store,
      {
        accountUuid: '00000000-0000-4000-8000-000000000001',
        organizationUuid: '00000000-0000-4000-8000-000000000002',
      },
      session({ sessionId: '00000000-0000-4000-8000-0000000000ea', cliSessionId: TIP }),
    );

    const result = runCli(['consolidate', '--to', NEW_ACCOUNT.accountUuid, '--yes', '--json'], {
      store: store.root,
      ledger: ledgerPath,
      configDir: cwd,
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      entries: Array<{ status: string; repoint: { from: string; to: string } | null }>;
      moved: Array<{ status: string }>;
      removed: Array<{ status: string }>;
      restart: { requested: boolean; done: boolean };
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.status).toBe('consolidate');
    expect(parsed.entries[0]!.repoint).toMatchObject({ from: TRUNK, to: TIP });
    expect(parsed.moved).toHaveLength(1);
    expect(parsed.moved[0]!.status).toBe('repointed');
    // No `--restart` on the command line: `restartAround` still runs (review
    // finding, swarm package cli-json-exit) but short-circuits before touching
    // the process table or the app, and the field says so rather than being
    // silently absent the way it used to be.
    expect(parsed.restart).toMatchObject({ requested: false, done: false });

    // The proof that this is not just a plan echoed back: the card on disk
    // was actually rewritten to point at the tip.
    const onDisk = JSON.parse(readFileSync(cardPath, 'utf8')) as { cliSessionId: string };
    expect(onDisk.cliSessionId).toBe(TIP);
  }, 30_000);

  it('--json alone (no --yes) writes nothing', () => {
    const store = makeStore();
    const cwd = configDir();
    const ledgerPath = path.join(mkdtempSync(path.join(tmpdir(), 'foster-cs-cli-l2-')), 'l.jsonl');

    const cardPath = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000eb', cliSessionId: TRUNK }),
    );
    writeSession(
      store,
      {
        accountUuid: '00000000-0000-4000-8000-000000000001',
        organizationUuid: '00000000-0000-4000-8000-000000000002',
      },
      session({ sessionId: '00000000-0000-4000-8000-0000000000ec', cliSessionId: TIP }),
    );
    const before = readFileSync(cardPath, 'utf8');

    const result = runCli(['consolidate', '--to', NEW_ACCOUNT.accountUuid, '--json'], {
      store: store.root,
      ledger: ledgerPath,
      configDir: cwd,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{ status: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.status).toBe('consolidate');
    expect(readFileSync(cardPath, 'utf8')).toBe(before);
  }, 30_000);

  it('--undo --yes --json also writes before it reports, and carries the same restart field', () => {
    const store = makeStore();
    const cwd = configDir();
    const ledgerPath = path.join(mkdtempSync(path.join(tmpdir(), 'foster-cs-cli-l3-')), 'l.jsonl');

    const cardPath = writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ed', cliSessionId: TRUNK }),
    );
    writeSession(
      store,
      {
        accountUuid: '00000000-0000-4000-8000-000000000001',
        organizationUuid: '00000000-0000-4000-8000-000000000002',
      },
      session({ sessionId: '00000000-0000-4000-8000-0000000000ee', cliSessionId: TIP }),
    );

    const env = { store: store.root, ledger: ledgerPath, configDir: cwd };
    const consolidated = runCli(
      ['consolidate', '--to', NEW_ACCOUNT.accountUuid, '--yes', '--json'],
      env,
    );
    expect(consolidated.status).toBe(0);
    expect(JSON.parse(readFileSync(cardPath, 'utf8')).cliSessionId).toBe(TIP);

    const result = runCli(['consolidate', '--undo', '--yes', '--json'], env);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      outcomes: Array<{ status: string }>;
      restart: { requested: boolean; done: boolean };
    };
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0]!.status).toBe('repointed');
    // Same fix as the forward path: `--undo --yes --json` used to return
    // before `finish` ever ran, so a `--restart` passed alongside it was
    // silently dropped with no trace in the JSON.
    expect(parsed.restart).toMatchObject({ requested: false, done: false });

    // The write landed, not just the plan: the card is back on the trunk.
    expect(JSON.parse(readFileSync(cardPath, 'utf8')).cliSessionId).toBe(TRUNK);
  }, 30_000);
});
