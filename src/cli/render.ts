import pc from 'picocolors';
import { bareSessionId } from '../domain/naming.js';
import type { Outcome, OutcomeStatus } from '../engine/executor.js';
import type { BranchStanding } from '../engine/sidebar.js';
import type { PurgeOutcome, PurgeStatus } from '../engine/purge.js';
import type { DiscoveredSession, Unfosterable } from '../domain/types.js';
import type { NeverComes, SweepReport } from '../ops/sweep.js';
import type { AccountOverview } from '../store/accounts.js';
import type { AccountProfile } from '../store/profile.js';
import type { UsageReport } from '../engine/anthropicApi.js';
import type { UpdateStatus } from '../update.js';
import { VERSION } from '../version.js';

export function formatDate(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

export function shortId(id: string): string {
  return bareSessionId(id).slice(0, SHORT_ID_LENGTH);
}

/**
 * One account, printed as everything foster knows about it.
 *
 * Laid out as labelled lines rather than a table because the rows are ragged by
 * nature: the account in use can fill every field, an account visited once fills
 * the ones its profile carried, and an account never signed into here fills
 * none. A table of those is mostly empty columns, and empty columns read as
 * missing data rather than as data that was never on this machine.
 */
export function renderAccount(row: AccountOverview): string[] {
  const identity = row.identity;
  const profile = identity?.profile;
  const lines: string[] = [];

  const title = [
    pc.bold(shortId(row.accountUuid)),
    row.label ? pc.cyan(`"${row.label}"`) : undefined,
    row.isCurrent ? pc.green('(in use)') : undefined,
  ].filter(Boolean);
  lines.push(title.join(' '));

  // Dated on the line itself, not only in a footnote underneath. A subscription
  // is the fastest-moving thing on this screen and the one it is most expensive
  // to be wrong about: a plan cancelled last month still reads "active" here,
  // because that is what it was on the day foster looked. A note at the bottom
  // of the block was not enough — the eye takes "active" and moves on.
  const asOf = row.remembered ? pc.dim(` (as of ${formatDate(row.seenAt)})`) : '';

  const who = [identity?.name, identity?.email].filter(Boolean).join(' · ');
  if (who) lines.push(`  who          ${who}`);
  if (identity?.plan)
    lines.push(`  plan         ${pc.bold(identity.plan)}${rawTier(profile)}${asOf}`);
  if (profile?.subscriptionStatus || profile?.planEndingAt) {
    lines.push(`  subscription ${subscriptionLine(profile)}${asOf}`);
  }
  if (profile?.nextChargeDate) {
    lines.push(
      `  next charge  ${profile.nextChargeDate}${profile.billingInterval ? pc.dim(` (${profile.billingInterval})`) : ''}${asOf}`,
    );
  }
  if (profile?.cardLast4) {
    lines.push(
      `  card         ${[profile.cardBrand, `••••${profile.cardLast4}`].filter(Boolean).join(' ')}${profile.currency ? pc.dim(` · ${profile.currency}`) : ''}${asOf}`,
    );
  }
  if (profile?.subscriptionCreatedAt) {
    lines.push(`  since        ${profile.subscriptionCreatedAt.slice(0, 10)}`);
  }
  if (profile?.createdAt) lines.push(`  account made ${profile.createdAt.slice(0, 10)}`);
  if (profile?.organizationName || profile?.organizationType) {
    lines.push(
      `  organization ${[profile.organizationName, profile.organizationType].filter(Boolean).join(pc.dim(' · '))}`,
    );
  }
  if (profile?.hasExtraUsage) lines.push(`  extra usage  ${pc.bold('on')}`);
  if (profile?.paymentNeedsAuth) {
    lines.push(`  ${pc.yellow('payment      waiting for you to authorise a charge')}`);
  }

  lines.push(
    `  on disk      ${row.sessions} session(s)` +
      (row.copies > 0 ? `, ${row.copies} fostered copy(s)` : '') +
      pc.dim(
        ` · ${row.organizationUuids.length} organization(s)${row.agentOnly ? ' · Cowork only' : ''}`,
      ),
  );

  if (!identity) {
    lines.push(
      pc.dim(
        row.isCurrent
          ? '  nothing cached for this account yet — open the app once and run this again'
          : '  never seen signed in on this machine — sign into it once and this fills in',
      ),
    );
  } else if (row.remembered) {
    lines.push(
      pc.dim(
        `  remembered from ${formatDate(row.seenAt)}, not read fresh — sign into it to confirm,\n` +
          `  or foster label ${row.accountUuid} --forget to drop it`,
      ),
    );
  }

  return lines;
}

/** The raw tier beside the friendly name, since it is the thing that proves the size. */
function rawTier(profile: AccountProfile | undefined): string {
  return profile?.rateLimitTier ? pc.dim(`  (${profile.rateLimitTier})`) : '';
}

/**
 * The live usage windows, drawn the way the app draws them — a bar, a percent,
 * and when the window resets.
 *
 * This is the one screen whose data is genuinely current rather than remembered,
 * so it says so with the time it was read: a usage number is stale within
 * minutes, and a figure with no timestamp invites being trusted longer than it
 * should.
 */
export function renderUsage(report: UsageReport, now: number = Date.now()): string[] {
  const lines: string[] = [];
  const width = Math.max(...report.windows.map((w) => w.label.length), 0);

  for (const window of report.windows) {
    const label = window.label.padEnd(width);
    const bar = usageBar(window.percent, window.severity);
    const resets = window.resetsAt ? pc.dim(`  resets ${untilWhen(window.resetsAt, now)}`) : '';
    lines.push(`  ${label}  ${bar} ${String(window.percent).padStart(3)}%${resets}`);
  }
  if (report.windows.length === 0) lines.push(pc.dim('  no usage windows reported'));
  if (report.extraUsageEnabled) lines.push(pc.dim('  extra usage is on'));
  lines.push(
    pc.dim(`  read live ${formatDate(report.retrievedAt)}, ${clockOf(report.retrievedAt)}`),
  );
  return lines;
}

/**
 * A dates-first view across every account: when each usage window resets, when
 * the next bill lands, when a cancelled plan ends.
 *
 * It draws the same honesty line the rest of the tool does, in the layout: usage
 * resets are live and belong to the account in use, so they appear only there
 * and only when the API answered; billing dates are per-account and come from
 * whatever profile foster has, dated when that was not read fresh. An account
 * with no dates at all says so, rather than showing an empty block that reads
 * like a bug.
 */
export function renderRenewals(
  rows: AccountOverview[],
  usage: UsageReport | undefined,
  now: number = Date.now(),
): string[] {
  const lines: string[] = [];

  for (const row of rows) {
    const profile = row.identity?.profile;
    const asOf = row.remembered ? pc.dim(` (as of ${formatDate(row.seenAt)})`) : '';
    const block: string[] = [];

    // Usage resets: live, current account only.
    if (row.isCurrent && usage) {
      for (const window of usage.windows) {
        if (!window.resetsAt) continue;
        block.push(
          `  ${window.label.padEnd(20)} resets ${untilWhen(window.resetsAt, now)} ${pc.dim('[live]')}`,
        );
      }
    }

    // Billing dates: from the profile, fresh or remembered.
    if (profile?.planEndingAt) {
      block.push(
        `  ${'plan ends'.padEnd(20)} ${pc.yellow(profile.planEndingAt.slice(0, 10))} — will not renew${asOf}`,
      );
    } else if (profile?.nextChargeDate) {
      block.push(
        `  ${'next charge'.padEnd(20)} ${profile.nextChargeDate}${profile.billingInterval ? pc.dim(` (${profile.billingInterval})`) : ''}${asOf}`,
      );
    } else if (row.isCurrent && profile?.subscriptionStatus === 'active') {
      // The current account's billing date is the one gap the API cannot fill —
      // it lives only on the web origin, behind the challenge — so say why rather
      // than leave a blank that looks like missing data.
      block.push(
        `  ${'next charge'.padEnd(20)} ${pc.dim('not readable here — see the app’s billing screen')}`,
      );
    }

    if (profile?.subscriptionStatus && !profile.planEndingAt) {
      const status = profile.subscriptionStatus;
      block.push(
        `  ${'subscription'.padEnd(20)} ${status === 'active' ? pc.green(status) : pc.yellow(status)}${asOf}`,
      );
    }

    if (block.length === 0) continue; // nothing time-related known; skip quietly

    const title = [
      pc.bold(shortId(row.accountUuid)),
      row.label ? pc.cyan(`"${row.label}"`) : identityName(row),
      row.isCurrent ? pc.green('(in use)') : undefined,
    ].filter(Boolean);
    lines.push('', title.join(' '), ...block);
  }

  if (lines.length === 0) {
    lines.push(
      pc.dim('No renewal or reset dates are known yet. Open an account and run this again.'),
    );
  }
  return lines.slice(lines[0] === '' ? 1 : 0);
}

/** The name/email to title a renewals block with, when there is no label. */
function identityName(row: AccountOverview): string | undefined {
  const who = [row.identity?.name, row.identity?.email].filter(Boolean).join(' · ');
  return who || undefined;
}

/** A ten-cell bar, coloured by how close to the limit it is. */
function usageBar(percent: number, severity: string | undefined): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const critical = severity === 'exceeded_limit' || percent >= 100;
  const near = severity === 'approaching_limit' || percent >= 80;
  return critical ? pc.red(bar) : near ? pc.yellow(bar) : pc.green(bar);
}

/**
 * How long until a reset, in words, with the clock time in parentheses.
 *
 * "resets in 1h 16m (18:50)" is what the app shows and what someone waiting on a
 * limit actually wants; a bare ISO timestamp makes them do the subtraction.
 */
export function untilWhen(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return `now (${clockOf(at)})`;
  const when = clockOf(at);
  if (minutes < 60) return `in ${minutes}m (${when})`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (minutes < 1440) return `in ${hours}h ${rest}m (${when})`;
  const days = Math.round(minutes / 1440);
  return `in ${days}d (${formatDate(at)})`;
}

/** Local clock time, HH:MM. */
function clockOf(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Active, cancelling, or whatever the API called it.
 *
 * "active" alone is not the whole answer and saying it as though it were would
 * mislead in the one direction that costs money: a subscription set to cancel
 * stays active until the period ends, and the only thing that distinguishes the
 * two is an end date sitting beside the same word.
 */
function subscriptionLine(profile: AccountProfile): string {
  const status = profile.subscriptionStatus ?? 'unknown';
  if (profile.planEndingAt) {
    return pc.yellow(`${status} — ends ${profile.planEndingAt.slice(0, 10)}, will not renew`);
  }
  return status === 'active' ? pc.green(status) : pc.yellow(status);
}

const SHORT_ID_LENGTH = 8;

/**
 * Short forms that stay distinct from each other.
 *
 * Eight characters is enough to recognise a UUID and short enough to read, but
 * not enough to guarantee uniqueness — and two directories printed with the same
 * name is worse than a long name, because it looks like the tool is repeating
 * itself. This lengthens the abbreviation only as far as it has to, and only for
 * the identifiers being shown together.
 */
export function abbreviate(ids: Iterable<string>): Map<string, string> {
  const distinct = [...new Set([...ids].map(bareSessionId))];
  const longest = distinct.reduce((max, id) => Math.max(max, id.length), 0);

  let length = SHORT_ID_LENGTH;
  while (
    length < longest &&
    new Set(distinct.map((id) => id.slice(0, length))).size < distinct.length
  ) {
    length += 4;
  }

  return new Map(distinct.map((id) => [id, id.slice(0, length)]));
}

/**
 * How long ago, in words.
 *
 * Account identifiers are opaque, and "last used 7 months ago" is often the only
 * thing that tells someone which of two UUIDs is the account they left behind.
 * An exact date does not do that nearly as well.
 */
export function formatAge(ms: number | undefined, now: number = Date.now()): string {
  if (!ms) return 'never used';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
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
  // Abbreviated so no two rows can print the same name for different
  // directories. Accounts and organizations are abbreviated apart: they are never
  // compared with each other, so a collision between the two kinds is not a
  // reason to make every identifier on the screen longer.
  const names = new Map([
    ...abbreviate(groups.map((group) => group.accountUuid)),
    ...abbreviate(groups.flatMap((g) => g.organizations.map((org) => org.organizationUuid))),
  ]);
  const short = (id: string) => names.get(id) ?? shortId(id);

  for (const group of groups) {
    const label = labels.get(group.accountUuid);
    const name = label ? `${label} ${pc.dim(short(group.accountUuid))}` : short(group.accountUuid);
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
          short(org.organizationUuid) +
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

/**
 * Sizes as a person reads them.
 *
 * Shown because it is the only honest measure of what a purge destroys: a title
 * says which conversation, and the byte count says how much of it there was.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  // Carried on the rounded number rather than the exact one. 1023.999 KB fails a
  // plain `value >= 1024` test and then rounds up on the way to the screen, so a
  // byte short of a megabyte printed as "1024 KB".
  while (displayed(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The number the reader will actually see, which is what has to stay under 1024. */
function displayed(value: number): number {
  return value < 10 ? Number(value.toFixed(1)) : Math.round(value);
}

export function purgeLine(outcome: PurgeOutcome, dryRun: boolean): string {
  const marks: Record<PurgeStatus, string> = {
    // Not the green of the other commands: nothing here is being added, and a
    // list of green ticks is the wrong thing to feel while reading it.
    purged: dryRun ? pc.red('×') : pc.red('✕'),
    skipped: pc.dim('·'),
    failed: pc.yellow('!'),
  };
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  // Keyed on what went, not on the status: a purge that threw part-way through a
  // mirrored transcript still destroyed something, and the line has to say so.
  const size = outcome.files > 0 ? pc.dim(`  ${formatBytes(outcome.bytes)}`) : '';
  return `  ${marks[outcome.status]} ${outcome.title}${size}${detail}`;
}

export function outcomeLine(outcome: Outcome, options: { restoring?: boolean } = {}): string {
  const marks: Record<OutcomeStatus, string> = {
    fostered: pc.green('+'),
    returned: pc.green('-'),
    skipped: pc.dim('·'),
    failed: pc.red('x'),
  };
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  const line = `  ${marks[outcome.status]} ${outcome.title}${detail}`;
  const standing = outcome.standing
    ? standingLine(outcome.standing, options.restoring === true, outcome.originSessionId)
    : '';
  return standing ? `${line}\n${standing}` : line;
}

/**
 * What refusing the second row costs, when it costs anything.
 *
 * Only printed for the half the account is *behind*. A sweep offering the branch
 * that stopped is right to skip it and has nothing to add, and a line under every
 * refusal would bury the handful that matter — one store had eight forks among
 * five hundred conversations.
 *
 * The way out is not the same on both routes, and printing one of them everywhere
 * was worse than printing nothing. `consolidate` merges two *cards*; it builds
 * its forks from what is on disk. On a sweep both halves are cards in different
 * accounts, so it is exactly the right command. On a restore the other half is a
 * conversation the app deleted — no card, nothing for consolidate to find — and
 * the suggestion answered "Nothing is forked here", with the records it named
 * still out of reach. There the first move is to give that half a card of its
 * own, which naming it in a restore now does.
 */
function standingLine(standing: BranchStanding, restoring: boolean, originId: string): string {
  if (!standing.ahead) return '';
  return [
    pc.yellow(
      `      the row here holds ${standing.hereOnly} record(s) this one does not; ` +
        `this one holds ${standing.theirOnly} it does not`,
    ),
    pc.dim(
      restoring
        ? `      foster restore --session ${shortId(originId)} --yes, then foster consolidate`
        : `      foster consolidate --session ${shortId(standing.here)} --yes`,
    ),
  ].join('\n');
}

/**
 * The lines a sweep ends on, shared by the command and the menu so both say the
 * same thing about the same run.
 *
 * Ordered by what the reader has to act on: whether it is finished, where the
 * copies landed, what will never come, and only then the things that are somebody
 * else's decision.
 */
export function sweepSummary(report: SweepReport): string[] {
  const lines: string[] = [];
  const { fostered, restored } = report;

  lines.push(
    report.dryRun
      ? pc.bold(
          `Dry run: ${fostered.counts.fostered} would be fostered, ${restored.counts.fostered} restored.`,
        )
      : pc.bold(
          `${fostered.counts.fostered} fostered, ${restored.counts.fostered} restored, ` +
            `${fostered.counts.skipped + restored.counts.skipped} skipped, ` +
            `${fostered.counts.failed + restored.counts.failed} failed.`,
        ),
  );

  // Said whenever any copy carries the flag, because the archived view is where
  // they land and Recents is where people look. A run that brought a hundred
  // sessions and appears to have brought none is this sentence going unsaid.
  if (report.archived > 0) {
    const one = report.archived === 1;
    lines.push(
      `${report.archived} of them ${one ? 'was archived and stays' : 'were archived and stay'} archived — ` +
        `${one ? 'it is' : 'they are'} in the app's archived view, not in Recents.`,
    );
  }

  const confirmation = report.confirmation;
  if (confirmation) {
    lines.push(
      confirmation.exhausted
        ? pc.green('Nothing is left to sweep: a second run would foster 0 and restore 0.')
        : pc.yellow(
            `Not finished: ${confirmation.fosterable} still to foster, ` +
              `${confirmation.restorable} still to restore. Run it again.`,
          ),
    );
  }

  const never = neverComesLine(report.neverComes);
  if (never) lines.push(pc.dim(never));

  if (report.forks > 0) {
    const one = report.forks === 1;
    lines.push(
      pc.yellow(
        `${report.forks} ${one ? 'session is' : 'sessions are'} the half of a fork that carried on; ` +
          `this account is showing the half that stopped.\n` +
          'Which half survives is a reading decision, so the sweep stops here: ' +
          'foster consolidate lists them, and needs the app closed.',
      ),
    );
  }

  if (report.liveWriters.length > 0) {
    const one = report.liveWriters.length === 1;
    lines.push(
      pc.yellow(
        `${report.liveWriters.length} of the conversations ${one ? 'has' : 'have'} a live writer. ` +
          `Opening the ${one ? 'copy' : 'copies'} branches the conversation instead of continuing it, ` +
          'so finish there first — foster live names the process and its directory.',
      ),
    );
  }

  return lines;
}

/**
 * What no sweep can bring, in one line.
 *
 * Empty when there is nothing to say: a run with no gap should not print a
 * sentence about a gap.
 */
export function neverComesLine(never: NeverComes): string {
  if (never.total === 0) return '';
  const names: Record<Unfosterable, string> = {
    'scheduled-task': 'scheduled task',
    'never-opened': 'never opened',
    'too-large': "over the app's size limit",
    archived: 'archived',
    'already-a-copy': 'already a copy',
  };
  const detail = Object.entries(never.byReason)
    .map(([reason, count]) => `${count} ${names[reason as Unfosterable]}`)
    .join(', ');
  const one = never.total === 1;
  const scheduledOnly = never.byReason['scheduled-task'] ?? 0;
  // "Can never come" stopped being true of scheduled tasks the moment there was a
  // flag for them, and a sentence that overstates the gap is as misleading as one
  // that hides it. Said plainly instead when any of the count has a way out.
  const line =
    scheduledOnly > 0
      ? `${never.total} session${one ? '' : 's'} this sweep does not bring (${detail}).`
      : `${never.total} session${one ? '' : 's'} can never come (${detail}) — the app would not list ${one ? 'it' : 'them'}.`;
  // Scheduled tasks are the one entry here that has an answer. What the app
  // refuses to list is the card, not the conversation, so a copy without the task
  // id is an ordinary row — and leaving the count under a flat "never" sent
  // people looking for a gap that a flag closes.
  const scheduled = never.byReason['scheduled-task'] ?? 0;
  return scheduled > 0
    ? `${line}\nThe scheduled ${scheduled === 1 ? 'one is' : 'ones are'} reachable as ordinary conversations: foster --include-scheduled.`
    : line;
}
