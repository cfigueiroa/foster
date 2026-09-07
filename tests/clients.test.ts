import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { project, type LedgerState } from '../src/ledger/project.js';
import type { LedgerEventInput } from '../src/ledger/types.js';
import { listClients } from '../src/store/clients.js';
import { configDirCandidates, registeredClientDirs } from '../src/store/configDirs.js';

let home: string;
const env = {} as NodeJS.ProcessEnv;

/** A ledger state folded from the given events, without touching a real file twice. */
function ledgerState(...events: LedgerEventInput[]): LedgerState {
  const ledger = new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'foster-clients-ledger-')), 'ledger.jsonl'),
  );
  for (const event of events) ledger.append(event);
  return project(ledger.read());
}

/** A client directory with the CLI's most ordinary artefact: a projects tree. */
function client(name: string): string {
  const dir = path.join(home, name);
  mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

function transcript(dir: string, cliSessionId: string, mtimeMs?: number): string {
  const project = path.join(dir, 'projects', 'C--work');
  mkdirSync(project, { recursive: true });
  const file = path.join(project, `${cliSessionId}.jsonl`);
  writeFileSync(file, '{}\n', 'utf8');
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'foster-clients-'));
});

describe('configDirCandidates', () => {
  it('names the env dir, the default, extras, and every .claude* sibling', () => {
    client('.claude');
    client('.claude-work');
    const candidates = configDirCandidates(
      { CLAUDE_CONFIG_DIR: 'D:\\elsewhere' } as NodeJS.ProcessEnv,
      ['E:\\extra'],
      home,
    );
    expect(candidates).toContain('D:\\elsewhere');
    expect(candidates).toContain('E:\\extra');
    expect(candidates).toContain(path.join(home, '.claude'));
    expect(candidates).toContain(path.join(home, '.claude-work'));
  });

  // The guard D4 asks for: registered client roots feed listing and launch
  // only, through `registeredClientDirs`, and never through this enumeration —
  // otherwise they would reach `purge`, `restore` and `live --stop`, which all
  // read candidates from here.
  it('does not grow to include a registered client root or its children', () => {
    const container = path.join(home, 'accounts');
    mkdirSync(path.join(container, 'llm02', 'projects'), { recursive: true });
    const state = ledgerState({ kind: 'client_root_registered', root: container, as: 'container' });
    expect(registeredClientDirs(state)).toEqual([path.join(container, 'llm02')]);

    const candidates = configDirCandidates(env, [], home);
    expect(candidates).not.toContain(container);
    expect(candidates).not.toContain(path.join(container, 'llm02'));
  });
});

describe('listClients', () => {
  it('finds the default and every sibling that shows evidence of being one', () => {
    client('.claude');
    client('.claude-work');
    const dirs = listClients(env, [], [], () => true, home).map((c) => c.configDir);
    expect(dirs).toEqual([path.join(home, '.claude'), path.join(home, '.claude-work')]);
  });

  it('sorts the default first even when a sibling sorts before it by name', () => {
    client('.claude');
    client('.claude-aaa');
    const clients = listClients(env, [], [], () => true, home);
    expect(clients[0]!.isDefault).toBe(true);
    expect(clients[0]!.configDir).toBe(path.join(home, '.claude'));
  });

  it('lists an empty directory — a client between mkdir and its first run', () => {
    mkdirSync(path.join(home, '.claude-new'));
    const clients = listClients(env, [], [], () => true, home);
    expect(clients.map((c) => c.configDir)).toEqual([path.join(home, '.claude-new')]);
    expect(clients[0]).toMatchObject({ signedIn: false, conversations: 0, live: 0 });
  });

  it('does not list a .claude* directory holding only unrelated files', () => {
    const notes = path.join(home, '.claude-notes');
    mkdirSync(notes);
    writeFileSync(path.join(notes, 'ideas.md'), '# notes', 'utf8');
    expect(listClients(env, [], [], () => true, home)).toEqual([]);
  });

  it('does not list the home .claude.json file as a client', () => {
    client('.claude');
    writeJson(path.join(home, '.claude.json'), {});
    const dirs = listClients(env, [], [], () => true, home).map((c) => c.configDir);
    expect(dirs).toEqual([path.join(home, '.claude')]);
  });

  it('folds two spellings of one directory into one client', () => {
    const dir = client('.claude-work');
    // The same directory, spelled with a trailing separator: a different string,
    // deduplicated only by comparing paths the way paths are compared.
    const clients = listClients(env, [dir + path.sep], [], () => true, home);
    expect(clients).toHaveLength(1);
  });

  it('includes an explicit extra directory from elsewhere', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'foster-elsewhere-'));
    mkdirSync(path.join(elsewhere, 'projects'), { recursive: true });
    const clients = listClients(env, [elsewhere], [], () => true, home);
    expect(clients.map((c) => c.configDir)).toEqual([elsewhere]);
  });

  it('marks the directory the environment resolves to as in use', () => {
    client('.claude');
    const work = client('.claude-work');
    const clients = listClients(
      { CLAUDE_CONFIG_DIR: work } as NodeJS.ProcessEnv,
      [],
      [],
      () => true,
      home,
    );
    expect(clients.find((c) => c.configDir === work)?.inUse).toBe(true);
    expect(clients.find((c) => c.isDefault)?.inUse).toBe(false);
  });

  it('reads the default identity from ~/.claude.json, preferring it over a stale in-dir copy', () => {
    const dir = client('.claude');
    writeJson(path.join(home, '.claude.json'), {
      oauthAccount: {
        emailAddress: 'live@example.com',
        displayName: 'Live',
        userRateLimitTier: 'default_claude_max_20x',
      },
    });
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'stale@example.com' },
    });
    const [client0] = listClients(env, [], [], () => true, home);
    // "Max 20x", not "Max": the CLI records the same raw tier the app does, and
    // the size is the difference between two subscriptions at two prices.
    expect(client0!.identity).toEqual({ email: 'live@example.com', name: 'Live', plan: 'Max 20x' });
  });

  it('falls back to the in-dir copy when the home file has no identity', () => {
    const dir = client('.claude');
    writeJson(path.join(home, '.claude.json'), {});
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'indir@example.com' },
    });
    const [client0] = listClients(env, [], [], () => true, home);
    expect(client0!.identity?.email).toBe('indir@example.com');
  });

  it('reads a sibling identity from its own file only, never from the home one', () => {
    writeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'default@example.com' },
    });
    const work = client('.claude-work');
    writeJson(path.join(work, '.claude.json'), {
      oauthAccount: { emailAddress: 'work@example.com', organizationRateLimitTier: 'claude_pro' },
    });
    const clients = listClients(env, [], [], () => true, home);
    const sibling = clients.find((c) => c.configDir === work);
    expect(sibling?.identity).toEqual({ email: 'work@example.com', plan: 'Pro' });
  });

  it('treats a garbage config as no identity rather than an error', () => {
    const dir = client('.claude-work');
    writeFileSync(path.join(dir, '.claude.json'), 'not json at all', 'utf8');
    const [client0] = listClients(env, [], [], () => true, home);
    expect(client0!.identity).toBeUndefined();
  });

  it('counts a garbage credential as signed in, because the file is never parsed', () => {
    const dir = client('.claude-work');
    writeFileSync(path.join(dir, '.credentials.json'), '\u0000\u0001 torn', 'utf8');
    const [client0] = listClients(env, [], [], () => true, home);
    expect(client0!.signedIn).toBe(true);
  });

  it('reports an identity without a credential — a client someone signed out of', () => {
    const dir = client('.claude-work');
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'gone@example.com' },
    });
    const [client0] = listClients(env, [], [], () => true, home);
    expect(client0!.signedIn).toBe(false);
    expect(client0!.identity?.email).toBe('gone@example.com');
  });

  it('counts conversations and takes the newest transcript as last use', () => {
    const dir = client('.claude-work');
    transcript(dir, '00000000-0000-4000-8000-0000000000a1', 1_700_000_000_000);
    transcript(dir, '00000000-0000-4000-8000-0000000000a2', 1_700_000_500_000);
    const [client0] = listClients(env, [], [], () => true, home);
    expect(client0!.conversations).toBe(2);
    expect(client0!.lastUsedAt).toBe(1_700_000_500_000);
  });

  it('counts live processes from the sessions registry, only while their pid answers', () => {
    const dir = client('.claude-work');
    const sessions = path.join(dir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeJson(path.join(sessions, 'one.json'), { pid: 4242, sessionId: 'abc' });

    expect(listClients(env, [], [], () => true, home)[0]!.live).toBe(1);
    expect(listClients(env, [], [], () => false, home)[0]!.live).toBe(0);
  });

  it('does not include a registered root by default — the caller has to pass it', () => {
    const container = path.join(home, 'accounts');
    mkdirSync(path.join(container, 'llm02', 'projects'), { recursive: true });
    // No third argument at all: identify's call shape, which must keep seeing
    // nothing from the registry no matter what got registered.
    const clients = listClients(env, [], undefined, () => true, home);
    expect(clients).toEqual([]);
  });

  it('lists a registered client root and a container root child when passed explicitly', () => {
    const solo = path.join(home, 'solo-client');
    mkdirSync(path.join(solo, 'projects'), { recursive: true });
    const container = path.join(home, 'accounts');
    mkdirSync(path.join(container, 'llm02', 'projects'), { recursive: true });
    mkdirSync(path.join(container, 'notes'));
    writeFileSync(path.join(container, 'notes', 'ideas.md'), '# notes', 'utf8'); // no CLIENT_MARKS
    const state = ledgerState(
      { kind: 'client_root_registered', root: solo, as: 'client' },
      { kind: 'client_root_registered', root: container, as: 'container' },
    );
    const registered = registeredClientDirs(state);

    const dirs = listClients(env, [], registered, () => true, home).map((c) => c.configDir);
    expect(dirs).toEqual(expect.arrayContaining([solo, path.join(container, 'llm02')]));
    expect(dirs).not.toContain(path.join(container, 'notes'));
    expect(dirs).not.toContain(container);
  });

  it('still lists an explicit --config-dir extra alongside registered roots', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'foster-elsewhere-'));
    mkdirSync(path.join(elsewhere, 'projects'), { recursive: true });
    const container = path.join(home, 'accounts');
    mkdirSync(path.join(container, 'llm02', 'projects'), { recursive: true });
    const state = ledgerState({ kind: 'client_root_registered', root: container, as: 'container' });

    const dirs = listClients(env, [elsewhere], registeredClientDirs(state), () => true, home).map(
      (c) => c.configDir,
    );
    expect(dirs).toEqual(expect.arrayContaining([elsewhere, path.join(container, 'llm02')]));
  });

  // symlinkSync(..., 'junction') needs no elevation on Windows, unlike a file
  // symlink — but the type argument is meaningless off Windows, so this only
  // measures what it claims to measure there.
  it.skipIf(process.platform !== 'win32')(
    'folds a junction sibling onto the container child it names, keeping the target',
    () => {
      const container = path.join(home, 'accounts');
      const target = path.join(container, 'llm02');
      mkdirSync(path.join(target, 'projects'), { recursive: true });
      const state = ledgerState({
        kind: 'client_root_registered',
        root: container,
        as: 'container',
      });
      const registered = registeredClientDirs(state);

      const link = path.join(home, '.claude-frota');
      symlinkSync(target, link, 'junction');

      // Measured duplicate this fixes: before folding by directoryKey, the
      // junction sibling and the container's own child counted as two clients
      // for the one account behind them.
      const clients = listClients(env, [], registered, () => true, home);
      const matches = clients.filter((c) => c.configDir === link || c.configDir === target);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.configDir).toBe(link);
      expect(path.resolve(matches[0]!.linkTarget!)).toBe(path.resolve(target));
    },
  );
});

describe('registeredClientDirs', () => {
  it('returns a client root directly', () => {
    const solo = path.join(home, 'solo-client');
    mkdirSync(solo, { recursive: true });
    const state = ledgerState({ kind: 'client_root_registered', root: solo, as: 'client' });
    expect(registeredClientDirs(state)).toEqual([solo]);
  });

  it('walks a container root one level down, dropping a child that is not a client', () => {
    const container = path.join(home, 'accounts');
    mkdirSync(path.join(container, 'llm01', 'projects'), { recursive: true });
    mkdirSync(path.join(container, 'llm02', 'projects'), { recursive: true });
    mkdirSync(path.join(container, 'not-a-client')); // empty-of-marks, but not empty
    writeFileSync(path.join(container, 'not-a-client', 'ideas.md'), '# notes', 'utf8');
    const state = ledgerState({ kind: 'client_root_registered', root: container, as: 'container' });

    expect(registeredClientDirs(state)).toEqual(
      expect.arrayContaining([path.join(container, 'llm01'), path.join(container, 'llm02')]),
    );
    expect(registeredClientDirs(state)).not.toContain(path.join(container, 'not-a-client'));
  });

  it('does not descend past one level into a grandchild of a container', () => {
    const container = path.join(home, 'accounts');
    mkdirSync(path.join(container, 'llm01', 'nested', 'projects'), { recursive: true });
    const state = ledgerState({ kind: 'client_root_registered', root: container, as: 'container' });

    // llm01 itself has no marks of its own — only its grandchild does — so
    // neither it nor the grandchild is offered.
    expect(registeredClientDirs(state)).toEqual([]);
  });

  it('forgets a root once client_root_forgotten is folded over it', () => {
    const solo = path.join(home, 'solo-client');
    mkdirSync(solo, { recursive: true });
    const state = ledgerState(
      { kind: 'client_root_registered', root: solo, as: 'client' },
      { kind: 'client_root_forgotten', root: solo },
    );
    expect(registeredClientDirs(state)).toEqual([]);
  });
});
