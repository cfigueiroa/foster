import pc from 'picocolors';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { listAccountDirs, samePath, storeRootOfCopy } from '../domain/paths.js';
import { continuedSince } from '../engine/continued.js';
import { fetchLiveProfile, fetchLiveUsage } from '../engine/anthropicApi.js';
import { findDuplicates } from '../engine/duplicates.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import { freshIdentityOf, overviewAccounts, type AccountOverview } from '../store/accounts.js';
import { readAccessToken } from '../store/credential.js';
import { planName, worthRecording } from '../store/identity.js';
import { scanAccount, summariseAccount } from '../store/scanner.js';
import type { Ui } from '../tui/ui.js';
import { labelsOf } from './names.js';
import {
  accountTree,
  formatDate,
  groupByAccount,
  renderAccount,
  renderRenewals,
  renderUsage,
  shortId,
} from './render.js';

export function showStatus(ui: Ui, ledger: Ledger, store: StoreLayout): void {
  const active = listActive(project(ledger.read()));
  if (active.length === 0) {
    ui.log.info('Nothing is fostered.');
    return;
  }

  // Where a copy lives is said whenever it is not here. On the ordinary
  // single-profile setup that is never, so nothing is added; the earlier rule
  // asked whether the copies were *spread* across installations, which stayed
  // silent in the one case that misleads — every copy in the other profile,
  // reading exactly like copies in this one.
  // A conversation that carried on since it was fostered is worth marking: the
  // row in the original account still shows the date it had that day, and left
  // unsaid the difference only surfaces as a scare after a return.
  const continued = new Set(continuedSince(store, active).map((c) => c.fostering.copySessionId));

  const duplicates = findDuplicates(store, active);
  if (duplicates.copies.length > 0) {
    ui.log.warn(
      `${duplicates.copies.length} of these duplicate a conversation this account already had. ` +
        '"Send them back" offers to remove just those.',
    );
  }
  if (duplicates.branches.length > 0) {
    ui.log.warn(
      `${duplicates.branches.length} of these are branches of a conversation this account already had. ` +
        'Same work, forked: each side holds turns the other never got.',
    );
  }
  if (duplicates.appMade > 0) {
    ui.log.info(
      pc.dim(
        `${duplicates.appMade} conversation(s) here have more than one card the app itself made. ` +
          'foster did not write those and will not remove them.',
      ),
    );
  }

  ui.note(
    active
      .map((f) => {
        const root = storeRootOfCopy(f.copyPath);
        const where = samePath(root, store.root) ? '' : pc.dim(`  → ${root}`);
        const carried = continued.has(f.copySessionId) ? pc.dim('  (continued since)') : '';
        return `${pc.dim(formatDate(f.fosteredAt))}  ${f.originalTitle || shortId(f.originSessionId)}${carried}${where}`;
      })
      .join('\n'),
    `${active.length} fostered`,
  );
}

export function showAccounts(ui: Ui, store: StoreLayout, ledger: Ledger, target: AccountRef): void {
  const copies = copySessionIds(ledger.read());
  const rows = listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account, copies), target.accountUuid),
  );
  ui.note(accountTree(groupByAccount(rows), labelsOf(ledger)), 'Accounts and their organizations');
}

/**
 * Who each account is, and what is being paid for it.
 *
 * The other account screen answers "what is on disk"; this one answers "whose is
 * it". They stayed separate because the second question has an honesty the first
 * does not need: a session count is true for every account, while a plan is
 * known only for accounts foster has seen you signed into, and a screen that
 * mixed the two would make a blank plan look like a free account rather than
 * like an account nobody has visited yet.
 *
 * The visit itself is what fills the list in, so this records what it read on
 * the way past — the same gate `whoami` uses, for the same reason.
 */
/**
 * Persist what a fresh read saw, gated the way `whoami` gates it: a sighting
 * left unrecorded is exactly the one the ledger cannot offer after a switch.
 */
function recordFreshIdentity(rows: AccountOverview[], ledger: Ledger): void {
  const fresh = freshIdentityOf(rows);
  const identity = fresh?.identity;
  if (
    fresh &&
    identity &&
    worthRecording(identity, project(ledger.read()).identities.get(fresh.accountUuid))
  ) {
    ledger.append({
      kind: 'account_identity_seen',
      accountUuid: fresh.accountUuid,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.plan ? { plan: identity.plan } : {}),
      ...(identity.profile ? { profile: identity.profile } : {}),
    });
  }
}

export function showIdentities(ui: Ui, store: StoreLayout, ledger: Ledger): void {
  const rows = overviewAccounts(store, ledger);
  recordFreshIdentity(rows, ledger);

  if (rows.length === 0) {
    ui.log.info('No accounts in this installation yet.');
    return;
  }

  ui.note(
    rows
      .flatMap((row, index) => (index === 0 ? renderAccount(row) : ['', ...renderAccount(row)]))
      .join('\n'),
    'Who each account is',
  );
  ui.log.info(
    pc.dim(
      'Only the account in use can be read fresh — the app caches the profile of the\n' +
        'session it is in. The rest is what foster saw on the visit that saw it.',
    ),
  );
}

/**
 * One account, in full — the dashboard cursor's "who is this?".
 *
 * The same rendering `accounts` uses for the whole list, for one row, so the
 * two screens can never drift apart on what a field means. The rows arrive
 * from the caller — the dashboard just computed them, and the scan behind
 * them reads every session file, so this screen must not run it again. Like
 * its siblings, it records the fresh identity it is about to display.
 */
export function showAccountDetails(
  ui: Ui,
  ledger: Ledger,
  rows: AccountOverview[],
  accountUuid: string,
): void {
  recordFreshIdentity(rows, ledger);
  const row = rows.find((r) => r.accountUuid === accountUuid);
  if (!row) {
    ui.log.info('That account is no longer in this installation.');
    return;
  }
  ui.note(renderAccount(row).join('\n'), row.label ?? shortId(accountUuid));
  if (!row.identity) {
    ui.log.info(
      pc.dim(
        'Plan and subscription are unknown because this account was never seen signed in\n' +
          'here. Signing into it once fills the row in permanently.',
      ),
    );
  }
}

/**
 * The one live screen: the account's usage, read from the API right now.
 *
 * Reads the credential and goes to the network — the only place in the menu that
 * does either — so it is honest about failing, and every way it fails is
 * ordinary rather than alarming.
 */
export async function showUsage(ui: Ui, store: StoreLayout): Promise<void> {
  const auth = readAccessToken(store);
  if (!auth) {
    ui.log.info(
      "No usable token for the signed-in account. This reads the app's OAuth token,\n" +
        'which works only on Windows, only for the account signed in now, and only on\n' +
        'the machine it was signed in on.',
    );
    return;
  }

  const spin = ui.spinner();
  spin.start('Asking the API');
  const [profile, usage] = await Promise.all([fetchLiveProfile(auth), fetchLiveUsage(auth)]);
  spin.stop('Read live.');

  const header: string[] = [];
  if (profile) {
    const plan = planName(profile.rateLimitTier) ?? planName(profile.organizationType);
    const who = [profile.name, profile.email].filter(Boolean).join(' · ');
    if (who) header.push(who);
    if (plan) {
      header.push(
        `${plan}${profile.rateLimitTier ? ` (${profile.rateLimitTier})` : ''} · ${profile.subscriptionStatus ?? 'unknown'}`,
      );
    }
  }

  if (!usage) {
    ui.log.info([...header, '', 'The usage endpoint did not answer.'].join('\n'));
    return;
  }
  ui.note(
    [...(header.length ? [...header, ''] : []), ...renderUsage(usage)].join('\n'),
    'Usage right now',
  );
}

/**
 * When every account resets and renews, in one place.
 *
 * The current account's usage resets are fetched live; billing dates come from
 * whatever profile foster holds for each account. Both honesties — live vs
 * remembered, and the current account's billing date being browser-only — are
 * carried in the rendering rather than explained here.
 */
export async function showRenewals(ui: Ui, store: StoreLayout, ledger: Ledger): Promise<void> {
  const rows = overviewAccounts(store, ledger);
  const auth = readAccessToken(store);

  let usage;
  if (auth) {
    const spin = ui.spinner();
    spin.start('Reading live usage');
    usage = await fetchLiveUsage(auth);
    spin.stop(usage ? 'Read live.' : 'No live usage (using stored dates only).');
  }

  ui.note(renderRenewals(rows, usage).join('\n'), 'When things renew');
  ui.log.info(
    pc.dim(
      'Usage resets are live and belong to the account in use. Billing dates are per\n' +
        'account, from the profile foster last saw — dated when not read fresh.',
    ),
  );
}
