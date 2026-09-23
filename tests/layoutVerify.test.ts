import { describe, expect, it } from 'vitest';
import type { LayoutAssignment } from '../src/engine/layout.js';
import { verifyLayoutGroups } from '../src/engine/layoutVerify.js';
import type { GroupScope } from '../src/store/groupScopes.js';
import { makeStore, NEW_ACCOUNT } from './helpers/store.js';

const ASSIGNED: LayoutAssignment[] = [
  { cardId: 'code:local_a', groupId: 'cg-1', groupName: 'CI' },
  { cardId: 'code:local_b', groupId: 'cg-2', groupName: 'Clients' },
];

const WRITTEN = 1_000;

/**
 * A fake clock the check's own `sleep` advances, and a config whose mtime and
 * content change at given moments — the app's startup rewrite, simulated.
 */
function scenario(rewrites: { at: number; scope: GroupScope | undefined }[]) {
  let clock = 0;
  let reads = 0;
  const current = (): { mtime: number; scope: GroupScope | undefined } => {
    let state = { mtime: WRITTEN, scope: foster as GroupScope | undefined };
    for (const rewrite of rewrites) {
      if (clock >= rewrite.at) state = { mtime: WRITTEN + rewrite.at, scope: rewrite.scope };
    }
    return state;
  };
  return {
    options: {
      writtenMtimeMs: WRITTEN,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      mtimeOf: () => current().mtime,
      readScope: () => {
        reads += 1;
        return current().scope;
      },
    },
    reads: () => reads,
  };
}

/** What `applyLayout` left in the config. */
const foster: GroupScope = {
  groups: [
    { id: 'cg-1', name: 'CI' },
    { id: 'cg-2', name: 'Clients' },
  ],
  assignments: { 'code:local_a': 'cg-1', 'code:local_b': 'cg-2' },
};

describe('verifyLayoutGroups', () => {
  it('reports every row dropped when the app rewrites the config without the scope (23/09/2026)', async () => {
    const { options } = scenario([{ at: 3_000, scope: undefined }]);
    const check = await verifyLayoutGroups(makeStore(), NEW_ACCOUNT, ASSIGNED, options);
    expect(check.appRewrote).toBe(true);
    expect(check.kept).toEqual([]);
    expect(check.dropped).toEqual(ASSIGNED);
  });

  it('reports every row kept when the rewrite carries them', async () => {
    const { options } = scenario([{ at: 3_000, scope: foster }]);
    const check = await verifyLayoutGroups(makeStore(), NEW_ACCOUNT, ASSIGNED, options);
    expect(check.appRewrote).toBe(true);
    expect(check.kept).toEqual(ASSIGNED);
    expect(check.dropped).toEqual([]);
    // Settled for the quiet window after the rewrite, not the whole timeout.
    expect(check.waitedMs).toBeLessThan(30_000);
    expect(check.waitedMs).toBeGreaterThanOrEqual(8_000);
  });

  it('waits out a second rewrite rather than trusting the first', async () => {
    const { options } = scenario([
      { at: 1_000, scope: foster },
      { at: 4_000, scope: { groups: [], assignments: {} } },
    ]);
    const check = await verifyLayoutGroups(makeStore(), NEW_ACCOUNT, ASSIGNED, options);
    expect(check.dropped).toEqual(ASSIGNED);
  });

  it('counts a card filed under a group of another name as dropped', async () => {
    const { options } = scenario([
      {
        at: 2_000,
        scope: {
          groups: [
            { id: 'cg-1', name: 'CI' },
            { id: 'cg-9', name: 'Something else' },
          ],
          assignments: { 'code:local_a': 'cg-1', 'code:local_b': 'cg-9' },
        },
      },
    ]);
    const check = await verifyLayoutGroups(makeStore(), NEW_ACCOUNT, ASSIGNED, options);
    expect(check.kept.map((entry) => entry.cardId)).toEqual(['code:local_a']);
    expect(check.dropped.map((entry) => entry.cardId)).toEqual(['code:local_b']);
  });

  it('says the app never rewrote when the window closes quietly, and reads what is there', async () => {
    const { options, reads } = scenario([]);
    const check = await verifyLayoutGroups(makeStore(), NEW_ACCOUNT, ASSIGNED, {
      ...options,
      timeoutMs: 10_000,
    });
    expect(check.appRewrote).toBe(false);
    expect(check.waitedMs).toBeGreaterThanOrEqual(10_000);
    expect(check.kept).toEqual(ASSIGNED);
    expect(reads()).toBe(1);
  });

  it('treats an unreadable config as nothing vouched for', async () => {
    const { options } = scenario([{ at: 1_000, scope: foster }]);
    const check = await verifyLayoutGroups(makeStore(), NEW_ACCOUNT, ASSIGNED, {
      ...options,
      readScope: () => {
        throw new Error('Unexpected end of JSON input');
      },
    });
    expect(check.dropped).toEqual(ASSIGNED);
  });
});
