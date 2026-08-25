import { samePath, storeRootOfCopy } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { inspectApp } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import { overviewAccounts, type AccountOverview } from '../store/accounts.js';
import { canIdentify } from '../engine/identify.js';
import { VERSION } from '../version.js';
import type { Dashboard, DashboardAccount } from '../tui/ui.js';
import { formatDate, shortId } from './render.js';

/**
 * What the home screen needs: counts and labels. Transcript walks and the
 * usage API belong to /status and /usage — they are too expensive (and too
 * honest-about-staleness) to run every time the menu comes back.
 */
export function buildDashboard(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
  // The caller can hand over rows it already computed — the scan behind them
  // reads every session file, so running it twice per screen is real money.
  rows: AccountOverview[] = overviewAccounts(store, ledger),
): Dashboard {
  const labels = project(ledger.read()).labels;
  const active = listActive(project(ledger.read()));
  // Whether the API path has anything to offer is a single machine-wide fact
  // (does foster hold a live credential at all), computed once, not per row.
  const identifiable = canIdentify(store);
  const app = inspectApp(store);
  const signedLabel = labels.get(target.accountUuid) ?? shortId(target.accountUuid);

  const accounts: DashboardAccount[] = rows.map((row) => ({
    accountUuid: row.accountUuid,
    shortId: shortId(row.accountUuid),
    ...(row.label ? { label: row.label } : {}),
    // The identity's own name, so an account foster has seen signed in never
    // shows as a bare uuid just because nobody gave it a label yet.
    ...(row.identity?.name || row.identity?.email
      ? { identityName: row.identity.name ?? row.identity.email }
      : {}),
    // Offer the API path only where it could help: no identity yet, and foster
    // holds a live credential to ask with.
    ...(!row.identity && identifiable ? { canIdentify: true } : {}),
    isCurrent: row.isCurrent,
    ...(row.identity?.plan ? { plan: row.identity.plan } : {}),
    ...(row.identity?.profile?.subscriptionStatus
      ? {
          subscription: row.identity.profile.subscriptionStatus,
          // A remembered status is only as fresh as the visit that saw it —
          // dated here so the dashboard cannot assert it as current truth.
          ...(row.remembered && row.seenAt ? { subscriptionAsOf: formatDate(row.seenAt) } : {}),
        }
      : {}),
    sessions: row.sessions,
    copies: row.copies,
    paymentNeedsAuth: row.identity?.profile?.paymentNeedsAuth === true,
  }));

  return {
    version: VERSION,
    store: store.root,
    signedIn: signedLabel,
    appRunning: app.running,
    accounts,
    fostered: active.map((item) => {
      const root = storeRootOfCopy(item.copyPath);
      const elsewhere = samePath(root, store.root) ? undefined : root;
      return {
        title: item.originalTitle || shortId(item.originSessionId),
        date: formatDate(item.fosteredAt),
        ...(elsewhere ? { elsewhere } : {}),
      };
    }),
  };
}
