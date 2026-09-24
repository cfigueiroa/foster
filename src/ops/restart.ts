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
  /**
   * Whether the app was actually closed at any point during this call — true
   * from the moment `quit` lands (or the app was never running) onward, even
   * if `duringGap` then throws or `start` then fails. A caller that wants to
   * know whether it was safe to have written the gap-only files reads this,
   * not `done` (which also requires the app to be back up) and not a proxy
   * like "did my own write list end up non-empty" — that proxy is wrong when
   * the very first write inside the gap is the one that threw (issue: a
   * `foster app pref --restart` whose first write failed reported
   * `closed: false` although the app had, in fact, already been closed).
   */
  closed: boolean;
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
  if (!requested) return { requested: false, done: false, closed: false, command };

  const plan = planFn(store);
  if (!plan.possible) {
    return {
      requested: true,
      done: false,
      closed: false,
      reason: `${plan.reason}\nRun it from a terminal outside the app:`,
      command,
    };
  }

  // Set the instant the app is actually down — before `duringGap` or `start`
  // ever run, and read from both the `gapError` branch and the outer `catch`,
  // so neither has to infer "was it closed" from whether a write happened to
  // land.
  let closed = false;
  try {
    if (plan.running) {
      const quitResult = await quit(store);
      if (quitResult.outcome === 'needs-terminate' || quitResult.outcome === 'hides-to-tray') {
        // With nothing to write, restarting is the whole job and `app restart
        // --terminate` finishes it. With a write waiting for the gap, it does
        // not: that command never runs `duringGap`, so handing it over would
        // read as finishing a write that never happened. Say so, and hand back
        // the caller's own command — run once the app is closed, it finds
        // nothing to quit and writes straight away.
        if (duringGap) {
          return {
            requested: true,
            done: false,
            closed: false,
            reason:
              `${trayNote('Close it with "foster app quit --terminate"')}\n` +
              'Nothing was written. Once it is closed, run:',
            command,
          };
        }
        return {
          requested: true,
          done: false,
          closed: false,
          reason: trayNote('Finish it with'),
          command: 'foster app restart --terminate',
        };
      }
      if (quitResult.outcome !== 'quit' && quitResult.outcome !== 'not-running') {
        return {
          requested: true,
          done: false,
          closed: false,
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
    closed = true;
    let gapError: unknown;
    if (duringGap) {
      try {
        await duringGap();
      } catch (error) {
        gapError = error;
      }
    }

    if (gapError !== undefined) {
      const reason = gapError instanceof Error ? gapError.message : String(gapError);
      // Its own try: a start that throws must not replace the write's failure
      // in what the user reads — both happened, and the write's is the one
      // that says what is missing.
      let started = false;
      let startError: string | undefined;
      try {
        started = await start(store);
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      return {
        requested: true,
        done: false,
        closed: true,
        reason: started
          ? `${reason}\n(Claude Desktop was restarted anyway, with whatever landed before the failure.)`
          : `${reason}\n(Claude Desktop could not be started again either${startError ? `: ${startError}` : ''}.)`,
        command,
      };
    }

    const started = await start(store);

    return started
      ? { requested: true, done: true, closed: true, command }
      : {
          requested: true,
          done: false,
          closed: true,
          reason: 'Started it; it has not taken the store yet.',
          command,
        };
  } catch (error) {
    // A failure in quit/start itself, not in duringGap. `closed` was set the
    // instant the app actually went down, so this still reports it correctly
    // even when what threw was `start`, well after the quit succeeded.
    return {
      requested: true,
      done: false,
      closed,
      reason: error instanceof Error ? error.message : String(error),
      command,
    };
  }
}
