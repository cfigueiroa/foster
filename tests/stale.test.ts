import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_TEMPLATE,
  formatStamp,
  staleMark,
  staleMatcher,
  stripStale,
  UNDATED,
} from '../src/domain/stale.js';

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
