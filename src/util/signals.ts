/**
 * Arms `signals` so the first one to fire aborts `controller`, and disarms
 * them again once the caller is done.
 *
 * Every listener shares one guard, so a *second* signal — of the same kind
 * or a different one in `signals` — still reaches a listener instead of
 * falling through to Node's own default action for that signal, which
 * terminates the process immediately. That fall-through is exactly what
 * `process.once('SIGINT', ...)` used to risk: Node auto-removes a `once`
 * listener after it fires, so a second Ctrl+C from someone impatient had no
 * listener left to catch it, and the process died before whatever the abort
 * was meant to let finish — a registry restore, a cleanup step — ever ran.
 * Every signal here is armed with `.on`, never `.once`, and stays armed
 * until `disarm()` is called.
 */
export function armAbortOnSignals(
  controller: AbortController,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGBREAK'],
  proc: NodeJS.Process = process,
): () => void {
  let signaled = false;
  const onSignal = () => {
    if (signaled) return;
    signaled = true;
    controller.abort();
  };
  for (const sig of signals) proc.on(sig, onSignal);
  return () => {
    for (const sig of signals) proc.removeListener(sig, onSignal);
  };
}
