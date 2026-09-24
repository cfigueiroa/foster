import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resumeConversation` never spawns the real `claude` CLI in these tests —
 * `node:child_process` is mocked below, and every test that exercises the
 * default (unmocked-runner) path drives that mock, never a real process.
 * `--yes`-gated behaviour and the live-writer refusal are covered from
 * `tests/agent-tools.test.ts`; this file is about what changed underneath:
 * the spawn is async, its env is scrubbed, and a timeout kills the tree
 * rather than orphaning a second writer.
 */

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const { resumeConversation } = await import('../src/engine/resume.js');

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
}

const ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  spawnMock.mockReset();
  execFileSyncMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('resumeConversation — validation and the injected runner', () => {
  it('rejects an id that does not look like a conversation, before ever spawning anything', async () => {
    await expect(resumeConversation('not; an id', 'hi')).rejects.toThrow(/does not look like/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt', async () => {
    await expect(resumeConversation(ID, '   ')).rejects.toThrow(/must not be empty/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses when the live-session registry names a writer, without calling the runner', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'foster-resume-live-'));
    mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'sessions', 'entry.json'),
      JSON.stringify({ pid: process.pid, sessionId: ID, cwd: '/workspace/project' }),
      'utf8',
    );
    const runner = vi.fn();

    const result = await resumeConversation(ID, 'hi', {
      env: { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
      runner,
    });

    expect(result).toEqual({ refused: expect.stringContaining(`pid ${process.pid}`) });
    expect(runner).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts a runner that answers asynchronously and caps very long output', async () => {
    const long = 'x'.repeat(200_000);
    const result = await resumeConversation(ID, 'hi', {
      env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
      runner: async () => long,
    });

    expect('refused' in result).toBe(false);
    if ('refused' in result) return;
    expect(result.output.length).toBeLessThan(long.length);
    expect(result.output.endsWith('[output truncated]')).toBe(true);
  });
});

describe('resumeConversation — the default runner (spawn mocked, never the real CLI)', () => {
  it('spawns `claude -p --resume <id>`, writes the prompt to stdin, and resolves with stdout', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = resumeConversation(ID, 'carry on', {
      env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', '--resume', ID]);
    expect(child.stdin.end).toHaveBeenCalledWith('carry on');

    child.stdout.emit('data', Buffer.from('the answer'));
    child.emit('close', 0, null);

    const result = await promise;
    expect(result).toEqual({ cliSessionId: ID, output: 'the answer' });
  });

  it('spawns with a CLAUDE_* variable stripped from the environment (scrubbedEnv)', async () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-desktop');
    vi.stubEnv('FOSTER_RESUME_TEST_MARKER', 'kept');
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = resumeConversation(ID, 'hi', {
      env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
    });
    await Promise.resolve();
    await Promise.resolve();

    const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(opts.env.FOSTER_RESUME_TEST_MARKER).toBe('kept');

    child.emit('close', 0, null);
    await promise;
  });

  it('restores CLAUDE_CONFIG_DIR after the scrub, sourced from the caller-supplied env', async () => {
    // process.env itself carries no CLAUDE_CONFIG_DIR here, so if the spawn env
    // still gets one, it can only have come from `options.env` — the same env
    // `resumeConversation` used for the live-writer check, matching a tab
    // opened via `foster client open <client>` (AGENTS.md), not the ambient
    // environment of whatever process happens to be running foster.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    delete process.env.CLAUDE_CONFIG_DIR;
    const targetConfigDir = mkdtempSync(path.join(tmpdir(), 'foster-resume-target-'));
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = resumeConversation(ID, 'hi', {
      env: { CLAUDE_CONFIG_DIR: targetConfigDir } as NodeJS.ProcessEnv,
    });
    await Promise.resolve();
    await Promise.resolve();

    const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(targetConfigDir);

    child.emit('close', 0, null);
    await promise;
  });

  it('leaves CLAUDE_CONFIG_DIR out of the spawn env when neither the caller env nor process.env has one', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = resumeConversation(ID, 'hi', {
      env: { FOO: 'bar' } as NodeJS.ProcessEnv,
    });
    await Promise.resolve();
    await Promise.resolve();

    const opts = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBeUndefined();

    child.emit('close', 0, null);
    await promise;
  });

  it('rejects on a non-zero exit, surfacing stderr', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = resumeConversation(ID, 'hi', {
      env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
    });
    await Promise.resolve();
    await Promise.resolve();

    child.stderr.emit('data', Buffer.from('not signed in'));
    child.emit('close', 1, null);

    await expect(promise).rejects.toThrow(/not signed in/);
  });

  it.skipIf(process.platform !== 'win32')(
    'on timeout, kills the whole tree via taskkill on the spawned pid, and never resolves',
    async () => {
      vi.useFakeTimers();
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);

      const promise = resumeConversation(ID, 'hi', {
        env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
        timeoutMs: 1_000,
      });
      // Let the synchronous setup inside runClaudeResume happen before advancing time.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        expect.objectContaining({ windowsHide: true }),
      );

      // Even a late, post-kill exit from the child must not resolve the run —
      // the point of the tree kill was that nothing should still be writing.
      child.emit('close', null, 'SIGTERM');
      await expect(promise).rejects.toThrow(/did not answer within/);
    },
  );

  it('on a non-Windows platform, kills the spawned pid directly with SIGKILL instead of shelling out to taskkill', async () => {
    // On win32 `spawn` above resolves the `claude` `.cmd` shim through a shell,
    // so the spawned pid is the shell's and `/T` is what reaches the real
    // `claude` process. On every other platform `shell: false` is used
    // instead, so the spawned pid already names `claude` directly — killTree
    // must not depend on a Windows-only binary to reach it.
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);

      const promise = resumeConversation(ID, 'hi', {
        env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
        timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(killSpy).toHaveBeenCalledWith(child.pid, 'SIGKILL');
      expect(execFileSyncMock).not.toHaveBeenCalled();

      child.emit('close', null, 'SIGTERM');
      await expect(promise).rejects.toThrow(/did not answer within/);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      killSpy.mockRestore();
    }
  });

  it('taskkill itself failing (already exited, or missing) does not throw out of the timeout path', async () => {
    vi.useFakeTimers();
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = resumeConversation(ID, 'hi', {
      env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'foster-resume-idle-')) },
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', null, 'SIGTERM');

    await expect(promise).rejects.toThrow(/did not answer within/);
  });
});
