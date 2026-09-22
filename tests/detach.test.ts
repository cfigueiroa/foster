import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DETACH_DELAY_DEFAULT,
  detachedRunStatus,
  detachNeedsRestart,
  detachNeedsYes,
  launchDetached,
  launchWithFallback,
  liveWritersRefusal,
  listDetachedRuns,
  otherLiveWriters,
  parseDetachDelay,
  planDetached,
  sweepDetachArgv,
  tailLines,
  VBS_VARIABLE_NAMES,
  vbsBuiltinCollision,
  type DetachedPlan,
} from '../src/engine/detach.js';
import type { CommandOutcome, CommandRunner } from '../src/util/processes.js';
import type { LiveCliSession } from '../src/store/liveSessions.js';

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-detach-'));
}

function baseOptions(
  env: NodeJS.ProcessEnv,
  extra: Partial<Parameters<typeof planDetached>[0]> = {},
) {
  return {
    argv: ['sweep', '--yes'],
    delaySeconds: 20,
    env,
    now: () => new Date('2026-09-22T15:30:00'),
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\tools\\foster\\foster.js',
    ...extra,
  };
}

describe('planDetached', () => {
  it('strips --detach, --detach-delay <n>, --detach-delay=<n> and --detach-even-with-live from argv', () => {
    const env = { FOSTER_HOME: tmpHome() };
    const plan = planDetached(
      baseOptions(env, {
        argv: [
          'layout',
          '--yes',
          '--restart',
          '--detach',
          '--detach-delay',
          '30',
          '--detach-even-with-live',
        ],
      }),
    );
    expect(plan.argv).toEqual(['layout', '--yes', '--restart']);

    const plan2 = planDetached(
      baseOptions(env, { argv: ['sweep', '--yes', '--detach-delay=45', '--detach'] }),
    );
    expect(plan2.argv).toEqual(['sweep', '--yes']);
  });

  it('quotes every path and argument in the launch line', () => {
    const env = { FOSTER_HOME: tmpHome() };
    const plan = planDetached(
      baseOptions(env, {
        argv: ['sweep', '--yes', '--prefix', 'a b'],
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        scriptPath: 'C:\\Program Files\\foster\\foster.js',
      }),
    );
    expect(plan.vbsText).toContain('""C:\\Program Files\\nodejs\\node.exe""');
    expect(plan.vbsText).toContain('""C:\\Program Files\\foster\\foster.js""');
    expect(plan.vbsText).toContain('""a b""');
  });

  it('refuses an argument that would break out of the cmd.exe line', () => {
    const env = { FOSTER_HOME: tmpHome() };
    for (const bad of ['a"b', 'a%b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a\nb']) {
      expect(() => planDetached(baseOptions(env, { argv: ['sweep', bad] }))).toThrow();
    }
  });

  it('names the vbs and log after a local timestamp and the leading verb', () => {
    const env = { FOSTER_HOME: tmpHome() };
    const plan = planDetached(baseOptions(env, { argv: ['app', 'restart'] }));
    expect(path.basename(plan.vbsPath)).toBe('2026-09-22T153000-app-restart.vbs');
    expect(path.basename(plan.logPath)).toBe('2026-09-22T153000-app-restart.log');
  });

  it('breaks a filename collision with a counter', () => {
    const home = tmpHome();
    const env = { FOSTER_HOME: home };
    const dir = path.join(home, 'detached');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2026-09-22T153000-app-restart.vbs'), '');

    const plan = planDetached(baseOptions(env, { argv: ['app', 'restart'] }));
    expect(path.basename(plan.vbsPath)).toBe('2026-09-22T153000-2-app-restart.vbs');
  });

  it('writes under FOSTER_HOME, defaulting to ~/.foster', () => {
    const home = tmpHome();
    const plan = planDetached(baseOptions({ FOSTER_HOME: home }, { argv: ['app', 'restart'] }));
    expect(plan.vbsPath.startsWith(path.join(home, 'detached'))).toBe(true);
  });

  it('never assigns a value to a VBScript built-in name', () => {
    expect(vbsBuiltinCollision(VBS_VARIABLE_NAMES)).toBeUndefined();

    const env = { FOSTER_HOME: tmpHome() };
    const plan = planDetached(baseOptions(env, { argv: ['app', 'restart'] }));
    // Belt and braces: the generated text itself never assigns to a builtin,
    // "Dim <name>" or "<name> =" for any of VBScript's reserved words.
    for (const builtin of ['Log', 'Date', 'Time', 'Len']) {
      expect(plan.vbsText).not.toMatch(new RegExp(`Dim ${builtin}\\b`, 'i'));
      expect(plan.vbsText).not.toMatch(new RegExp(`^${builtin}\\s*=`, 'im'));
    }
  });

  it('starts with a comment block naming what it is, the foster version, when, and the log path', () => {
    const env = { FOSTER_HOME: tmpHome() };
    const plan = planDetached(baseOptions(env, { argv: ['app', 'restart'], version: '9.9.9' }));
    const firstLine = plan.vbsText.split('\n')[0] ?? '';
    expect(firstLine.startsWith("'")).toBe(true);
    expect(plan.vbsText).toContain('foster 9.9.9');
    expect(plan.vbsText).toContain(plan.logPath);
  });

  it('builds the WMI CommandLine from a hidden wscript.exe call on the vbs path', () => {
    const env = { FOSTER_HOME: tmpHome() };
    const plan = planDetached(baseOptions(env, { argv: ['app', 'restart'] }));
    expect(plan.commandLine).toBe(`wscript.exe "${plan.vbsPath}"`);
  });
});

describe('launchWithFallback', () => {
  function runner(outcomes: { powershell?: CommandOutcome; wmic?: CommandOutcome }): CommandRunner {
    return (exe) => {
      if (exe.toLowerCase().includes('powershell')) {
        return outcomes.powershell ?? { ok: false, reason: 'failed' };
      }
      return outcomes.wmic ?? { ok: false, reason: 'failed' };
    };
  }

  it('answers from PowerShell when it works', () => {
    const result = launchWithFallback(
      'wscript.exe "x.vbs"',
      { SystemRoot: 'C:\\W' },
      runner({ powershell: { ok: true, stdout: '4242' } }),
    );
    expect(result).toEqual({ pid: 4242, via: 'PowerShell' });
  });

  it('falls back to wmic when PowerShell fails', () => {
    const result = launchWithFallback(
      'wscript.exe "x.vbs"',
      { SystemRoot: 'C:\\W' },
      runner({
        powershell: { ok: false, reason: 'timeout' },
        wmic: { ok: true, stdout: 'ProcessId = 4321;\nReturnValue = 0;' },
      }),
    );
    expect(result).toEqual({ pid: 4321, via: 'wmic' });
  });

  it('throws naming both failures when neither works', () => {
    expect(() =>
      launchWithFallback(
        'wscript.exe "x.vbs"',
        { SystemRoot: 'C:\\W' },
        runner({
          powershell: { ok: false, reason: 'timeout' },
          wmic: { ok: false, reason: 'missing' },
        }),
      ),
    ).toThrow(/PowerShell.*timeout|timed out|missing/i);
  });
});

describe('launchDetached', () => {
  function fixturePlan(home: string): DetachedPlan {
    return planDetached(baseOptions({ FOSTER_HOME: home }, { argv: ['app', 'restart'] }));
  }

  it('writes the vbs and calls the injected launcher, never a real one', () => {
    const home = tmpHome();
    const plan = fixturePlan(home);
    let calledWith: string | undefined;
    const result = launchDetached(plan, {
      platform: 'win32',
      launch: (commandLine) => {
        calledWith = commandLine;
        return { pid: 999, via: 'PowerShell' };
      },
    });
    expect(result).toEqual({ pid: 999, via: 'PowerShell' });
    expect(calledWith).toBe(plan.commandLine);
  });

  it('refuses outright off Windows', () => {
    const home = tmpHome();
    const plan = fixturePlan(home);
    expect(() =>
      launchDetached(plan, { platform: 'linux', launch: () => ({ pid: 1, via: 'PowerShell' }) }),
    ).toThrow(/Windows-only/);
  });
});

describe('otherLiveWriters / liveWritersRefusal', () => {
  function session(overrides: Partial<LiveCliSession> = {}): LiveCliSession {
    return {
      registryFile: 'r.json',
      pid: 111,
      sessionId: '00000000-0000-4000-8000-00000000000a',
      identity: { pid: 111 },
      ...overrides,
    };
  }

  it('excludes the session foster is itself running in, by env', () => {
    const self = session({ pid: 111, sessionId: 'abc' });
    const other = session({ pid: 222, sessionId: 'def' });
    const others = otherLiveWriters([self, other], { CLAUDE_CODE_SESSION_ID: 'abc' });
    expect(others).toEqual([other]);
  });

  it('excludes a pid the caller identifies as hosting foster itself', () => {
    const self = session({ pid: 111 });
    const other = session({ pid: 222 });
    const others = otherLiveWriters([self, other], {}, (pid) => pid === 111);
    expect(others).toEqual([other]);
  });

  it('names pid and cwd (or session id) in the refusal', () => {
    const message = liveWritersRefusal([
      session({ pid: 5, cwd: 'C:\\work' }),
      session({ pid: 6, sessionId: 'no-cwd-session' }),
    ]);
    expect(message).toContain('5');
    expect(message).toContain('C:\\work');
    expect(message).toContain('6');
    expect(message).toContain('no-cwd-session');
    expect(message).toContain('--detach-even-with-live');
  });
});

describe('detachNeedsRestart / detachNeedsYes', () => {
  it('refuses --detach with no restart on the way', () => {
    expect(detachNeedsRestart({ detach: true, restart: false, isRestartItself: false })).toMatch(
      /restart/,
    );
  });

  it('allows --detach with --restart', () => {
    expect(
      detachNeedsRestart({ detach: true, restart: true, isRestartItself: false }),
    ).toBeUndefined();
  });

  it('allows --detach on app restart itself, with no --restart flag needed', () => {
    expect(
      detachNeedsRestart({ detach: true, restart: false, isRestartItself: true }),
    ).toBeUndefined();
  });

  it('says nothing when --detach was not passed', () => {
    expect(
      detachNeedsRestart({ detach: false, restart: false, isRestartItself: false }),
    ).toBeUndefined();
  });

  it('refuses --detach without --yes', () => {
    expect(detachNeedsYes({ detach: true, yes: false })).toMatch(/--yes/);
  });

  it('allows --detach with --yes', () => {
    expect(detachNeedsYes({ detach: true, yes: true })).toBeUndefined();
  });
});

describe('parseDetachDelay', () => {
  it('defaults when nothing was passed', () => {
    expect(parseDetachDelay(undefined)).toBe(DETACH_DELAY_DEFAULT);
  });

  it('accepts a whole number in range', () => {
    expect(parseDetachDelay('45')).toBe(45);
  });

  it('rejects a non-integer', () => {
    const result = parseDetachDelay('12.5');
    expect(typeof result).toBe('object');
  });

  it('rejects out of range values', () => {
    expect(typeof parseDetachDelay('4')).toBe('object');
    expect(typeof parseDetachDelay('301')).toBe('object');
  });
});

describe('sweepDetachArgv', () => {
  it('detaches foster app restart when no layout is pending', () => {
    expect(sweepDetachArgv(false)).toEqual(['app', 'restart']);
  });

  it('detaches foster layout --yes --restart when a layout is pending', () => {
    expect(sweepDetachArgv(true)).toEqual(['layout', '--yes', '--restart']);
  });
});

describe('detachedRunStatus', () => {
  it('is pending with no log at all', () => {
    expect(detachedRunStatus(undefined)).toBe('pending');
  });

  it('is pending with a log that has no start line yet', () => {
    expect(detachedRunStatus('')).toBe('pending');
  });

  it('is running once the start line has landed but not the end', () => {
    expect(detachedRunStatus('==== 2026-09-22T153000 start: app restart\n')).toBe('running');
  });

  it('is done once the end line has landed', () => {
    expect(detachedRunStatus('==== 2026-09-22T153000 start: app restart\nOK\n==== end\n')).toBe(
      'done',
    );
  });
});

describe('listDetachedRuns', () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  function writeRun(id: string, log?: string, mtimeOffsetMs = 0): void {
    const dir = path.join(home, 'detached');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.vbs`), "' vbs\n");
    if (log !== undefined) writeFileSync(path.join(dir, `${id}.log`), log);
    if (mtimeOffsetMs) {
      const at = new Date(Date.now() + mtimeOffsetMs);
      utimesSync(path.join(dir, `${id}.vbs`), at, at);
    }
  }

  it('reports pending/running/done per run, newest first', () => {
    writeRun('2026-09-22T150000-app-restart', undefined, 0);
    writeRun(
      '2026-09-22T150100-sweep',
      '==== 2026-09-22T150100 start: sweep --yes\n==== end\n',
      2_000,
    );
    writeRun(
      '2026-09-22T150200-layout',
      '==== 2026-09-22T150200 start: layout --yes --restart\n',
      4_000,
    );

    const runs = listDetachedRuns({ FOSTER_HOME: home });
    expect(runs.map((r) => r.id)).toEqual([
      '2026-09-22T150200-layout',
      '2026-09-22T150100-sweep',
      '2026-09-22T150000-app-restart',
    ]);
    expect(runs.map((r) => r.status)).toEqual(['running', 'done', 'pending']);
  });

  it('is empty when nothing has ever detached', () => {
    expect(listDetachedRuns({ FOSTER_HOME: home })).toEqual([]);
  });
});

describe('tailLines', () => {
  it('returns the last N lines', () => {
    expect(tailLines('a\nb\nc\nd\n', 2)).toEqual(['c', 'd']);
  });

  it('handles text with no trailing newline', () => {
    expect(tailLines('a\nb\nc', 2)).toEqual(['b', 'c']);
  });

  it('handles CRLF the same as LF', () => {
    expect(tailLines('a\r\nb\r\nc\r\n', 2)).toEqual(['b', 'c']);
  });
});
