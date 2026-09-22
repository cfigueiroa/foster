import { describe, expect, it, vi } from 'vitest';
import { restartAround } from '../src/ops/restart.js';
import { layoutFor } from '../src/domain/paths.js';
import type { RestartPlan } from '../src/ops/sweep.js';
import type { QuitResult } from '../src/engine/desktop.js';

const store = layoutFor('C:\\nowhere');

function possiblePlan(running: boolean): RestartPlan {
  return { possible: true, running, command: 'foster app restart' };
}

describe('restartAround — finding #3: the app is always started back up', () => {
  it('runs duringGap and starts the app when everything succeeds', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async () => true);
    const duringGap = vi.fn(async () => {});

    const result = await restartAround(store, true, 'foster layout --yes --restart', duringGap, {
      plan: () => possiblePlan(true),
      quit,
      start,
    });

    expect(duringGap).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(result).toEqual({
      requested: true,
      done: true,
      command: 'foster layout --yes --restart',
    });
  });

  it('still starts the app when duringGap throws, and reports the failure afterward', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async () => true);
    const duringGap = vi.fn(async () => {
      throw new Error('the write failed midway');
    });

    const result = await restartAround(store, true, 'foster layout --yes --restart', duringGap, {
      plan: () => possiblePlan(true),
      quit,
      start,
    });

    // The old bug: a thrown duringGap propagated straight out of
    // restartAround, and `start` was never reached — the app was left closed
    // with the user given no instruction for putting it back up themselves.
    expect(start).toHaveBeenCalledOnce();
    expect(result.done).toBe(false);
    expect(result.reason).toContain('the write failed midway');
    expect(result.reason).toContain('restarted anyway');
  });

  it('says the app could not be restarted either, when duringGap throws and start also fails', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async () => false);
    const duringGap = vi.fn(async () => {
      throw new Error('write failed');
    });

    const result = await restartAround(store, true, 'foster layout --yes --restart', duringGap, {
      plan: () => possiblePlan(true),
      quit,
      start,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(result.done).toBe(false);
    expect(result.reason).toContain('write failed');
    expect(result.reason).toContain('could not be started again either');
  });

  it('never calls duringGap or start when the plan says restarting is not possible', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async () => true);
    const duringGap = vi.fn(async () => {});

    const result = await restartAround(store, true, 'foster layout --yes --restart', duringGap, {
      plan: () => ({
        possible: false,
        running: true,
        reason: 'foster is running inside Claude Desktop',
        command: 'foster app restart',
      }),
      quit,
      start,
    });

    expect(duringGap).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
  });
});

describe('restartAround — code review follow-ups', () => {
  it('keeps the write failure when start then throws too', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async (): Promise<boolean> => {
      throw new Error('start blew up');
    });
    const duringGap = vi.fn(async () => {
      throw new Error('write failed');
    });

    const result = await restartAround(store, true, 'foster layout --yes --restart', duringGap, {
      plan: () => possiblePlan(true),
      quit,
      start,
    });

    // Before: the outer catch reported only "start blew up", and the user
    // never learned the write had failed.
    expect(result.done).toBe(false);
    expect(result.reason).toContain('write failed');
    expect(result.reason).toContain('start blew up');
  });

  it('with a write waiting, a tray-hidden app hands back the caller command and says nothing was written', async () => {
    const quit = vi.fn(
      async (): Promise<QuitResult> => ({ outcome: 'hides-to-tray' }) as QuitResult,
    );
    const start = vi.fn(async () => true);
    const duringGap = vi.fn(async () => {});

    const result = await restartAround(store, true, 'foster layout --yes --restart', duringGap, {
      plan: () => possiblePlan(true),
      quit,
      start,
    });

    // Before: it handed over `foster app restart --terminate`, which restarts
    // the app but never runs the write.
    expect(duringGap).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
    expect(result.command).toBe('foster layout --yes --restart');
    expect(result.reason).toContain('Nothing was written');
  });

  it('with nothing to write, a tray-hidden app still hands over app restart --terminate', async () => {
    const quit = vi.fn(
      async (): Promise<QuitResult> => ({ outcome: 'hides-to-tray' }) as QuitResult,
    );
    const result = await restartAround(store, true, 'foster app restart', undefined, {
      plan: () => possiblePlan(true),
      quit,
      start: vi.fn(async () => true),
    });
    expect(result.command).toBe('foster app restart --terminate');
  });
});
