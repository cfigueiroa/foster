import { selectByKey } from '../domain/filter.js';
import { samePath, storeRootOfCopy } from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import { findDuplicates } from '../engine/duplicates.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project, selectByTarget } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';

/**
 * The ledger spans every installation foster has written into. Acting in one
 * store must not quietly reach into another.
 */
export function partitionByStore(
  active: ActiveFostering[],
  store: StoreLayout,
): { here: ActiveFostering[]; elsewhere: ActiveFostering[] } {
  const here: ActiveFostering[] = [];
  const elsewhere: ActiveFostering[] = [];
  for (const fostering of active) {
    if (samePath(storeRootOfCopy(fostering.copyPath), store.root)) here.push(fostering);
    else elsewhere.push(fostering);
  }
  return { here, elsewhere };
}

export function inThisStore(fostering: ActiveFostering, store: StoreLayout): boolean {
  return samePath(storeRootOfCopy(fostering.copyPath), store.root);
}

export interface ReturnSelection {
  selected: ActiveFostering[];
  elsewhere: number;
}

/**
 * Which copies a return (or a status scoped the same way) is about.
 *
 * One function, so the CLI, the menu and the agent cannot disagree on what
 * `--all-stores`, `--duplicates`, `--branches` or a session prefix mean. A
 * session id that matches nothing is an error rather than an empty list: a typo
 * used to print "Nothing is fostered."
 */
export function selectReturnTargets(
  store: StoreLayout,
  ledger: Ledger,
  opts: {
    allStores?: boolean;
    to?: string;
    toOrg?: string;
    duplicates?: boolean;
    branches?: boolean;
    title?: string;
    sessionIds?: string[];
  } = {},
): ReturnSelection {
  const everything = listActive(project(ledger.read()));
  const { here, elsewhere } = opts.allStores
    ? { here: everything, elsewhere: [] as ActiveFostering[] }
    : partitionByStore(everything, store);

  let selected = here;

  if (opts.to !== undefined || opts.toOrg !== undefined) {
    selected = selectByTarget(selected, opts.to, opts.toOrg);
  }

  if (opts.duplicates || opts.branches) {
    const report = findDuplicates(store, selected);
    const wanted = new Set(
      [...(opts.duplicates ? report.copies : []), ...(opts.branches ? report.branches : [])].map(
        (f) => f.copySessionId,
      ),
    );
    selected = selected.filter((f) => wanted.has(f.copySessionId));
  }

  if (opts.title) {
    const needle = opts.title.toLowerCase();
    selected = selected.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(needle));
  }

  if (opts.sessionIds?.length) {
    const { selected: hits, unmatched } = selectByKey(
      selected,
      opts.sessionIds,
      (f) => f.originSessionId,
      (f) => f.copySessionId,
    );
    if (unmatched.length > 0) {
      throw new Error(`No fostered copy matches ${unmatched.join(', ')}.`);
    }
    selected = hits;
  }

  return { selected, elsewhere: elsewhere.length };
}
