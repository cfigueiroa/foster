import { listAgentAccountDirs, pickActiveOrganization } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { readConfig } from '../store/config.js';

/**
 * The account the app currently populates its sidebar from.
 *
 * The organization is only discoverable from a directory name, so a brand-new
 * account — which has a config entry but no session directory yet — falls back to
 * the agent-mode tree the app creates before any Code session exists.
 */
export function currentAccount(
  store: StoreLayout,
  accounts: AccountRef[],
  organizationUuid?: string,
): AccountRef | undefined {
  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) return undefined;
  if (organizationUuid) return { accountUuid, organizationUuid };

  // An account can own several organizations; only one is the directory the
  // sidebar reads, and the config does not record which.
  return (
    pickActiveOrganization(
      accounts.filter((account) => account.accountUuid === accountUuid),
      store,
    ) ?? listAgentAccountDirs(store).find((account) => account.accountUuid === accountUuid)
  );
}

export function requireCurrentAccount(
  store: StoreLayout,
  accounts: AccountRef[],
  organizationUuid?: string,
): AccountRef {
  const account = currentAccount(store, accounts, organizationUuid);
  if (account) return account;

  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) {
    // Naming the store matters once profiles are in play: each one signs in
    // separately, and "open Claude Desktop once" reads as advice about the app
    // the reader already has open — which is usually the other installation.
    throw new Error(
      `No account is recorded for ${store.root}.\n` +
        'Open Claude Desktop on that installation and sign in once — each installation signs in separately.',
    );
  }
  throw new Error(
    `Found the signed-in account ${accountUuid.slice(0, 8)}, but not its organization: this account has no session directory yet.\n` +
      'Create one session in Claude Desktop so the directory exists, or pass --to-org <organizationUuid>.',
  );
}
