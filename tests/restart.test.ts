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

    const result = await restartAround(
      store,
      true,
      'foster layout --yes --restart',
      duringGap,
      { plan: () => possiblePlan(true), quit, start },
    );

    expect(duringGap).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(result).toEqual({ requested: true, done: true, command: 'foster layout --yes --restart' });
  });

  it('still starts the app when duringGap throws, and reports the failure afterward', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async () => true);
    const duringGap = vi.fn(async () => {
      throw new Error('the write failed midway');
    });

    const result = await restartAround(
      store,
      true,
      'foster layout --yes --restart',
      duringGap,
      { plan: () => possiblePlan(true), quit, start },
    );

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

    const result = await restartAround(
      store,
      true,
      'foster layout --yes --restart',
      duringGap,
      { plan: () => possiblePlan(true), quit, start },
    );

    expect(start).toHaveBeenCalledOnce();
    expect(result.done).toBe(false);
    expect(result.reason).toContain('write failed');
    expect(result.reason).toContain('could not be started again either');
  });

  it('never calls duringGap or start when the plan says restarting is not possible', async () => {
    const quit = vi.fn(async (): Promise<QuitResult> => ({ outcome: 'quit' }));
    const start = vi.fn(async () => true);
    const duringGap = vi.fn(async () => {});

    const result = await restartAround(
      store,
      true,
      'foster layout --yes --restart',
      duringGap,
      {
        plan: () => ({
          possible: false,
          running: true,
          reason: 'foster is running inside Claude Desktop',
          command: 'foster app restart',
        }),
        quit,
        start,
      },
    );

    expect(duringGap).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.done).toBe(false);
  });
});
