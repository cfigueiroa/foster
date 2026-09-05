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
 * Measured on a real store: of 209 forked conversations, 111 had a branch that
 * was not the tip and had still said the last word — holding records of its own
 * that the tip never got. Calling those "stale, stopped ..." and filing them in
 * the archived view sent the reader to the fatter half and hid the half they
 * had been working in an hour earlier. Ranking by sheer recency instead would
 * be worse: one trivial turn on an abandoned half would promote it over a
 * branch holding a thousand records nobody else has.
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
