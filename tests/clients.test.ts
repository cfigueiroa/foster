import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listClients } from '../src/store/clients.js';
import { configDirCandidates } from '../src/store/configDirs.js';

let home: string;
const env = {} as NodeJS.ProcessEnv;

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
});

describe('listClients', () => {
  it('finds the default and every sibling that shows evidence of being one', () => {
    client('.claude');
    client('.claude-work');
    const dirs = listClients(env, [], () => true, home).map((c) => c.configDir);
    expect(dirs).toEqual([path.join(home, '.claude'), path.join(home, '.claude-work')]);
  });

  it('sorts the default first even when a sibling sorts before it by name', () => {
    client('.claude');
    client('.claude-aaa');
    const clients = listClients(env, [], () => true, home);
    expect(clients[0]!.isDefault).toBe(true);
    expect(clients[0]!.configDir).toBe(path.join(home, '.claude'));
  });

  it('lists an empty directory — a client between mkdir and its first run', () => {
    mkdirSync(path.join(home, '.claude-new'));
    const clients = listClients(env, [], () => true, home);
    expect(clients.map((c) => c.configDir)).toEqual([path.join(home, '.claude-new')]);
    expect(clients[0]).toMatchObject({ signedIn: false, conversations: 0, live: 0 });
  });

  it('does not list a .claude* directory holding only unrelated files', () => {
    const notes = path.join(home, '.claude-notes');
    mkdirSync(notes);
    writeFileSync(path.join(notes, 'ideas.md'), '# notes', 'utf8');
    expect(listClients(env, [], () => true, home)).toEqual([]);
  });

  it('does not list the home .claude.json file as a client', () => {
    client('.claude');
    writeJson(path.join(home, '.claude.json'), {});
    const dirs = listClients(env, [], () => true, home).map((c) => c.configDir);
    expect(dirs).toEqual([path.join(home, '.claude')]);
  });

  it('folds two spellings of one directory into one client', () => {
    const dir = client('.claude-work');
    // The same directory, spelled with a trailing separator: a different string,
    // deduplicated only by comparing paths the way paths are compared.
    const clients = listClients(env, [dir + path.sep], () => true, home);
    expect(clients).toHaveLength(1);
  });

  it('includes an explicit extra directory from elsewhere', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'foster-elsewhere-'));
    mkdirSync(path.join(elsewhere, 'projects'), { recursive: true });
    const clients = listClients(env, [elsewhere], () => true, home);
    expect(clients.map((c) => c.configDir)).toEqual([elsewhere]);
  });

  it('marks the directory the environment resolves to as in use', () => {
    client('.claude');
    const work = client('.claude-work');
    const clients = listClients(
      { CLAUDE_CONFIG_DIR: work } as NodeJS.ProcessEnv,
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
    const [client0] = listClients(env, [], () => true, home);
    expect(client0!.identity).toEqual({ email: 'live@example.com', name: 'Live', plan: 'Max' });
  });

  it('falls back to the in-dir copy when the home file has no identity', () => {
    const dir = client('.claude');
    writeJson(path.join(home, '.claude.json'), {});
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'indir@example.com' },
    });
    const [client0] = listClients(env, [], () => true, home);
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
    const clients = listClients(env, [], () => true, home);
    const sibling = clients.find((c) => c.configDir === work);
    expect(sibling?.identity).toEqual({ email: 'work@example.com', plan: 'Pro' });
  });

  it('treats a garbage config as no identity rather than an error', () => {
    const dir = client('.claude-work');
    writeFileSync(path.join(dir, '.claude.json'), 'not json at all', 'utf8');
    const [client0] = listClients(env, [], () => true, home);
    expect(client0!.identity).toBeUndefined();
  });

  it('counts a garbage credential as signed in, because the file is never parsed', () => {
    const dir = client('.claude-work');
    writeFileSync(path.join(dir, '.credentials.json'), '\u0000\u0001 torn', 'utf8');
    const [client0] = listClients(env, [], () => true, home);
    expect(client0!.signedIn).toBe(true);
  });

  it('reports an identity without a credential — a client someone signed out of', () => {
    const dir = client('.claude-work');
    writeJson(path.join(dir, '.claude.json'), {
      oauthAccount: { emailAddress: 'gone@example.com' },
    });
    const [client0] = listClients(env, [], () => true, home);
    expect(client0!.signedIn).toBe(false);
    expect(client0!.identity?.email).toBe('gone@example.com');
  });

  it('counts conversations and takes the newest transcript as last use', () => {
    const dir = client('.claude-work');
    transcript(dir, '00000000-0000-4000-8000-0000000000a1', 1_700_000_000_000);
    transcript(dir, '00000000-0000-4000-8000-0000000000a2', 1_700_000_500_000);
    const [client0] = listClients(env, [], () => true, home);
    expect(client0!.conversations).toBe(2);
    expect(client0!.lastUsedAt).toBe(1_700_000_500_000);
  });

  it('counts live processes from the sessions registry, only while their pid answers', () => {
    const dir = client('.claude-work');
    const sessions = path.join(dir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeJson(path.join(sessions, 'one.json'), { pid: 4242, sessionId: 'abc' });

    expect(listClients(env, [], () => true, home)[0]!.live).toBe(1);
    expect(listClients(env, [], () => false, home)[0]!.live).toBe(0);
  });
});
