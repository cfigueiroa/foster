import { describe, expect, it } from 'vitest';
import { sidebarFrom, type Sidebar } from '../src/engine/sidebar.js';
import type { Lineage } from '../src/engine/lineage.js';
import type { ConversationScan } from '../src/store/transcripts.js';
import type { DiscoveredSession } from '../src/domain/types.js';
import { NEW_ACCOUNT, session } from './helpers/store.js';

/**
 * `sidebarFrom` used to walk its full card list afresh for every question a
 * candidate asked (`reason`, `shows`, `unreached`) — cheap for one card, not
 * for the tens of thousands a real sweep asks about against a target account
 * that itself holds thousands of rows. It now keeps small indices instead
 * (`byExactId`, `byIdLower`, a lazily built `byWork`) and memoises
 * `unreached`'s `held` set per (id, except).
 *
 * The one property worth guarding on its own: `byWork` needs `kin.rootOf`,
 * and building it eagerly for every card — rather than only when a question
 * actually falls through to it — broke every caller whose `Lineage` answers
 * only the narrower question it actually asks (`engine/unclaim.ts`'s
 * `worktreeReachOf`, which never calls `reason`/`standing`/`extras`, is a real
 * one — `tests/unclaim.test.ts` hands it a `Lineage` stub with no `rootOf` at
 * all).
 */

function discovered(overrides: {
  sessionId: string;
  cliSessionId: string;
  cwd?: string;
  isCopy?: boolean;
  isArchived?: boolean;
}): DiscoveredSession {
  return {
    path: `/store/${overrides.sessionId}.json`,
    account: NEW_ACCOUNT,
    data: session({
      sessionId: overrides.sessionId,
      cliSessionId: overrides.cliSessionId,
      cwd: overrides.cwd,
      isArchived: overrides.isArchived ?? false,
    }),
    isCopy: overrides.isCopy ?? false,
    isStranded: false,
    reasons: [],
  };
}

/** A `Lineage` whose `rootOf` throws — the shape of a caller that never grouped by work. */
function rootlessKin(reach: (id: string | undefined) => ConversationScan | undefined): Lineage {
  return {
    rootOf: () => {
      throw new Error('rootOf should not have been called');
    },
    sameWork: () => false,
    scanOf: (id) => reach(id),
    reachOf: (id) => reach(id),
    deepen: () => {},
    transcripts: () => new Map(),
  };
}

function scanOf(uuids: string[]): ConversationScan {
  return { uuids: new Set(uuids) };
}

describe('sidebarFrom — laziness', () => {
  it('never asks the lineage for a root just to build its indices', () => {
    // Would have thrown at `sidebarFrom` itself, before this fix: every card
    // used to be indexed by its work (`kin.rootOf`) as it was added.
    expect(() =>
      sidebarFrom(
        [discovered({ sessionId: 'local_a', cliSessionId: 'a1' })],
        rootlessKin(() => undefined),
      ),
    ).not.toThrow();
  });

  it('answers unreached and shows without ever calling rootOf', () => {
    const kin = rootlessKin((id) => (id === 'a1' ? scanOf(['u1', 'u2']) : undefined));
    const here = sidebarFrom(
      [discovered({ sessionId: 'local_a', cliSessionId: 'a1', cwd: '/work' })],
      kin,
    );

    expect(here.shows('a1')).toBe(true);
    expect(here.shows('A1')).toBe(true);
    expect(here.shows('nope')).toBe(false);
    // The card itself is excluded, so what is left held is everything the row
    // already reaches — nothing beyond it, for its own conversation.
    expect(here.unreached('a1', '/work')).toBe(0);
  });

  it('markPlanned does not need a root either', () => {
    const kin = rootlessKin(() => undefined);
    const here = sidebarFrom([], kin);
    expect(() => here.markPlanned('a1', '/work')).not.toThrow();
    expect(here.shows('a1')).toBe(true);
  });
});

describe('sidebarFrom — reason', () => {
  it('is case-sensitive for the exact match, and returns the last row', () => {
    // A case-mismatched id falls through to the branch fallback, which does
    // ask `rootOf` — so this one gets a kin that actually answers it, unlike
    // the laziness tests above.
    const kin: Lineage = {
      rootOf: () => undefined,
      sameWork: () => false,
      scanOf: () => undefined,
      reachOf: () => undefined,
      deepen: () => {},
      transcripts: () => new Map(),
    };
    const here = sidebarFrom(
      [
        discovered({ sessionId: 'local_a', cliSessionId: 'a1' }),
        discovered({ sessionId: 'local_b', cliSessionId: 'a1', isCopy: true }),
      ],
      kin,
    );

    // Two rows share the id; the copy was added last, and `how` reports a
    // copy over a plain "already has it".
    expect(here.reason('a1')).toBe('this account already has a copy of that conversation');
    expect(here.reason('A1')).toBeUndefined();
  });

  it('falls back to the conversation’s root only when no exact row is here', () => {
    let rootOfCalls = 0;
    const kin: Lineage = {
      rootOf: (id) => {
        rootOfCalls += 1;
        if (id === 'sibling') return 'work-root';
        if (id === 'other') return 'work-root';
        return undefined;
      },
      sameWork: () => false,
      scanOf: () => undefined,
      reachOf: () => undefined,
      deepen: () => {},
      transcripts: () => new Map(),
    };

    const here = sidebarFrom([discovered({ sessionId: 'local_s', cliSessionId: 'sibling' })], kin);

    // Exact match — never touches rootOf.
    expect(here.reason('sibling')).toBe('this account already has that conversation');
    expect(rootOfCalls).toBe(0);

    // No exact row for 'other', but it shares a root with 'sibling'.
    expect(here.reason('other')).toBe('this account already has a branch of that conversation');
    expect(rootOfCalls).toBeGreaterThan(0);
  });

  it('picks up a card markPlanned adds after the branch index was already built', () => {
    const kin: Lineage = {
      rootOf: (id) => (id === 'sibling' || id === 'other' ? 'work-root' : undefined),
      sameWork: () => false,
      scanOf: () => undefined,
      reachOf: () => undefined,
      deepen: () => {},
      transcripts: () => new Map(),
    };
    const here = sidebarFrom([discovered({ sessionId: 'local_s', cliSessionId: 'sibling' })], kin);

    // Build (and cache) the branch index by asking about an unrelated id.
    expect(here.reason('unrelated-id')).toBeUndefined();

    // A card for a third, unrelated conversation is planned…
    here.markPlanned('unrelated-id', '/work');
    // …and the branch group for 'work-root' must still be found correctly,
    // proving the branch index was rebuilt rather than left stale.
    expect(here.reason('other')).toBe('this account already has a branch of that conversation');
  });
});

describe('sidebarFrom — unreached memoisation', () => {
  it('reflects a card markPlanned just added, not a stale answer', () => {
    const kin: Lineage = {
      rootOf: (id) => id,
      sameWork: () => false,
      scanOf: (id) => (id === 'a1' ? scanOf(['u1', 'u2', 'u3']) : undefined),
      reachOf: (id) => (id === 'a1' ? scanOf(['u1', 'u2', 'u3']) : undefined),
      deepen: () => {},
      transcripts: () => new Map(),
    };
    const here: Sidebar = sidebarFrom([], kin);

    // Nothing here yet: every record of the offered conversation is beyond it.
    expect(here.unreached('a1', '/work')).toBe(3);

    here.markPlanned('a1', '/work');

    // The row this run just committed to is held now — the memoised answer
    // from before `markPlanned` must not be served again.
    expect(here.unreached('a1', '/work')).toBe(0);
  });

  it('is not affected by a plan for a different conversation', () => {
    const kin: Lineage = {
      rootOf: (id) => id,
      sameWork: () => false,
      scanOf: (id) => (id === 'a1' ? scanOf(['u1']) : undefined),
      reachOf: (id) => (id === 'a1' ? scanOf(['u1']) : undefined),
      deepen: () => {},
      transcripts: () => new Map(),
    };
    const here = sidebarFrom([], kin);

    expect(here.unreached('a1', '/work')).toBe(1);
    here.markPlanned('b1', '/other');
    expect(here.unreached('a1', '/work')).toBe(1);
  });
});
