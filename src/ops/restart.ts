import type { StoreLayout } from '../domain/types.js';
import { quitDesktop, startDesktop, trayNote } from '../engine/desktop.js';
import { restartPlan } from './sweep.js';

/**
 * Quit Claude Desktop, optionally do something while it is down, then start it
 * again — the restart machinery every write-with-app-closed command shares.
 *
 * `sweep --restart` has already written everything by the time it calls this,
 * so it passes no `duringGap`; `layout`/`view --restart` write files that are
 * only safe to touch while the app is closed, so they write from inside the
 * gap this opens, between the quit landing and the start going out. Either
 * way this is the one place that decides whether foster may restart the app
 * at all — see `RestartPlan`'s own reasoning about a session the app is
 * itself hosting.
 *
 * `quit`/`start`/`plan` are injectable so a test can drive the gap without a
 * real Claude Desktop, or a real process table, on the machine running it.
 */
export interface RestartAroundResult {
  requested: boolean;
  done: boolean;
  reason?: string;
  command: string;
}

export interface RestartAroundDeps {
  plan?: typeof restartPlan;
  quit?: typeof quitDesktop;
  start?: typeof startDesktop;
}

export async function restartAround(
  store: StoreLayout,
  requested: boolean,
  command: string,
  duringGap?: () => void | Promise<void>,
  deps: RestartAroundDeps = {},
): Promise<RestartAroundResult> {
  const planFn = deps.plan ?? restartPlan;
  const quit = deps.quit ?? quitDesktop;
  const start = deps.start ?? startDesktop;

  // Asked for only when it matters: working out whether foster is inside the app
  // means reading the process table, which is a second of PowerShell that a run
  // nobody asked to restart has no use for.
  if (!requested) return { requested: false, done: false, command };

  const plan = planFn(store);
  if (!plan.possible) {
    return {
      requested: true,
      done: false,
      reason: `${plan.reason}\nRun it from a terminal outside the app:`,
      command,
    };
  }

  try {
    if (plan.running) {
      const quitResult = await quit(store);
      if (quitResult.outcome === 'needs-terminate' || quitResult.outcome === 'hides-to-tray') {
        return {
          requested: true,
          done: false,
          reason: trayNote('Finish it with'),
          command: 'foster app restart --terminate',
        };
      }
      if (quitResult.outcome !== 'quit' && quitResult.outcome !== 'not-running') {
        return {
          requested: true,
          done: false,
          reason: 'Claude Desktop is still running. Quit it from the tray icon.',
          command,
        };
      }
    }

    // The app is closed at this point, which is the one moment `duringGap`'s
    // write is safe to make — but its failure must never mean the app is left
    // closed with nothing said about it. `start` runs whether or not
    // `duringGap` threw, the same way a `finally` would, except that the
    // error it caught still has to reach the caller afterward: swallowing it
    // here would report a clean restart over a write that never happened.
    let gapError: unknown;
    if (duringGap) {
      try {
        await duringGap();
      } catch (error) {
        gapError = error;
      }
    }

    const started = await start(store);

    if (gapError !== undefined) {
      const reason = gapError instanceof Error ? gapError.message : String(gapError);
      return {
        requested: true,
        done: false,
        reason: started
          ? `${reason}\n(Claude Desktop was restarted anyway, with whatever landed before the failure.)`
          : `${reason}\n(Claude Desktop could not be started again either.)`,
        command,
      };
    }

    return started
      ? { requested: true, done: true, command }
      : {
          requested: true,
          done: false,
          reason: 'Started it; it has not taken the store yet.',
          command,
        };
  } catch (error) {
    // A failure in quit/start itself, not in duringGap.
    return {
      requested: true,
      done: false,
      reason: error instanceof Error ? error.message : String(error),
      command,
    };
  }
}
