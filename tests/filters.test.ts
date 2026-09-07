import { describe, expect, it } from 'vitest';
import { selectByIds } from '../src/domain/filter.js';
import { selectFosterSessions } from '../src/ops/foster.js';
import type { DiscoveredSession, Unfosterable } from '../src/domain/types.js';
import { OLD_ACCOUNT, session } from './helpers/store.js';

const found = (sessionId: string): DiscoveredSession => ({
  path: `C:\${sessionId}.json`,
  account: OLD_ACCOUNT,
  data: session({ sessionId }),
  isCopy: false,
  isStranded: false,
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

/**
 * An id that names a session foster is holding back.
 *
 * The old answer was "No session matches <id>", under advice to go and look at
 * `foster list` — where the session is, with its reasons in the row. Two
 * readings of that are both wrong: the id is a typo, or the session is gone.
 * Measured on a real store, it cost three attempts at a correct id before the
 * reason was found by other means.
 */
describe('naming a session that is held back', () => {
  const held = (reasons: Unfosterable[]): DiscoveredSession => ({
    ...found(A),
    reasons,
  });

  it('says why, instead of claiming nothing matches', () => {
    expect(() => selectFosterSessions([], [`local_${A}`], [held(['never-opened'])])).toThrow(
      /never opened/,
    );
  });

  it('does not send the reader off to check an id that was right', () => {
    expect(() => selectFosterSessions([], [`local_${A}`], [held(['never-opened'])])).not.toThrow(
      /No session matches/,
    );
  });

  it('names the flag that would include it', () => {
    expect(() => selectFosterSessions([], [`local_${A}`], [held(['archived'])])).toThrow(
      /--archived/,
    );
    expect(() => selectFosterSessions([], [`local_${A}`], [held(['spawned-task'])])).toThrow(
      /--include-spawned/,
    );
  });

  /**
   * `never-opened` on its own has no flag. Offering one would be worse than
   * offering none: the reader would try it and get the same refusal back.
   */
  it('offers no flag when there is none that lifts the reason', () => {
    expect(() => selectFosterSessions([], [`local_${A}`], [held(['never-opened'])])).not.toThrow(
      /Add --/,
    );
  });

  it('still says nothing matches for an id that names nothing', () => {
    const missing = '00000000-0000-4000-8000-0000000000c3';
    expect(() => selectFosterSessions([], [`local_${missing}`], [held(['archived'])])).toThrow(
      /No session matches/,
    );
  });
});
