import { describe, expect, it } from 'vitest';
import {
  isCanonicalNumberLiteral,
  nonCanonicalNumbers,
  numberLiterals,
} from '../src/util/jsonNumbers.js';

/**
 * The scanner `groupScopes.ts` and `viewPrefs.ts` both refuse to write on: a
 * number literal `JSON.parse` / `JSON.stringify` would rewrite, found by
 * reading the raw text rather than the already-lossy parsed tree.
 */

describe('numberLiterals', () => {
  it('finds every number literal outside strings, with its offset', () => {
    const text = '{"a":1,"b":-2.5,"c":[3,4]}';
    expect(numberLiterals(text)).toEqual([
      { literal: '1', index: 5 },
      { literal: '-2.5', index: 11 },
      { literal: '3', index: 21 },
      { literal: '4', index: 23 },
    ]);
  });

  it('ignores digits inside strings, including ones that look like numbers', () => {
    const text = '{"path":"C:\\\\repos\\\\v1.0","n":1.0}';
    const found = numberLiterals(text);
    expect(found.map((n) => n.literal)).toEqual(['1.0']);
  });

  it('does not let an escaped quote inside a string end the string early', () => {
    // Without escape-aware skipping, the `\"` would be read as the string's
    // close, and the `5` right after would be read as a bare number literal.
    const text = String.raw`{"title":"say \"5\" now","n":6}`;
    const found = numberLiterals(text);
    expect(found).toEqual([{ literal: '6', index: text.indexOf('6') }]);
  });

  it('does not let a trailing backslash desync string tracking', () => {
    // A string ending in an escaped backslash (`...\\"`) must still close on
    // that quote, not skip past it into the rest of the document.
    const text = String.raw`{"a":"ends in backslash \\","n":7}`;
    const found = numberLiterals(text);
    expect(found).toEqual([{ literal: '7', index: text.indexOf('7') }]);
  });

  it('reads negative numbers, exponents and fractions as one literal each', () => {
    const text = '[-5,1.5e10,0,0.25,-1.2E-3]';
    expect(numberLiterals(text).map((n) => n.literal)).toEqual([
      '-5',
      '1.5e10',
      '0',
      '0.25',
      '-1.2E-3',
    ]);
  });
});

describe('isCanonicalNumberLiteral', () => {
  it('passes ordinary integers, floats and negatives', () => {
    for (const literal of ['0', '1', '42', '-7', '3.25', '-0.5', '1000']) {
      expect(isCanonicalNumberLiteral(literal)).toBe(true);
    }
  });

  it('refuses an integer past Number.MAX_SAFE_INTEGER', () => {
    // 12345678901234567890 -> 12345678901234567000 once it round-trips
    // through a double.
    expect(isCanonicalNumberLiteral('12345678901234567890')).toBe(false);
  });

  it('refuses a trailing .0', () => {
    expect(isCanonicalNumberLiteral('1.0')).toBe(false);
  });

  it('refuses exponent notation', () => {
    expect(isCanonicalNumberLiteral('1e3')).toBe(false);
  });
});

describe('nonCanonicalNumbers', () => {
  it('flags an unsafe integer, wherever it sits in the document', () => {
    const text = '{"preferences":{"someId":12345678901234567890,"kept":1}}';
    const found = nonCanonicalNumbers(text);
    expect(found.map((n) => n.literal)).toEqual(['12345678901234567890']);
  });

  it('flags 1.0', () => {
    const found = nonCanonicalNumbers('{"n":1.0}');
    expect(found.map((n) => n.literal)).toEqual(['1.0']);
  });

  it('flags 1e3', () => {
    const found = nonCanonicalNumbers('{"n":1e3}');
    expect(found.map((n) => n.literal)).toEqual(['1e3']);
  });

  it('ignores a number-shaped literal sitting inside a string', () => {
    expect(nonCanonicalNumbers('{"version":"1.0","note":"12345678901234567890"}')).toEqual([]);
  });

  it('passes a normal config with only ordinary ints/floats/negatives', () => {
    const text = JSON.stringify({
      a: 1,
      b: -2,
      c: 3.5,
      d: 0,
      nested: { e: -0.25, f: 1000 },
      list: [1, 2, 3],
    });
    expect(nonCanonicalNumbers(text)).toEqual([]);
  });

  it('names the first offender in document order when there are several', () => {
    const text = '{"a":1.0,"b":1e3,"c":12345678901234567890}';
    const found = nonCanonicalNumbers(text);
    expect(found.map((n) => n.literal)).toEqual(['1.0', '1e3', '12345678901234567890']);
  });
});
