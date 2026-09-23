import { describe, expect, it } from 'vitest';
import {
  layoutCheckLines,
  layoutFailureLines,
  layoutPendingCountsChanged,
  layoutPlanLines,
  layoutResultLines,
  viewNoticeLines,
  writtenOf,
} from '../src/cli/render.js';
import { LayoutWriteError, type ApplyLayoutResult, type LayoutPlan } from '../src/engine/layout.js';
import type { ViewState } from '../src/engine/view.js';

/**
 * The CLI-facing half of the layout/view restart fixes: `foster layout` and
 * `foster view` themselves cannot be driven in a test (`index.ts` runs the
 * program on import — see `tests/helpGroups.test.ts`'s own note on this), so
 * these exercise the pure rendering functions `src/cli/index.ts` calls, which
 * is where every one of these findings actually lives.
 */

// Strips the whole escape sequence, ESC byte included — render.test.ts's own
// helper leaves the bare ESC behind, which is fine for `toContain`/`toMatch`
// there but breaks exact equality here.
// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

const ACCOUNT_A = {
  accountUuid: '00000000-0000-4000-8000-0000000000a1',
  organizationUuid: '00000000-0000-4000-8000-000000000001',
};

function basePlan(overrides: Partial<LayoutPlan> = {}): LayoutPlan {
  return {
    target: ACCOUNT_A,
    groups: { items: [], conflicts: [], sources: 1 },
    routines: { bring: [], skipped: [], sources: 1 },
    viewPrefs: { changes: [], account: {} },
    ...overrides,
  };
}

describe('layoutPlanLines — R7: routine skip reasons', () => {
  it('prints its own words for a routine disabled in its newest account, not the SKILL.md text', () => {
    const plan = basePlan({
      routines: {
        bring: [],
        skipped: [{ id: 'r1', displayName: 'Nightly watchdog', reason: 'disabled' }],
        sources: 1,
      },
    });

    const lines = layoutPlanLines(plan).map(plain).join('\n');

    expect(lines).toContain('r1 — disabled in its newest account, not brought');
    expect(lines).not.toContain('SKILL.md missing');
  });

  it('still says SKILL.md missing for a routine whose file is actually gone', () => {
    const plan = basePlan({
      routines: {
        bring: [],
        skipped: [{ id: 'r2', displayName: 'Gone', reason: 'missing-skill' }],
        sources: 1,
      },
    });

    const lines = layoutPlanLines(plan).map(plain).join('\n');
    expect(lines).toContain('r2 — SKILL.md missing, not brought');
  });

  it('says which moment a missed one-shot was due', () => {
    const plan = basePlan({
      routines: {
        bring: [],
        skipped: [
          {
            id: 'r3',
            displayName: 'Once',
            reason: 'missed-one-shot',
            firedAt: Date.parse('2026-01-01T09:00:00Z'),
          },
        ],
        sources: 1,
      },
    });

    const lines = layoutPlanLines(plan).map(plain).join('\n');
    expect(lines).toContain('missed one-shot');
    expect(lines).toContain('not brought');
  });

  it('says nothing for the ordinary already-here case', () => {
    const plan = basePlan({
      routines: {
        bring: [],
        skipped: [{ id: 'r4', displayName: 'Here', reason: 'already-here' }],
        sources: 1,
      },
    });

    const lines = layoutPlanLines(plan).map(plain).join('\n');
    expect(lines).not.toContain('r4');
  });
});

describe('layoutPlanLines — R9: unrecognised group-scope entries', () => {
  it('says nothing when nothing was skipped reading the target scope', () => {
    const lines = layoutPlanLines(basePlan(), { groupScopesSkipped: 0 }).map(plain).join('\n');
    expect(lines).not.toMatch(/unrecognised/);
  });

  it('names how many entries were left untouched, singular', () => {
    const lines = layoutPlanLines(basePlan(), { groupScopesSkipped: 1 }).map(plain).join('\n');
    expect(lines).toContain("1 unrecognised entry in this account's groups were left untouched.");
  });

  it('pluralises for more than one', () => {
    const lines = layoutPlanLines(basePlan(), { groupScopesSkipped: 3 }).map(plain).join('\n');
    expect(lines).toContain("3 unrecognised entries in this account's groups were left untouched.");
  });
});

describe('layoutResultLines / layoutFailureLines — R4', () => {
  const result = (overrides: Partial<ApplyLayoutResult> = {}): ApplyLayoutResult => ({
    groupsTouched: 0,
    groupsCreated: 0,
    cardsAssigned: 2,
    orderEntriesAdded: 0,
    routinesBrought: 1,
    viewPrefsCarried: false,
    viewKeysCarried: 0,
    backups: [],
    written: ['groups (config)', 'routines'],
    assigned: [],
    syncPendingMarked: false,
    ...overrides,
  });

  it('printLayoutResult-equivalent prints the written list on success', () => {
    const lines = layoutResultLines(result()).map(plain).join('\n');
    expect(lines).toContain('2 row(s) grouped, 1 routine(s) brought.');
    expect(lines).toContain('wrote: groups (config), routines');
  });

  it('says nothing extra when nothing was written', () => {
    const lines = layoutResultLines(result({ written: [] }))
      .map(plain)
      .join('\n');
    expect(lines).not.toMatch(/wrote:/);
  });

  it('a LayoutWriteError prints its message and, once the class carries one, its own written list', () => {
    const error = new LayoutWriteError(['groups (config)'], 'routines', new Error('disk full'));
    const lines = layoutFailureLines(error).map(plain);

    // The message alone already says what landed and what failed — that much
    // holds regardless of whether LayoutWriteError has grown a `.written`
    // field yet (a concurrent change to engine/layout.ts).
    expect(lines[0]).toContain('Wrote: groups (config)');
    expect(lines[0]).toContain('Then failed writing routines: disk full');
  });

  it('any other thrown error is reported by its message, with nothing claimed about what it wrote', () => {
    const lines = layoutFailureLines(new Error('ENOENT: no such file')).map(plain);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ENOENT: no such file');
  });

  it('writtenOf reads a structural `written` field once the error actually carries one', () => {
    const error = new LayoutWriteError(['groups (config)'], 'routines', new Error('boom'));
    // Simulates the concurrent addition of `LayoutWriteError.written` landing:
    // writtenOf must not depend on the compiled type to find it.
    (error as unknown as { written: string[] }).written = ['groups (config)'];
    expect(writtenOf(error)).toEqual(['groups (config)']);
  });

  it('writtenOf is undefined for an error with no such field, and for a non-LayoutWriteError', () => {
    expect(writtenOf(new LayoutWriteError([], 'routines', new Error('boom')))).toBeUndefined();
    expect(writtenOf(new Error('plain'))).toBeUndefined();
    expect(writtenOf('not even an error')).toBeUndefined();
  });
});

describe('layoutCheckLines — groups read back after the restart', () => {
  const a = { cardId: 'code:local_a', groupId: 'cg-1', groupName: 'CI' };
  const b = { cardId: 'code:local_b', groupId: 'cg-2', groupName: 'Clients' };
  const c = { cardId: 'code:local_c', groupId: 'cg-2', groupName: 'Clients' };

  it('confirms every row once the app has rewritten its config with them', () => {
    const lines = layoutCheckLines({ appRewrote: true, waitedMs: 8_000, kept: [a, b], dropped: [] })
      .map(plain)
      .join('\n');
    expect(lines).toContain(
      'Checked after the app rewrote its config: all 2 row(s) are still in their groups.',
    );
  });

  it('says plainly that the app had not rewritten yet, rather than confirming', () => {
    const lines = layoutCheckLines({ appRewrote: false, waitedMs: 30_000, kept: [a], dropped: [] })
      .map(plain)
      .join('\n');
    expect(lines).toContain('The app had not rewritten its config 30s after starting');
    expect(lines).not.toContain('Checked after');
  });

  it('names how many rows were dropped, from which groups, and why', () => {
    const lines = layoutCheckLines({
      appRewrote: true,
      waitedMs: 8_000,
      kept: [a],
      dropped: [b, c],
    })
      .map(plain)
      .join('\n');
    expect(lines).toContain(
      'The app dropped 2 of 3 row(s) from their groups when it started (Clients).',
    );
    expect(lines).toContain('server copy');
    expect(lines).toContain('create_group and move_sessions');
  });
});

describe('layoutPendingCountsChanged — R2', () => {
  const counts = {
    groupsCreated: 0,
    cardsAssigned: 0,
    orderEntriesAdded: 0,
    routinesBrought: 0,
    viewKeysCarried: 0,
  };

  it('is false when every count the restart gap re-plans on agrees', () => {
    expect(layoutPendingCountsChanged(counts, { ...counts })).toBe(false);
  });

  it('is false when only orderEntriesAdded differs — not one of the compared counts', () => {
    expect(layoutPendingCountsChanged(counts, { ...counts, orderEntriesAdded: 5 })).toBe(false);
  });

  it('is true when cardsAssigned differs', () => {
    expect(layoutPendingCountsChanged(counts, { ...counts, cardsAssigned: 1 })).toBe(true);
  });

  it('is true when routinesBrought differs', () => {
    expect(layoutPendingCountsChanged(counts, { ...counts, routinesBrought: 1 })).toBe(true);
  });

  it('is true when groupsCreated differs', () => {
    expect(layoutPendingCountsChanged(counts, { ...counts, groupsCreated: 1 })).toBe(true);
  });

  it('is true when viewKeysCarried differs', () => {
    expect(layoutPendingCountsChanged(counts, { ...counts, viewKeysCarried: 1 })).toBe(true);
  });
});

describe('viewNoticeLines — R8', () => {
  function state(notices: string[] | undefined): ViewState {
    return {
      sort: 'recency',
      account: {},
      legacy: [],
      ...(notices
        ? {
            machineRecord: {
              document: {},
              logPath: 'C:\\store\\Local Storage\\leveldb\\000003.log',
              highestSequence: 0n,
              notices,
              encoding: 'latin1',
            },
          }
        : {}),
    };
  }

  it('prints each notice from the machine record read', () => {
    const lines = viewNoticeLines(state(['recovered the manifest from 000003.log'])).map(plain);
    expect(lines).toEqual(['recovered the manifest from 000003.log']);
  });

  it('prints nothing when there is no machine record at all', () => {
    expect(viewNoticeLines(state(undefined))).toEqual([]);
  });

  it('prints nothing when the machine record carries no notices', () => {
    expect(viewNoticeLines(state([]))).toEqual([]);
  });
});
