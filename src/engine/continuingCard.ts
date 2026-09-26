import {
  DEFAULT_DIVERGED_TEMPLATE,
  DEFAULT_OTHER_FILE_TEMPLATE,
  DEFAULT_STALE_TEMPLATE,
  looksMarked,
  stripMarks,
} from '../domain/stale.js';
import type { DiscoveredSession } from '../domain/types.js';

/**
 * Which of several cards for one conversation is the row to continue in.
 *
 * Shared by `engine/layout.ts` (group filing) and `engine/pinParity.ts`
 * (pinning) — both ask the same question, "which of this conversation's rows
 * is the one to act on", and both want the same answer: not archived, then a
 * title with no foster mark on it, then the latest `lastActivityAt`. Kept in
 * its own module, rather than exported from `layout.ts`, so neither of those
 * two engines has to import the other just to share this one function.
 */

export const DEFAULT_MARK_TEMPLATES = [
  DEFAULT_STALE_TEMPLATE,
  DEFAULT_DIVERGED_TEMPLATE,
  DEFAULT_OTHER_FILE_TEMPLATE,
];

export function isCleanTitle(title: string, templates: readonly string[]): boolean {
  return stripMarks(title, templates) === title && !looksMarked(title);
}

export function resolveContinuingCard(
  candidates: readonly DiscoveredSession[],
  templates: readonly string[] = DEFAULT_MARK_TEMPLATES,
): DiscoveredSession | undefined {
  const notArchived = candidates.filter((card) => !card.data.isArchived);
  if (notArchived.length === 0) return undefined;

  const clean = notArchived.filter((card) => isCleanTitle(card.data.title ?? '', templates));
  const pool = clean.length > 0 ? clean : notArchived;

  return pool.reduce((best, next) =>
    (next.data.lastActivityAt ?? 0) > (best.data.lastActivityAt ?? 0) ? next : best,
  );
}
