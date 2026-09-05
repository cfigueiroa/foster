import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyProfile,
  planForget,
  planProfile,
  type ProfileEvent,
} from '../src/engine/installations.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-installations-'));
}

/** A synthetic environment that never resolves to a real installation or config directory. */
function fakeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LOCALAPPDATA: undefined,
    APPDATA: undefined,
    CLAUDE_USER_DATA_DIR: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    ...overrides,
  };
}

function registered(name: string, root: string): ProfileEvent {
  return {
    v: 1,
    ts: 1_700_000_000_000,
    toolVersion: '0.0.0-test',
    kind: 'profile_registered',
    name,
    root,
  };
}

function forgotten(name: string): ProfileEvent {
  return {
    v: 1,
    ts: 1_700_000_100_000,
    toolVersion: '0.0.0-test',
    kind: 'profile_forgotten',
    name,
  };
}

/** A directory carrying the marks `hasStoreMarks` looks for — a real, launched profile. */
function launchedProfile(): string {
  const dir = scratch();
  writeFileSync(path.join(dir, 'Local State'), '{}');
  return dir;
}

describe('planProfile', () => {
  it('refuses an invalid name', () => {
    const target = path.join(scratch(), 'new');
    const plan = planProfile(target, 'Not Valid!', { events: [], env: fakeEnv() });
    expect(plan.blockers[0]).toContain('valid profile name');
  });

  it('refuses a name already registered to a different root', () => {
    const other = scratch();
    const target = path.join(scratch(), 'new');
    const plan = planProfile(target, 'work', {
      events: [registered('work', other)],
      env: fakeEnv(),
    });
    expect(plan.blockers[0]).toContain('already registered');
  });

  it('allows re-registering the same name at the root it already points to', () => {
    const target = launchedProfile();
    const plan = planProfile(target, 'work', {
      events: [registered('work', target)],
      env: fakeEnv(),
      adopt: true,
    });
    expect(plan.blockers).toEqual([]);
  });

  it('a forgotten name is free again', () => {
    const other = scratch();
    const target = path.join(scratch(), 'new');
    const plan = planProfile(target, 'work', {
      events: [registered('work', other), forgotten('work')],
      env: fakeEnv(),
    });
    expect(plan.blockers).toEqual([]);
  });

  it('refuses a UNC path', () => {
    const plan = planProfile('\\\\server\\share\\profile', 'work', {
      events: [],
      env: fakeEnv(),
    });
    expect(plan.blockers[0]).toContain('network path');
  });

  it('refuses a path inside an installed app root', () => {
    const base = scratch();
    const installed = path.join(base, 'Claude');
    mkdirSync(path.join(installed, 'claude-code-sessions'), { recursive: true });
    const target = path.join(installed, 'sub-profile');

    const plan = planProfile(target, 'work', {
      events: [],
      env: fakeEnv({ APPDATA: base }),
    });
    expect(plan.blockers[0]).toContain('installation root');
  });

  it('refuses a path under \\Packages\\Claude', () => {
    const target = path.join(
      scratch(),
      'Packages',
      'ClaudeXYZ123',
      'LocalCache',
      'Roaming',
      'Claude',
    );
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv() });
    expect(plan.blockers[0]).toContain('installation root');
  });

  it('refuses a path that is a CLI config directory', () => {
    const configDir = scratch();
    const plan = planProfile(configDir, 'work', {
      events: [],
      env: fakeEnv({ CLAUDE_CONFIG_DIR: configDir }),
    });
    expect(plan.blockers[0]).toContain('config directory');
  });

  it('refuses an existing non-empty directory with none of the marks of a profile', () => {
    const target = scratch();
    writeFileSync(path.join(target, 'notes.md'), 'somebody else was here');

    const plan = planProfile(target, 'work', { events: [], env: fakeEnv() });
    expect(plan.blockers[0]).toContain("somebody else's folder");
  });

  it('allows an empty existing directory for `new`', () => {
    const target = scratch();
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv() });
    expect(plan.blockers).toEqual([]);
    expect(plan.exists).toBe(true);
  });

  it('register refuses a directory that does not exist', () => {
    const target = path.join(scratch(), 'nope');
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv(), adopt: true });
    expect(plan.blockers[0]).toContain('does not exist');
  });

  it('register refuses a directory with none of the marks of a profile', () => {
    const target = scratch();
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv(), adopt: true });
    expect(plan.blockers[0]).toContain('nothing here to register');
  });

  it('register adopts a directory with Local State', () => {
    const target = launchedProfile();
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv(), adopt: true });
    expect(plan.blockers).toEqual([]);
    expect(plan.exists).toBe(true);
    expect(plan.adopt).toBe(true);
  });
});

describe('applyProfile', () => {
  it('creates the directory and nothing else', () => {
    const target = path.join(scratch(), 'new');
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv() });
    const outcome = applyProfile(plan);

    expect(outcome.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    // Foster writes nothing inside it — the app populates a profile on its own
    // first launch, and a file foster put there would be wrong the moment the
    // app wrote its own.
    expect(readdirSync(target)).toEqual([]);
  });

  it('registering an existing profile writes nothing to disk', () => {
    const target = launchedProfile();
    const before = readdirSync(target).sort();
    const plan = planProfile(target, 'work', { events: [], env: fakeEnv(), adopt: true });
    const outcome = applyProfile(plan);

    expect(outcome.ok).toBe(true);
    expect(readdirSync(target).sort()).toEqual(before);
  });

  it('writes nothing for a blocked plan', () => {
    const target = path.join(scratch(), 'new');
    const plan = planProfile(target, 'Not Valid!', { events: [], env: fakeEnv() });
    const outcome = applyProfile(plan);

    expect(outcome.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('planning writes nothing — a dry run is genuinely read-only', () => {
    const target = path.join(scratch(), 'new');
    planProfile(target, 'work', { events: [], env: fakeEnv() });
    expect(existsSync(target)).toBe(false);
  });
});

describe('planForget', () => {
  it('refuses a name that is not registered', () => {
    const plan = planForget('ghost', []);
    expect(plan.blockers[0]).toContain('not a registered profile');
  });

  it('finds the root a registered name points to', () => {
    const root = scratch();
    const plan = planForget('work', [registered('work', root)]);
    expect(plan.blockers).toEqual([]);
    expect(plan.root).toBe(path.resolve(root));
  });

  it('a name already forgotten refuses again', () => {
    const root = scratch();
    const plan = planForget('work', [registered('work', root), forgotten('work')]);
    expect(plan.blockers[0]).toContain('not a registered profile');
  });
});
