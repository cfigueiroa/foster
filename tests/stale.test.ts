import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIVERGED_TEMPLATE,
  DEFAULT_STALE_TEMPLATE,
  formatStamp,
  looksMarked,
  staleMark,
  staleMatcher,
  stripStale,
  templatesSeen,
  UNDATED,
} from '../src/domain/stale.js';
import type { AccountRef } from '../src/domain/types.js';
import type { CardRetitledEvent, FosteredEvent, LedgerEvent } from '../src/ledger/types.js';

/**
 * The mark a row wears when it is not the branch that carried on. What these
 * pin down is that the mark can always be taken off again — a branch that was
 * stale can carry on and become the tip — and that it never stacks.
 */

const AT = new Date(2026, 8, 1, 18, 10).getTime();

describe('formatStamp', () => {
  it('is day, month and clock time in the local zone', () => {
    expect(formatStamp(AT)).toBe('01/09 18:10');
  });

  it('says so when there is no moment to give', () => {
    expect(formatStamp(undefined)).toBe(UNDATED);
    expect(formatStamp(Number.NaN)).toBe(UNDATED);
  });
});

describe('staleMark', () => {
  it('fills the slot with the moment', () => {
    expect(staleMark(DEFAULT_STALE_TEMPLATE, AT)).toBe('(stale, stopped 01/09 18:10) ');
  });

  it('is the template itself when the template has no slot', () => {
    expect(staleMark('[old] ', AT)).toBe('[old] ');
  });

  it('is nothing when the template is nothing', () => {
    expect(staleMark('', AT)).toBe('');
  });
});

describe('stripStale', () => {
  it('takes the mark off whatever moment it carries', () => {
    const title = `${staleMark(DEFAULT_STALE_TEMPLATE, AT)}Configure the Macs`;
    expect(stripStale(title, DEFAULT_STALE_TEMPLATE)).toBe('Configure the Macs');
    expect(stripStale('(stale, stopped —) Configure the Macs', DEFAULT_STALE_TEMPLATE)).toBe(
      'Configure the Macs',
    );
  });

  it('leaves a title with no mark exactly as it is', () => {
    expect(stripStale('Configure the Macs', DEFAULT_STALE_TEMPLATE)).toBe('Configure the Macs');
    expect(stripStale('', DEFAULT_STALE_TEMPLATE)).toBe('');
  });

  it('takes off a mark that was stacked, all the way down', () => {
    // The app forks by copying the card, so a branch forked from a marked row
    // inherits the mark, and a sweep that marked it again would stack them.
    const once = staleMark(DEFAULT_STALE_TEMPLATE, AT);
    const twice = `${once}${staleMark(DEFAULT_STALE_TEMPLATE, AT + 3_600_000)}Work`;
    expect(stripStale(twice, DEFAULT_STALE_TEMPLATE)).toBe('Work');
  });

  it('does not swallow a title that contains the template’s closing characters', () => {
    const title = `${staleMark(DEFAULT_STALE_TEMPLATE, AT)}Fix (parser) and (lexer)`;
    expect(stripStale(title, DEFAULT_STALE_TEMPLATE)).toBe('Fix (parser) and (lexer)');
  });

  it('treats the template literally, whatever it contains', () => {
    const template = '[*old* {when}] ';
    const title = `${staleMark(template, AT)}Notes`;
    expect(staleMatcher(template).test(title)).toBe(true);
    expect(stripStale(title, template)).toBe('Notes');
    expect(stripStale('[xoldx 01/09 18:10] Notes', template)).toBe('[xoldx 01/09 18:10] Notes');
  });

  it('changes nothing for an empty template', () => {
    expect(stripStale('(stale, stopped 01/09 18:10) Work', '')).toBe(
      '(stale, stopped 01/09 18:10) Work',
    );
  });
});

const TARGET: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000a',
  organizationUuid: '00000000-0000-4000-8000-0000000000a0',
};
const ORIGIN: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000b',
  organizationUuid: '00000000-0000-4000-8000-0000000000b0',
};

function retitled(
  fields: Partial<CardRetitledEvent> & Pick<CardRetitledEvent, 'from' | 'to' | 'as'>,
): LedgerEvent {
  return {
    v: 1,
    ts: 1,
    toolVersion: '0.0.0',
    kind: 'card_retitled',
    sessionId: 'local_card-1',
    target: TARGET,
    path: 'C:\\home\\store\\local_card-1.json',
    native: true,
    ...fields,
  };
}

function fostered(fields: Partial<FosteredEvent> = {}): LedgerEvent {
  return {
    v: 1,
    ts: 1,
    toolVersion: '0.0.0',
    kind: 'fostered',
    originSessionId: 'local_origin-1',
    origin: ORIGIN,
    target: TARGET,
    copySessionId: 'local_copy-1',
    copyPath: 'C:\\home\\store\\local_copy-1.json',
    prefix: '',
    ...fields,
  };
}

/**
 * The distinct templates the ledger proves were used — the fix for #35. A
 * `stripStale` given the current run's own words cannot see a mark written
 * with somebody else's; this is where the log makes them visible again.
 */
describe('templatesSeen', () => {
  it('reads the explicit field first, in first-seen order', () => {
    const events = [
      retitled({
        from: 'Work',
        to: '(defasada, parou 02/09 07:07) Work',
        as: 'stale',
        template: '(defasada, parou {when}) ',
      }),
      retitled({
        from: 'Other',
        to: '(outro ramo, seguiu 02/09 07:07) Other',
        as: 'diverged',
        template: '(outro ramo, seguiu {when}) ',
      }),
      retitled({
        from: 'Work',
        to: '(defasada, parou 03/09 08:00) Work',
        as: 'stale',
        template: '(defasada, parou {when}) ',
      }),
    ];

    expect(templatesSeen(events)).toEqual([
      '(defasada, parou {when}) ',
      '(outro ramo, seguiu {when}) ',
    ]);
  });

  it('derives the template from a stale event whose from is the clean title', () => {
    const events = [
      retitled({
        from: 'Configure the Macs',
        to: `${staleMark(DEFAULT_STALE_TEMPLATE, Date.parse('2026-09-01T18:10:00.000Z'))}Configure the Macs`,
        as: 'stale',
      }),
    ];

    expect(templatesSeen(events)).toEqual([DEFAULT_STALE_TEMPLATE]);
  });

  it('derives the template from a tip event, whose to is the clean title', () => {
    const marked = `${staleMark(DEFAULT_DIVERGED_TEMPLATE, Date.parse('2026-09-01T18:10:00.000Z'))}Configure the Macs`;
    const events = [retitled({ from: marked, to: 'Configure the Macs', as: 'tip' })];

    expect(templatesSeen(events)).toEqual([DEFAULT_DIVERGED_TEMPLATE]);
  });

  it('derives from a doubly-marked from, where the clean title is the common suffix', () => {
    // Marked stale on one run, diverged on the next — #35 makes this ordinary.
    // `from` already wears an earlier mark of its own; subtracting `from`
    // outright (titleSync's own trick) would strip nothing away, but the
    // longest suffix `from` and `to` still share is the clean title, whatever
    // either mark says — `[old]` here does not even punctuate itself the way
    // `to`'s own mark does, and the derivation is unbothered.
    const events = [
      retitled({
        from: '[old]Recuperar chats antigos',
        to: '(outro ramo, seguiu 26/08 14:24) Recuperar chats antigos',
        as: 'diverged',
      }),
    ];

    expect(templatesSeen(events)).toEqual(['(outro ramo, seguiu {when}) ']);
  });

  it('derives the template from an old fostered event, from the prefix it carried', () => {
    const events = [
      fostered({
        prefix: staleMark(DEFAULT_STALE_TEMPLATE, Date.parse('2026-09-01T18:10:00.000Z')),
      }),
    ];

    expect(templatesSeen(events)).toEqual([DEFAULT_STALE_TEMPLATE]);
  });

  it('has nothing to contribute from a synced event', () => {
    const events = [retitled({ from: 'Old name', to: 'New name', as: 'synced' })];

    expect(templatesSeen(events)).toEqual([]);
  });

  it('drops a derivation with no stamp, an empty mark, or a mark over 80 characters', () => {
    const tooLong = `(${'x'.repeat(90)} 02/09 07:07) `;
    const events = [
      // No stamp at all: not a mark.
      retitled({ from: 'Work', to: 'Fix (parser) and (lexer) Work', as: 'stale' }),
      // Nothing before the shared suffix: no mark was added.
      retitled({ from: 'Work', to: 'Work', as: 'stale' }),
      retitled({ from: 'Work', to: `${tooLong}Work`, as: 'stale' }),
    ];

    expect(templatesSeen(events)).toEqual([]);
  });

  it('is empty for no events', () => {
    expect(templatesSeen([])).toEqual([]);
  });
});

/**
 * The heuristic that stands between "recognised from the ledger" and
 * "written on top of, stacking a second mark" — a title with no template to
 * explain it, but that still looks like it is wearing one.
 */
describe('looksMarked', () => {
  it.each([
    ['(defasada, parou 02/09 07:07) X', true],
    ['[xoldx 01/09 18:10] X', true],
    ['(stale, stopped —) X', true],
    ['Fix (parser) and (lexer)', false],
    ['01/09 relatório', false],
    ['A bare title', false],
  ])('%s -> %s', (title, expected) => {
    expect(looksMarked(title)).toBe(expected);
  });
});
