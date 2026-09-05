import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatLaunchCommand,
  openTerminalTab,
  planLaunch,
  type LaunchOptions,
  type LaunchPlan,
} from '../src/engine/launch.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-launch-'));
}

/** A fresh, empty `home` — `looksLikeClient` treats an empty directory as a client. */
function home(): string {
  return scratch();
}

function baseOpts(overrides: Partial<LaunchOptions> = {}): LaunchOptions {
  return { clients: [], env: {} as NodeJS.ProcessEnv, ...overrides };
}

function signIn(dir: string, email?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), '{}');
  if (email) {
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
    );
  }
}

describe('planLaunch: resolving <client> to a directory', () => {
  it('takes an existing path as-is', () => {
    const target = path.join(scratch(), 'somewhere-else');
    mkdirSync(target, { recursive: true });

    const plan = planLaunch(target, baseOpts({ home: home() }));

    expect(plan.blockers).toEqual([]);
    expect(plan.configDir).toBe(path.resolve(target));
  });

  it('reads the `~/.claude-<slug>` sibling convention', () => {
    const h = home();
    const work = path.join(h, '.claude-work');
    mkdirSync(work, { recursive: true });

    const plan = planLaunch('work', baseOpts({ home: h }));

    expect(plan.blockers).toEqual([]);
    expect(plan.configDir).toBe(work);
  });

  it('matches the basename of a registered root', () => {
    const h = home();
    const fleetRoot = path.join(scratch(), 'fleet-a');
    mkdirSync(fleetRoot, { recursive: true });

    const plan = planLaunch('fleet-a', baseOpts({ home: h, clients: [fleetRoot] }));

    expect(plan.blockers).toEqual([]);
    expect(plan.configDir).toBe(fleetRoot);
  });

  it('opens `default` on ~/.claude', () => {
    const h = home();
    const def = path.join(h, '.claude');
    mkdirSync(def, { recursive: true });

    const plan = planLaunch('default', baseOpts({ home: h }));

    expect(plan.blockers).toEqual([]);
    expect(plan.configDir).toBe(def);
  });

  it('refuses two registered roots sharing a name, listing both', () => {
    const h = home();
    const a = path.join(scratch(), 'dup');
    const b = path.join(scratch(), 'other', 'dup');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const plan = planLaunch('dup', baseOpts({ home: h, clients: [a, b] }));

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain('more than one');
    expect(plan.blockers[0]).toContain(a);
    expect(plan.blockers[0]).toContain(b);
  });

  it('lists the known clients when nothing matches, instead of a bare "not found"', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude'), { recursive: true });
    mkdirSync(path.join(h, '.claude-work'), { recursive: true });

    const plan = planLaunch('nope', baseOpts({ home: h }));

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain('No client named "nope"');
    expect(plan.blockers[0]).toContain('default');
    expect(plan.blockers[0]).toContain('work');
  });

  it('says so when a registered name no longer has a directory behind it', () => {
    const h = home();
    const gone = path.join(scratch(), 'ghost');

    const plan = planLaunch('ghost', baseOpts({ home: h, clients: [gone] }));

    expect(plan.blockers[0]).toContain(gone);
    expect(plan.blockers[0]).toContain('does not exist');
  });

  it("refuses a directory that is not a client — someone else's folder of notes", () => {
    const h = home();
    const notes = path.join(h, '.claude-notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(path.join(notes, 'random.md'), 'not a client');

    const plan = planLaunch('notes', baseOpts({ home: h }));

    expect(plan.blockers[0]).toContain('does not look like a Claude Code client');
  });
});

describe('planLaunch: junctions', () => {
  it('refuses to open on a junction without --follow-link', () => {
    const h = home();
    const target = path.join(scratch(), 'target-account');
    mkdirSync(target, { recursive: true });
    const link = path.join(h, '.claude-linked');
    symlinkSync(target, link, 'junction');

    const plan = planLaunch('linked', baseOpts({ home: h }));

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain('junction');
    expect(plan.blockers[0]).toContain('--follow-link');
    expect(plan.configDir).toBe(link);
  });

  it('opens on the target instead, with --follow-link', () => {
    const h = home();
    const target = path.join(scratch(), 'target-account');
    mkdirSync(target, { recursive: true });
    const link = path.join(h, '.claude-linked');
    symlinkSync(target, link, 'junction');

    const plan = planLaunch('linked', baseOpts({ home: h, followLink: true }));

    expect(plan.blockers).toEqual([]);
    expect(plan.configDir).toBe(path.resolve(target));
  });

  it("warns, but does not refuse, when the resolved client is another link's live target", () => {
    // P11: unmeasured whether this competes with a fleet's own rotation, so it
    // is a warning — every other directory this process already enumerates
    // (siblings and registered roots) is cheap to check for a junction
    // pointing here.
    const h = home();
    const target = path.join(h, '.claude-work');
    mkdirSync(target, { recursive: true });
    const fleetLink = path.join(h, '.claude-frota');
    symlinkSync(target, fleetLink, 'junction');

    const plan = planLaunch('work', baseOpts({ home: h }));

    expect(plan.blockers).toEqual([]);
    expect(plan.warnings.some((w) => w.includes(fleetLink) && w.includes('quota'))).toBe(true);
  });
});

describe('planLaunch: warnings that never become refusals', () => {
  it('warns when the client is signed out, but still opens', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude-work'), { recursive: true });

    const plan = planLaunch('work', baseOpts({ home: h }));

    expect(plan.blockers).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('not signed in'))).toBe(true);
  });

  it('does not warn about being signed out once a credential is there', () => {
    const h = home();
    signIn(path.join(h, '.claude-work'), 'you@example.com');

    const plan = planLaunch('work', baseOpts({ home: h }));

    expect(plan.warnings.some((w) => w.includes('not signed in'))).toBe(false);
  });

  it('names the live writers that could clobber the credential', () => {
    const h = home();
    const dir = path.join(h, '.claude-work');
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    writeFileSync(
      path.join(dir, 'sessions', 'a.json'),
      JSON.stringify({ pid: 4242, sessionId: 'conv-1', cwd: 'C:\\work' }),
    );

    const plan = planLaunch('work', baseOpts({ home: h, alive: (pid) => pid === 4242 }));

    expect(plan.blockers).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('4242') && w.includes('C:\\work'))).toBe(true);
  });

  it('always names the title as an unverified, cached claim', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude-work'), { recursive: true });

    const plan = planLaunch('work', baseOpts({ home: h }));

    expect(plan.warnings.some((w) => w.includes('cached claim'))).toBe(true);
  });
});

describe('planLaunch: the command line', () => {
  it('quotes the directory, cleans CLAUDE*, and carries the args through', () => {
    const h = home();
    const dir = path.join(h, '.claude-work');
    signIn(dir, 'you@example.com');

    const plan = planLaunch('work', baseOpts({ home: h, claudeArgs: ['--resume', 'abc-123'] }));

    expect(plan.command).toBe('wt');
    expect(plan.title).toBe('work·you@example.com');
    expect(plan.args).toEqual(
      expect.arrayContaining(['-w', '0', 'new-tab', '--title', 'work·you@example.com', '-d']),
    );
    const commandIndex = plan.args!.indexOf('-Command');
    expect(commandIndex).toBeGreaterThan(-1);
    const psCommand = plan.args![commandIndex + 1]!;
    expect(psCommand).toContain('Get-ChildItem Env:CLAUDE* | Remove-Item');
    expect(psCommand).toContain(`$env:CLAUDE_CONFIG_DIR='${dir}'`);
    expect(psCommand).toContain('claude --resume abc-123');
  });

  it('doubles an embedded single quote in the directory', () => {
    const h = home();
    const dir = path.join(h, ".claude-o'brien");
    mkdirSync(dir, { recursive: true });

    const plan = planLaunch("o'brien", baseOpts({ home: h }));

    const psCommand = plan.args![plan.args!.indexOf('-Command') + 1]!;
    expect(psCommand).toContain(`CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "''")}'`);
  });

  it('refuses a directory argument holding a quote or a control character', () => {
    const plan = planLaunch('evil"name', baseOpts({ home: home() }));
    expect(plan.blockers[0]).toContain('quote or control character');

    const withNewline = planLaunch('evil\nname', baseOpts({ home: home() }));
    expect(withNewline.blockers[0]).toContain('quote or control character');
  });

  it('gives a hyphenated title, so `wt` does not split it on a space', () => {
    const h = home();
    signIn(path.join(h, '.claude-work'), 'a b@example.com');

    const plan = planLaunch('work', baseOpts({ home: h }));

    expect(plan.title).not.toMatch(/\s/);
  });
});

describe('formatLaunchCommand', () => {
  it('renders the plan as one printable line', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude-work'), { recursive: true });
    const plan = planLaunch('work', baseOpts({ home: h }));

    const line = formatLaunchCommand(plan);

    expect(line.startsWith('wt ')).toBe(true);
    expect(line).toContain('new-tab');
    expect(line).toContain('CLAUDE_CONFIG_DIR');
  });

  it('has nothing to show for a blocked plan', () => {
    const blocked: LaunchPlan = { blockers: ['nope'], warnings: [] };
    expect(formatLaunchCommand(blocked)).toBe('(nothing to run)');
  });
});

describe('openTerminalTab', () => {
  it('opens by calling the injected opener', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude-work'), { recursive: true });
    const plan = planLaunch('work', baseOpts({ home: h }));

    let called: LaunchPlan | undefined;
    const outcome = openTerminalTab(plan, (p) => {
      called = p;
    });

    expect(outcome).toEqual({ outcome: 'opened' });
    expect(called).toBe(plan);
  });

  it('turns an opener failure into a failed outcome carrying the --print line, never a throw', () => {
    const h = home();
    mkdirSync(path.join(h, '.claude-work'), { recursive: true });
    const plan = planLaunch('work', baseOpts({ home: h }));

    const outcome = openTerminalTab(plan, () => {
      throw new Error('ENOENT: wt is not on PATH');
    });

    expect(outcome.outcome).toBe('failed');
    expect(outcome.outcome === 'failed' && outcome.line.startsWith('wt ')).toBe(true);
  });

  it('refuses to open a blocked plan rather than calling the opener at all', () => {
    const blocked: LaunchPlan = { blockers: ['nope'], warnings: [] };
    let called = false;

    const outcome = openTerminalTab(blocked, () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(outcome).toEqual({ outcome: 'failed', line: '(nothing to run)' });
  });
});
