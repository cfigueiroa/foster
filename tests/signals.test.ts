import { describe, expect, it } from 'vitest';
import { armAbortOnSignals } from '../src/util/signals.js';

describe('armAbortOnSignals', () => {
  it('aborts the controller on the first signal it sees', () => {
    const controller = new AbortController();
    const disarm = armAbortOnSignals(controller, ['SIGINT']);
    try {
      expect(controller.signal.aborted).toBe(false);
      process.emit('SIGINT');
      expect(controller.signal.aborted).toBe(true);
    } finally {
      disarm();
    }
  });

  it('stays armed for a second signal — the bug `.once` had', () => {
    // `process.once('SIGINT', ...)` auto-removes itself after firing, so a
    // second Ctrl+C had no listener left and fell through to Node's default
    // SIGINT handling, which kills the process immediately. `.on` must still
    // be listening after the first signal.
    const controller = new AbortController();
    const disarm = armAbortOnSignals(controller, ['SIGINT']);
    try {
      process.emit('SIGINT');
      expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
      // A second signal must not throw, and the controller stays aborted —
      // it does not un-abort or error on a repeat call.
      expect(() => process.emit('SIGINT')).not.toThrow();
      expect(controller.signal.aborted).toBe(true);
    } finally {
      disarm();
    }
  });

  it('calls abort exactly once even when multiple armed signals all fire', () => {
    const controller = new AbortController();
    let aborts = 0;
    controller.signal.addEventListener('abort', () => {
      aborts += 1;
    });
    const disarm = armAbortOnSignals(controller, ['SIGINT', 'SIGHUP', 'SIGBREAK']);
    try {
      process.emit('SIGINT');
      process.emit('SIGHUP');
      process.emit('SIGBREAK');
      process.emit('SIGINT');
      expect(aborts).toBe(1);
    } finally {
      disarm();
    }
  });

  it('catches SIGHUP and SIGBREAK, the signals closing the window sends', () => {
    // Windows delivers SIGHUP when the console window itself is closed, and
    // SIGBREAK for Ctrl+Break — neither was ever listened for before this,
    // so either one terminated the process with nothing restored.
    for (const sig of ['SIGHUP', 'SIGBREAK'] as const) {
      const controller = new AbortController();
      const disarm = armAbortOnSignals(controller, [sig]);
      try {
        process.emit(sig);
        expect(controller.signal.aborted).toBe(true);
      } finally {
        disarm();
      }
    }
  });

  it('removes every listener it added, and none it did not', () => {
    const before = process.listenerCount('SIGINT');
    const controller = new AbortController();
    const disarm = armAbortOnSignals(controller, ['SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    disarm();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('defaults to SIGINT, SIGHUP and SIGBREAK when none are named', () => {
    const controller = new AbortController();
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGHUP: process.listenerCount('SIGHUP'),
      SIGBREAK: process.listenerCount('SIGBREAK'),
    };
    const disarm = armAbortOnSignals(controller);
    try {
      expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1);
      expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP + 1);
      expect(process.listenerCount('SIGBREAK')).toBe(before.SIGBREAK + 1);
    } finally {
      disarm();
    }
  });
});
