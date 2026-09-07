import type { LedgerEvent } from '../ledger/types.js';

/**
 * How a row says it is not the branch that carried on.
 *
 * A fork leaves one piece of work on two or more transcripts, and the sweep
 * gives each of them a row rather than choosing between them. Two rows with the
 * same title then say nothing about which one to open, which on a real store
 * was the whole complaint: the row somebody had pinned was the one that stopped
 * a day earlier, and nothing in the sidebar said so.
 *
 * So the branch that carried on keeps its title untouched, and every other
 * branch wears a mark in front of its own, carrying the moment its last answer
 * was written — the one fact that tells a reader "this is where it was left".
 * The mark is a template, because the words are the user's to choose and the
 * sidebar is read in whatever language they think in; `{when}` is where the
 * moment goes.
 */

export const DEFAULT_STALE_TEMPLATE = '(stale, stopped {when}) ';

/**
 * What a branch wears when it is not the tip but is not stale either.
 *
 * Measured on a real store: of the 40 forks the sweep could see, 2 had a branch
 * that was not the tip and had still said the last word — holding records of
 * its own that the tip never got, one 50 hours ahead of it and the other 77.
 * Calling those "stale, stopped ..." and filing them in the archived view sent
 * the reader to the fatter half and hid the half they had been working in.
 * (Counting every transcript on the disk the shape appears in 111 of 209
 * conversations, but most of those are CLI sessions with no card anywhere, and
 * a branch nobody holds a card for is not a row this ever decides about.)
 * Ranking by sheer recency instead would be worse: one trivial turn on an
 * abandoned half would promote it over a branch holding a thousand records
 * nobody else has.
 *
 * So neither half is called stale. The tip is still the branch holding most
 * work of its own, and a branch that went on after it keeps its place in the
 * sidebar, wearing the moment it went on to.
 */
export const DEFAULT_DIVERGED_TEMPLATE = '(other branch, went on {when}) ';

/** The slot in a template that the moment fills. */
export const WHEN = '{when}';

/** What a mark says when the branch has no dated record to speak of. */
export const UNDATED = '—';

/**
 * The stamp shape a mark carries: `DD/MM HH:MM`, or the undated dash. Shared
 * between `templatesSeen`'s derivation and `looksMarked`'s heuristic, which
 * both have to recognise the same thing without being told the template.
 */
const STAMP_SHAPE = /\d{2}\/\d{2} \d{2}:\d{2}|—/;

/**
 * The moment embedded in a mark, whatever words carry it — for telling two
 * marks apart by what they say rather than by how they say it. A row already
 * marked with the moment a fresh mark would carry has nothing left to learn
 * from being rewritten in this run's own words; see `branchCards.ts`'s
 * `retitleFor`, which is #35's actual fix: recognising an old mark is only
 * half of it, and leaving it alone once recognised is the other half.
 */
export function stampWithin(text: string): string | undefined {
  return STAMP_SHAPE.exec(text)?.[0];
}

/**
 * `DD/MM HH:MM`, in the machine's own clock.
 *
 * Deliberately short: it sits in front of a title in a sidebar that truncates,
 * and a reader comparing two stale rows needs the day and the hour, not the
 * year. Local time because that is the clock the person was working by.
 */
export function formatStamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return UNDATED;
  const date = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The mark a stale row wears, with the moment filled in. */
export function staleMark(template: string, stoppedAt: number | undefined): string {
  return template.split(WHEN).join(formatStamp(stoppedAt));
}

/**
 * Recognise a mark made from this template, whatever moment it carries.
 *
 * Anchored at the start, because that is where a mark goes; the slot matches
 * as little as it can, so a title that itself contains the template's closing
 * characters is not swallowed with it.
 */
export function staleMatcher(template: string): RegExp {
  const literal = template.split(WHEN).map(escapeRegExp);
  return new RegExp(`^${literal.join('.*?')}`);
}

/**
 * The title underneath the mark.
 *
 * Applied until nothing changes rather than once: the app forks a conversation
 * by copying its card, so a branch forked from a marked row inherits the mark,
 * and a sweep that then marks it again would stack them. An empty template
 * matches the empty string and changes nothing, which is the right answer for
 * "no mark at all".
 */
export function stripStale(title: string, template: string): string {
  if (template === '') return title;
  const matcher = staleMatcher(template);
  let out = title;
  for (;;) {
    const next = out.replace(matcher, '');
    if (next === out) return out;
    out = next;
  }
}

/**
 * The title underneath any of these marks.
 *
 * A branch can have worn a different mark on an earlier sweep — a row marked
 * stale that turns out to have gone on after the tip, or the reverse — so the
 * clean title is what is left once every mark this run knows about is gone.
 * Order does not matter: each is anchored at the start and applied until it
 * stops matching.
 */
export function stripMarks(title: string, templates: readonly string[]): string {
  let out = title;
  for (;;) {
    let next = out;
    for (const template of templates) next = stripStale(next, template);
    if (next === out) return out;
    out = next;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** No mark this long is a template — see `templatesSeen` and `looksMarked`. */
const MAX_TEMPLATE_LENGTH = 80;

/**
 * The prefix of `a` left over once its longest suffix shared with `b` is
 * removed — how a mark is told apart from the clean title sitting behind it,
 * without either side having to say which template produced it.
 */
function beforeCommonSuffix(a: string, b: string): string {
  let shared = 0;
  while (
    shared < a.length &&
    shared < b.length &&
    a[a.length - 1 - shared] === b[b.length - 1 - shared]
  ) {
    shared += 1;
  }
  return a.slice(0, a.length - shared);
}

/**
 * A candidate mark, turned into the template it was probably made from — or
 * discarded, when it does not look like one was.
 *
 * Conservative on purpose: this only ever runs against a record the ledger
 * already proves foster wrote, and a wrong guess here would plant a stray
 * template in `templatesSeen`'s output, which every later sweep then strips
 * against. `undefined` is always the safe answer.
 */
function templateFrom(mark: string): string | undefined {
  if (!mark) return undefined;
  const replaced = mark.replace(STAMP_SHAPE, WHEN);
  if (replaced === mark) return undefined; // no stamp found — not a mark
  if (!replaced.includes(WHEN)) return undefined;
  if (replaced.length > MAX_TEMPLATE_LENGTH) return undefined;
  return replaced;
}

/**
 * The distinct templates the ledger proves were used, in first-seen order.
 *
 * `stripMarks` only recognises what it is handed, so a row marked by an
 * earlier run — the `/fosteia` skill's own words, or a bare `foster sweep`'s
 * English defaults — was invisible to a later run given different ones, and
 * the new mark landed in front of the old rather than replacing it (#35).
 * The words are already in the log: every `card_retitled` and every `fostered`
 * a mark rides in on says what it wrote, or — for an entry recorded before
 * this field existed — carries enough of the mark itself to derive it from.
 *
 * The explicit `template` field always wins, because it is the record rather
 * than a guess: `as: 'synced'` never carries one, since a sync never adds a
 * mark of its own, and its title never derives one either.
 */
export function templatesSeen(events: readonly LedgerEvent[]): string[] {
  const seen: string[] = [];
  const add = (template: string | undefined): void => {
    if (template && !seen.includes(template)) seen.push(template);
  };

  // The record first: an event that says what it used is never second-guessed
  // by a derivation, however that derivation would have read it.
  for (const event of events) {
    if (event.kind === 'card_retitled') {
      if (event.as === 'stale' || event.as === 'diverged' || event.as === 'tip')
        add(event.template);
    } else if (event.kind === 'fostered') {
      add(event.template);
    }
  }

  // Then the fallback, for entries written before the field existed.
  for (const event of events) {
    if (event.kind === 'card_retitled' && event.template === undefined) {
      if (event.as === 'stale' || event.as === 'diverged') {
        // `to` carries the mark; `from` is the clean title beneath it — even
        // when `from` itself already wears an older mark, the clean title is
        // still the suffix the two share.
        add(templateFrom(beforeCommonSuffix(event.to, event.from)));
      } else if (event.as === 'tip') {
        // The reverse: `from` carries the mark this write took off, `to` is
        // what was left.
        add(templateFrom(beforeCommonSuffix(event.from, event.to)));
      }
    } else if (event.kind === 'fostered' && event.template === undefined) {
      // `prefix` is the whole prefix the copy was titled with, mark included —
      // the ordinary prefix is empty by default, so this is usually the mark
      // on its own.
      add(templateFrom(event.prefix));
    }
  }

  return seen;
}

/**
 * A run of at most 60 characters, from the very start of the title, that reads
 * like a mark: some opening text, a stamp (`DD/MM HH:MM` or the undated dash),
 * more text, a closing delimiter, and a space before whatever follows.
 */
const MARK_SHAPE = /^.{0,58}?[)\]}>"'»]\x20/;

/** At most this many characters make up the mark this heuristic will call one. */
const MAX_MARK_LENGTH = 60;

/**
 * Whether a title, already stripped of every template a run knows about,
 * still looks like it is wearing one it does not.
 *
 * A heuristic, and one that errs toward leaving a row alone: it does not know
 * what a real mark looks like beyond "short, dated, closed off from the rest
 * of the title" — `(defasada, parou 02/09 07:07) `, `[xoldx 01/09 18:10] `,
 * `(stale, stopped —) `. An ordinary title that happens to open with a dated
 * parenthetical, `Fix (parser) and (lexer)` or a bare `01/09 relatório`, does
 * not have both a stamp and a delimiter in that short a run and is left alone.
 * False positives cost nothing but a skip the user can still do by hand with
 * `--stale-prefix`/`--branch-prefix`; a false negative would silently stack a
 * mark this run cannot read, which is the defect this whole change exists to
 * close.
 */
export function looksMarked(title: string): boolean {
  const match = MARK_SHAPE.exec(title);
  if (!match) return false;
  const prefix = match[0];
  if (prefix.length > MAX_MARK_LENGTH) return false;
  return STAMP_SHAPE.test(prefix);
}
