/**
 * Whether a JSON number literal, read back through `JSON.parse` and written
 * out again with `JSON.stringify`, would come back exactly as it was typed.
 *
 * `groupScopes.ts` and `viewPrefs.ts` both rewrite `claude_desktop_config.json`
 * by parsing the whole file and stringifying it again, and their "did anything
 * else move" check compares the two parsed trees — which cannot see a number
 * that changed shape during that same parse. Two shapes lose precision that
 * way: an integer past `Number.MAX_SAFE_INTEGER`
 * (`12345678901234567890` -> `12345678901234567000`) and any literal whose
 * canonical form differs textually, most often a trailing `.0` (`1.0` -> `1`)
 * or exponent notation (`1e3` -> `1000`). Both are legal JSON on their own;
 * this file only tells a literal that survives a round trip from one that does
 * not, so a caller can refuse before writing rather than after.
 */

export interface NumberLiteral {
  /** Exactly the characters read, digit for digit — never the parsed value. */
  literal: string;
  /** Offset into the scanned text where the literal starts. */
  index: number;
}

// JSON's own number grammar: an optional sign, an integer part with no
// leading zero (unless the whole part is a bare `0`), an optional fraction,
// an optional exponent. Sticky so `exec` only ever matches right at
// `lastIndex`, never by scanning ahead past it.
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Every number literal in `text`, in document order. String contents — JSON
 * strings, including their escapes — are skipped rather than scanned, so a
 * digit sitting inside a quoted value (a title, a path, a uuid) is never
 * mistaken for a number literal.
 */
export function numberLiterals(text: string): NumberLiteral[] {
  const out: NumberLiteral[] = [];
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (ch === '\\') {
        // The escaped character — including a literal backslash or quote —
        // is skipped along with the backslash itself, so a `\"` inside a
        // string never reads as the string's own closing quote.
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match && match.index === i && match[0].length > 0) {
        out.push({ literal: match[0], index: i });
        i += match[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** `true` when `literal` survives being read as a `Number` and written back out. */
export function isCanonicalNumberLiteral(literal: string): boolean {
  return String(Number(literal)) === literal;
}

/**
 * Every number literal in `text` that a `JSON.parse` / `JSON.stringify` round
 * trip would silently rewrite — the ones a writer that works on the parsed
 * tree can never see coming.
 */
export function nonCanonicalNumbers(text: string): NumberLiteral[] {
  return numberLiterals(text).filter((n) => !isCanonicalNumberLiteral(n.literal));
}
