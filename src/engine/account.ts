import { uniquePrefix } from '../domain/prefix.js';
import { listAgentAccountDirs, pickActiveOrganization } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { readConfig } from '../store/config.js';

/**
 * Resolves an account identifier that may be an abbreviated prefix, the way the
 * `--to` and `--from` flags do, so `foster label <prefix> "name"` records the
 * name against the account the prefix names rather than against the prefix
 * itself. A prefix matching exactly one account on disk becomes that account's
 * full UUID; an ambiguous prefix is refused rather than guessed at. An id that
 * matches nothing here is returned untouched: `label` can name an account that
 * is not present on this machine — an old one, or another machine's — which is
 * the `foster label 00000000 "…"` case, and there is nothing to resolve it to.
 */
function resolveAccountPrefix(id: string, accountUuids: string[]): string {
  const result = uniquePrefix(accountUuids, id, (uuid) => uuid);
  if (result.kind === 'ambiguous') {
    throw new Error(
      `"${id}" is ambiguous: it matches ${result.ids.length} accounts.\n` +
        result.ids.map((uuid) => `  ${uuid}`).join('\n'),
    );
  }
  return result.kind === 'one' ? result.id : id;
}

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
  env: NodeJS.ProcessEnv = process.env,
): AccountRef | undefined {
  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) return undefined;
  if (organizationUuid) return { accountUuid, organizationUuid };

  const candidates = accounts.filter((account) => account.accountUuid === accountUuid);
  // The app sets this from the organization it is actually using, so it beats
  // guessing — but only for a directory that exists, so a stale value cannot
  // point the copies at nothing.
  const fromEnv = env.CLAUDE_CODE_ORGANIZATION_UUID;
  const declared = fromEnv && candidates.find((account) => account.organizationUuid === fromEnv);
  if (declared) return declared;

  // An account can own several organizations; only one is the directory the
  // sidebar reads, and the config does not record which.
  return (
    pickActiveOrganization(candidates, store) ??
    listAgentAccountDirs(store).find((account) => account.accountUuid === accountUuid)
  );
}

/**
 * Which account a `label` call is about, and what to call it.
 *
 * The identifier is redundant in the case that comes up most: you are looking at
 * the app, which shows the account's email under your avatar, and foster already
 * knows which account the sidebar is reading. Requiring the UUID anyway made the
 * one thing foster cannot learn for itself — the pairing between that email and
 * that directory name — cost a copy-paste every time.
 *
 * So a single argument is the name, applied to the account in use. An identifier
 * given alone is refused rather than taken as a name: `foster label 00000000`
 * reads as an intention to name *that* account, and silently recording "00000000"
 * as the name of a different one is the wrong way to be wrong.
 */
export function resolveLabelArgs(
  first: string | undefined,
  second: string | undefined,
  accountUuids: string[],
  currentAccountUuid: string | undefined,
): { accountUuid: string; label: string } {
  if (first !== undefined && second !== undefined) {
    return { accountUuid: resolveAccountPrefix(first, accountUuids), label: second };
  }

  if (first === undefined) {
    throw new Error(
      'Nothing to record. Give the name:\n' +
        '  foster label "work"                     names the account you are signed into\n' +
        '  foster label <accountUuid> "work"       names another account',
    );
  }

  // Four characters is where a prefix stops being a plausible name and starts
  // being an abbreviation of an identifier, which is the length the other flags
  // accept too.
  const looksLikeId =
    first.length >= 4 && accountUuids.some((uuid) => uuid.startsWith(first.toLowerCase()));
  if (looksLikeId) {
    throw new Error(
      `"${first}" is an account id, not a name. Say what to call it:\n` +
        `  foster label ${first} "work"\n` +
        'Or, to name the account you are signed into:\n' +
        '  foster label "work"',
    );
  }

  if (!currentAccountUuid) {
    throw new Error(
      `No account is recorded as signed in, so there is nothing for "${first}" to name.\n` +
        'Open Claude Desktop once, or name the account outright: foster label <accountUuid> "…".',
    );
  }

  return { accountUuid: currentAccountUuid, label: first };
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
