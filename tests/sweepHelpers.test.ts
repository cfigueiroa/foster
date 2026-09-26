import { describe, expect, it } from 'vitest';
import { pendingOf, sweepFailedCount, sweepMarked } from '../src/ops/sweep.js';
import type { RetitleOutcome } from '../src/engine/retitle.js';
import type { SweepConfirmation, SweepReport } from '../src/ops/sweep.js';

/**
 * `sweepMarked`, `pendingOf` and `sweepFailedCount` moved here from
 * `src/cli/index.ts` (`sweepMarked`, `deferredPinsGap`) so the TUI's own
 * sweep flow (`src/cli/flows.ts`) could share them instead of recomputing a
 * narrower version that left out `files.retitled` — see
 * `AGENTS.md`/`flows.ts` on the "Nothing to sweep" bug that produced.
 */

function retitled(status: RetitleOutcome['status']): RetitleOutcome {
  return { path: 'p', sessionId: 's', from: 'a', to: 'b', status, as: 'other-file' };
}

describe('sweepMarked', () => {
  it('is false when neither pass retitled anything', () => {
    expect(
      sweepMarked({
        branches: { retitled: [retitled('skipped')] } as never,
        files: { retitled: [] } as never,
      }),
    ).toBe(false);
  });

  it('is true from a branch-pass mark alone', () => {
    expect(
      sweepMarked({
        branches: { retitled: [retitled('retitled')] } as never,
        files: { retitled: [] } as never,
      }),
    ).toBe(true);
  });

  // The bug this exists to prevent: a run whose only pending work is a
  // second-file "(other file…)" mark used to read as nothing to do, because
  // the TUI's own count only looked at `branches.retitled`.
  it('is true from a files-pass (second-file) mark alone', () => {
    expect(
      sweepMarked({
        branches: { retitled: [] } as never,
        files: { retitled: [retitled('retitled')] } as never,
      }),
    ).toBe(true);
  });
});

describe('pendingOf', () => {
  const base: SweepConfirmation = {
    fosterable: 0,
    branches: 0,
    secondFiles: 0,
    restorable: 0,
    worktreeClaims: 0,
    exhausted: true,
  };

  it('sums every count, including the optional titlesOutOfStep', () => {
    expect(pendingOf({ ...base, fosterable: 2, secondFiles: 1, titlesOutOfStep: 3 })).toBe(6);
  });

  it('treats a missing titlesOutOfStep as zero, not NaN', () => {
    expect(pendingOf({ ...base, restorable: 4 })).toBe(4);
  });
});

describe('sweepFailedCount', () => {
  function reportWith(overrides: Partial<SweepReport>): SweepReport {
    const phase = { counts: { fostered: 0, skipped: 0, failed: 0 } };
    return {
      store: 'C:\\store',
      target: {
        accountUuid: '00000000-0000-4000-8000-000000000001',
        organizationUuid: '00000000-0000-4000-8000-000000000002',
      },
      dryRun: false,
      fostered: { outcomes: [], ...phase } as never,
      branches: { retitled: [], counts: { fostered: 0, skipped: 0, failed: 0 } } as never,
      restored: { outcomes: [], ...phase } as never,
      files: { retitled: [], plans: [], archived: 0, otherFileTemplate: '' } as never,
      worktreeClaims: { items: [], outcomes: [], counts: { released: 0, skipped: 0, failed: 0 } },
      archived: 0,
      liveWriters: [],
      neverComes: { fosterable: [], restorable: [] } as never,
      pinFixes: { fixes: [], moved: false },
      layout: {
        groupsCreated: 0,
        cardsAssigned: 0,
        orderEntriesAdded: 0,
        routinesBrought: 0,
        viewKeysCarried: 0,
      },
      rounds: 1,
      unreadableCards: [],
      ...overrides,
    } as SweepReport;
  }

  it('is zero when every phase came back clean', () => {
    expect(sweepFailedCount(reportWith({}))).toBe(0);
  });

  it('adds up failures across every phase, including the optional ones', () => {
    const report = reportWith({
      fostered: { outcomes: [], counts: { fostered: 1, skipped: 0, failed: 2 } } as never,
      branches: { retitled: [], counts: { fostered: 0, skipped: 0, failed: 1 } } as never,
      restored: { outcomes: [], counts: { fostered: 0, skipped: 0, failed: 3 } } as never,
      worktreeClaims: { items: [], outcomes: [], counts: { released: 0, skipped: 0, failed: 1 } },
      titleSync: {
        items: [],
        skipped: [],
        outcomes: [],
        counts: { synced: 0, skipped: 0, failed: 4 },
      },
      dates: {
        items: [],
        outcomes: [],
        counts: { advanced: 0, native: 0, skipped: 0, failed: 5 },
      } as never,
    });

    expect(sweepFailedCount(report)).toBe(2 + 1 + 3 + 1 + 4 + 5);
  });

  // The gap review found: `branches.counts.failed` is `summariseOutcomes`
  // of `branches.outcomes` (the copy/fostering outcomes), a different array
  // from `branches.retitled` (the branch pass's own marks); `files` has no
  // `counts` at all, only `files.retitled`. A write failure in either mark
  // pass — an unreadable card, a write error (`engine/retitle.ts`) — used to
  // vanish from this count, leaving `foster sweep --yes` exit 0 even though
  // `render.ts` marked the failure with a red `x` in the text output.
  it('counts a failed mark from the branch pass or the second-file pass, not just their outcomes', () => {
    const report = reportWith({
      branches: {
        retitled: [retitled('failed'), retitled('retitled'), retitled('skipped')],
        counts: { fostered: 0, skipped: 0, failed: 0 },
      } as never,
      files: {
        retitled: [retitled('failed'), retitled('failed'), retitled('retitled')],
        plans: [],
        archived: 0,
        otherFileTemplate: '',
      } as never,
    });

    expect(sweepFailedCount(report)).toBe(3);
  });
});
