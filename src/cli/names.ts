import pc from 'picocolors';
import { listAccountDirs, listAgentAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { project } from '../ledger/project.js';
import { abbreviate, shortId } from './render.js';

/**
 * Abbreviations for every identifier in the store, computed once per run.
 *
 * Held here rather than threaded through a dozen signatures: it is derived from
 * the store, which does not change under a single invocation, and every screen
 * has to agree — an account that reads `9866b1e8` on one screen and `9866b1e8c4`
 * on the next is the sort of detail that makes people doubt they are looking at
 * the same thing.
 */
let names = new Map<string, string>();

export function short(id: string): string {
  return names.get(id) ?? shortId(id);
}

export function nameEverything(store: StoreLayout): void {
  const refs = [...listAccountDirs(store), ...listAgentAccountDirs(store)];
  // Accounts and organizations abbreviate independently: they are never compared
  // with each other, so a collision across the two kinds should not lengthen both.
  names = new Map([
    ...abbreviate(refs.map((ref) => ref.accountUuid)),
    ...abbreviate(refs.map((ref) => ref.organizationUuid)),
  ]);
}

export function labelsOf(ledger: Ledger): Map<string, string> {
  return project(ledger.read()).labels;
}

/** Account and organization, using a human label for the account when one exists. */
export function describeRef(labels: Map<string, string>, ref: AccountRef): string {
  return `${labels.get(ref.accountUuid) ?? short(ref.accountUuid)} ${pc.dim('/ org')} ${short(
    ref.organizationUuid,
  )}`;
}
