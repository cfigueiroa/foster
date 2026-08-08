import type { StoreLayout } from '../domain/types.js';
import { listAccountDirs, listAgentAccountDirs } from '../domain/paths.js';
import { project, type KnownIdentity } from '../ledger/project.js';
import type { Ledger } from '../ledger/log.js';
import { readConfig } from './config.js';
import { readIdentityFromCache, resolveIdentity, type ResolvedIdentity } from './identity.js';
import { summarise } from './scanner.js';

/**
 * Every account on this machine with everything known about it.
 *
 * Assembled from three sources that each know a different part, because no
 * single one knows an account whole. The store's directories say which accounts
 * exist and how much is in them — that much is always true, for every account,
 * whether or not anyone has ever been signed into it here. The response cache
 * describes exactly one account, the one signed in now, and describes it
 * completely. The ledger holds what that cache said on every previous visit,
 * which is the only reason the others can be described at all.
 *
 * The consequence is worth being plain about rather than smoothing over: an
 * account foster has never seen you signed into has a session count and a
 * directory name and nothing else. It is not a gap that can be closed by reading
 * more carefully — the app never fetched that account's profile on this machine.
 * Signing into it once fills the row in permanently.
 */
export interface AccountOverview {
  accountUuid: string;
  /** Every organization directory under this account. */
  organizationUuids: string[];
  /** The name given with `label`, when one was given. */
  label?: string;
  /** True for the account the sidebar is reading right now. */
  isCurrent: boolean;
  /** Sessions written by the app, and copies foster put there. */
  sessions: number;
  copies: number;
  /** True when the account has a Cowork tree but no Code sessions — new, or only ever used there. */
  agentOnly: boolean;
  identity?: ResolvedIdentity;
  /** True when nothing here was read fresh: every field came from the ledger. */
  remembered: boolean;
  /** When the identity was last confirmed, for anything remembered. */
  seenAt?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function overviewAccounts(store: StoreLayout, ledger: Ledger): AccountOverview[] {
  const state = project(ledger.read());
  const currentAccountUuid = readConfig(store).lastKnownAccountUuid;
  const summaries = summarise(store, currentAccountUuid);

  const organizations = new Map<string, Set<string>>();
  for (const ref of listAccountDirs(store)) {
    organizations.set(
      ref.accountUuid,
      (organizations.get(ref.accountUuid) ?? new Set()).add(ref.organizationUuid),
    );
  }
  // Cowork creates an account's tree before any Code session exists, so an
  // account can be real, current and signed in while having nothing to foster.
  // Leaving it out would make the list disagree with the app on screen.
  const agentOnly = new Set<string>();
  for (const ref of listAgentAccountDirs(store)) {
    // The Cowork tree is not exclusively accounts: `skills-plugin` sits there
    // beside them with the same shape, and listing it as an account invents one
    // that nobody can sign into. Accounts are UUIDs, so that is the test.
    if (!UUID.test(ref.accountUuid)) continue;
    if (organizations.has(ref.accountUuid)) continue;
    agentOnly.add(ref.accountUuid);
    organizations.set(
      ref.accountUuid,
      (organizations.get(ref.accountUuid) ?? new Set()).add(ref.organizationUuid),
    );
  }

  const counts = new Map<string, { sessions: number; copies: number }>();
  for (const row of summaries) {
    const total = counts.get(row.account.accountUuid) ?? { sessions: 0, copies: 0 };
    total.sessions += row.nativeCount;
    total.copies += row.copyCount;
    counts.set(row.account.accountUuid, total);
  }

  const rows = [...organizations.keys()].map((accountUuid) =>
    overviewOf(store, accountUuid, {
      isCurrent: accountUuid === currentAccountUuid,
      organizationUuids: [...(organizations.get(accountUuid) ?? [])].sort(),
      counts: counts.get(accountUuid) ?? { sessions: 0, copies: 0 },
      agentOnly: agentOnly.has(accountUuid),
      known: state.identities.get(accountUuid),
      label: state.labels.get(accountUuid),
    }),
  );

  // The account in use first — it is the one being asked about most of the time
  // — then the ones foster can say something about, then the rest by size.
  return rows.sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      Number(Boolean(b.identity)) - Number(Boolean(a.identity)) ||
      b.sessions + b.copies - (a.sessions + a.copies) ||
      a.accountUuid.localeCompare(b.accountUuid),
  );
}

function overviewOf(
  store: StoreLayout,
  accountUuid: string,
  context: {
    isCurrent: boolean;
    organizationUuids: string[];
    counts: { sessions: number; copies: number };
    agentOnly: boolean;
    known: KnownIdentity | undefined;
    label: string | undefined;
  },
): AccountOverview {
  // Read fresh only for the account signed in: the response cache describes that
  // session and no other, so asking it about the rest would either answer
  // nothing or — worse — answer with the current account's profile.
  const cached = context.isCurrent ? readIdentityFromCache(store, accountUuid) : undefined;
  const identity = resolveIdentity(cached, context.known);

  return {
    accountUuid,
    organizationUuids: context.organizationUuids,
    ...(context.label ? { label: context.label } : {}),
    isCurrent: context.isCurrent,
    sessions: context.counts.sessions,
    copies: context.counts.copies,
    agentOnly: context.agentOnly,
    ...(identity ? { identity } : {}),
    remembered: Boolean(identity?.remembered),
    ...(context.known ? { seenAt: context.known.seenAt } : {}),
  };
}

/**
 * The sighting to record after an overview, when the current account said
 * something new. Returned rather than written so that a reading command stays a
 * reading command until its caller decides otherwise.
 */
export function freshIdentityOf(rows: AccountOverview[]): AccountOverview | undefined {
  return rows.find((row) => row.isCurrent && row.identity && !row.remembered);
}
