import pc from 'picocolors';
import { bareSessionId } from '../domain/naming.js';
import type { Outcome, OutcomeStatus } from '../engine/executor.js';
import type { DiscoveredSession } from '../domain/types.js';
import type { UpdateStatus } from '../update.js';
import { VERSION } from '../version.js';

export function formatDate(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

export function shortId(id: string): string {
  return bareSessionId(id).slice(0, 8);
}

/**
 * Renders accounts with their organizations nested underneath.
 *
 * The store nests them — <accountUuid>/<organizationUuid>/ — and showing both at
 * the same indentation invites exactly the wrong reading: that an account with
 * two organizations is two accounts, or that the first identifier is the
 * organization. The tree makes the containment visible, and the account total
 * makes it clear that picking an account takes every organization inside it.
 */
export function accountTree(
  groups: AccountGroup[],
  labels: Map<string, string> = new Map(),
): string {
  const lines: string[] = [];

  for (const group of groups) {
    const label = labels.get(group.accountUuid);
    const name = label
      ? `${label} ${pc.dim(shortId(group.accountUuid))}`
      : shortId(group.accountUuid);
    const total = group.organizations.reduce((sum, org) => sum + org.nativeCount, 0);
    const plural = group.organizations.length === 1 ? 'organization' : 'organizations';

    lines.push(
      `${pc.bold(name)}${group.isCurrent ? pc.green('  (this account)') : ''}` +
        pc.dim(`  ${total} session(s) in ${group.organizations.length} ${plural}`),
    );

    group.organizations.forEach((org, index) => {
      const last = index === group.organizations.length - 1;
      const fostered = org.copyCount > 0 ? pc.cyan(`, ${org.copyCount} fostered in`) : '';
      lines.push(
        pc.dim(`  ${last ? '└' : '├'} org `) +
          shortId(org.organizationUuid) +
          pc.dim(`  ${org.nativeCount} own`) +
          fostered,
      );
    });
  }

  return lines.join('\n');
}

export interface AccountGroup {
  accountUuid: string;
  isCurrent: boolean;
  organizations: { organizationUuid: string; nativeCount: number; copyCount: number }[];
}

/** Collapses per-organization rows into one entry per account, preserving order. */
export function groupByAccount(
  rows: {
    account: { accountUuid: string; organizationUuid: string };
    nativeCount: number;
    copyCount: number;
    isCurrent: boolean;
  }[],
): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();

  for (const row of rows) {
    let group = groups.get(row.account.accountUuid);
    if (!group) {
      group = { accountUuid: row.account.accountUuid, isCurrent: row.isCurrent, organizations: [] };
      groups.set(row.account.accountUuid, group);
    }
    group.organizations.push({
      organizationUuid: row.account.organizationUuid,
      nativeCount: row.nativeCount,
      copyCount: row.copyCount,
    });
  }

  return [...groups.values()];
}

/**
 * One line describing the installed version, and the upgrade when there is one.
 *
 * An unknown answer is reported as unknown rather than as "up to date": the check
 * is best-effort, and claiming currency on a failed request would be a lie the
 * user cannot see through.
 */
export function updateLine(status: UpdateStatus | undefined): string {
  if (!status) return `version ${VERSION} ${pc.dim('(latest release unknown)')}`;
  if (!status.outdated) return `version ${status.current} ${pc.green('(latest)')}`;
  return (
    `version ${status.current} ${pc.yellow(`— ${status.latest} is available`)}\n` +
    `  ${pc.dim(status.command)}`
  );
}

export function sessionLine(session: DiscoveredSession): string {
  const date = formatDate(session.data.lastActivityAt ?? session.data.createdAt);
  const title = session.data.title ?? '(untitled)';
  const note = session.reasons.length > 0 ? pc.yellow(` [${session.reasons.join(', ')}]`) : '';
  return `  ${pc.dim(date)}  ${title}${note}`;
}

export function outcomeLine(outcome: Outcome): string {
  const marks: Record<OutcomeStatus, string> = {
    fostered: pc.green('+'),
    returned: pc.green('-'),
    skipped: pc.dim('·'),
    failed: pc.red('x'),
  };
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${marks[outcome.status]} ${outcome.title}${detail}`;
}

/** Reminds the user that the sidebar is only rebuilt when the app starts. */
export function restartNotice(): string {
  return pc.dim('Restart Claude Desktop to see the change — the sidebar is built at startup.');
}
