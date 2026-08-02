import { describe, expect, it } from 'vitest';
import { selectByIds } from '../src/cli/filters.js';
import type { DiscoveredSession } from '../src/domain/types.js';
import { OLD_ACCOUNT, session } from './helpers/store.js';

const found = (sessionId: string): DiscoveredSession => ({
  path: `C:\${sessionId}.json`,
  account: OLD_ACCOUNT,
  data: session({ sessionId }),
  isCopy: false,
  reasons: [],
});

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const sessions = [found(A), found(B)];

describe('selectByIds', () => {
  it('accepts the id the way the app writes it', () => {
    const { selected } = selectByIds(sessions, [`local_${A}`]);
    expect(selected.map((s) => s.data.sessionId)).toEqual([`local_${A}`]);
  });

  it('accepts the bare id, and any unique prefix of it', () => {
    expect(selectByIds(sessions, [A]).selected).toHaveLength(1);
    expect(selectByIds(sessions, ['00000000-0000-4000-8000-0000000000a']).selected).toHaveLength(1);
  });

  it('reports an id that matches nothing instead of returning an empty batch', () => {
    // A typo and "that session is gone" are indistinguishable otherwise, and
    // only one of them means the user should stop and look.
    const { selected, unmatched } = selectByIds(sessions, [A, 'deadbeef']);
    expect(selected).toHaveLength(1);
    expect(unmatched).toEqual(['deadbeef']);
  });

  it('names each session once even when two arguments select it', () => {
    // The prefix has to reach the character where these fixtures diverge, which
    // is the last one — a shorter one would legitimately match both.
    const { selected } = selectByIds(sessions, [A, A.slice(0, 35)]);
    expect(selected).toHaveLength(1);
  });

  it('takes every match of an ambiguous prefix rather than picking one', () => {
    const { selected, unmatched } = selectByIds(sessions, ['00000000']);
    expect(selected).toHaveLength(2);
    expect(unmatched).toEqual([]);
  });
});
