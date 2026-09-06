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

/**
 * The name each account goes by, for anything that prints one.
 *
 * Two sources, and the order between them is the whole point. A label is
 * something a person sat down and chose, so it wins. Failing that, the e-mail
 * the API answered with is a far better name than eight hex digits — it was
 * already in the ledger, and every screen was throwing it away and printing the
 * uuid instead.
 */
export function labelsOf(ledger: Ledger): Map<string, string> {
  const state = project(ledger.read());
  const names = new Map<string, string>();
  for (const [accountUuid, identity] of state.identities) {
    const seen = identity.email ?? identity.name;
    if (seen) names.set(accountUuid, seen);
  }
  for (const [accountUuid, label] of state.labels) names.set(accountUuid, label);
  return names;
}

/**
 * Only the labels a person gave, for the two places where that distinction is
 * the subject: the prompt that offers to change one, and the `label` field in
 * JSON output, which promises what was named rather than what is known.
 */
export function manualLabelsOf(ledger: Ledger): Map<string, string> {
  return project(ledger.read()).labels;
}

/** Account and organization, using a human label for the account when one exists. */
export function describeRef(labels: Map<string, string>, ref: AccountRef): string {
  return `${labels.get(ref.accountUuid) ?? short(ref.accountUuid)} ${pc.dim('/ org')} ${short(
    ref.organizationUuid,
  )}`;
}
