import pc from 'picocolors';
import { bareSessionId } from '../domain/naming.js';
import { describeUnfosterable } from '../domain/fostering.js';
import { formatStamp } from '../domain/stale.js';
import { UNKNOWN_MARK_DETAIL, type ForkOutcome } from '../engine/branchCards.js';
import type { FilePlan } from '../engine/fileCards.js';
import type { Outcome, OutcomeStatus } from '../engine/executor.js';
import type { RetitleOutcome } from '../engine/retitle.js';
import type { DateOutcome, DatePlanItem } from '../engine/dates.js';
import type { UnclaimItem, UnclaimOutcome } from '../engine/unclaim.js';
import type { BranchStanding } from '../engine/sidebar.js';
import type { PurgeOutcome, PurgeStatus } from '../engine/purge.js';
import type { AccountRef, DiscoveredSession, Unfosterable } from '../domain/types.js';
import type { NeverComes, SweepReport } from '../ops/sweep.js';
import type { ProveReport } from '../ops/prove.js';
import {
  LayoutWriteError,
  totalLayoutPending,
  type ApplyLayoutResult,
  type LayoutPendingCounts,
  type LayoutPlan,
} from '../engine/layout.js';
import type { ViewState } from '../engine/view.js';
import type { LayoutGroupsCheck } from '../engine/layoutVerify.js';
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
 * A one-shot routine's `fireAt`, in `formatStamp`'s own `DD/MM HH:MM` shape
 * with the year spliced in after the month when `fireAt` falls outside the
 * machine's current year.
 *
 * `formatStamp` is deliberately short for a stale mark, which sits only days
 * from `now` — but a routine's own moment can be more than a year off in
 * either direction (brought back from an account that has sat untouched, or
 * scheduled well into the future), and `01/07 09:00` printed in September
 * does not say which July. Reuses `formatStamp` rather than reimplementing
 * its two-digit padding, so the two stay in step if that shape ever changes.
 */
export function formatRoutineFireAt(ms: number | undefined, now: Date = new Date()): string {
  const stamp = formatStamp(ms);
  if (ms === undefined || !Number.isFinite(ms)) return stamp;
  const year = new Date(ms).getFullYear();
  if (year === now.getFullYear()) return stamp;
  const [datePart, timePart] = stamp.split(' ');
  return `${datePart}/${year} ${timePart}`;
}

/**
 * `foster view copy`'s own restart-command advice, named by the two accounts
 * this run actually resolved rather than a bare `--from <accountUuid>`
 * placeholder nobody could run — see finding #14/(f). `--to` is spelled out
 * too, not left to default: a restart that runs later, after whatever is
 * signed in has changed, must still land on the same target this run was for.
 *
 * `--to-org` used to be missing (#140-ish): an account holding two
 * organizations makes `--to <uuid>` alone ambiguous (`resolveDestination`
 * refuses it, naming both), so the handed-over command could not actually be
 * run as printed. `--from` has no such flag to spell out — `view copy` never
 * grew a `--from-org` — so an ambiguous `--from` stays a refusal this
 * function cannot route around; it only ever gets as far as the target it
 * already resolved.
 */
export function viewCopyRestartCommand(from: AccountRef, to: AccountRef): string {
  return (
    `foster view copy --from ${from.accountUuid} --to ${to.accountUuid} ` +
    `--to-org ${to.organizationUuid} --yes --restart`
  );
}

/**
 * `foster layout`'s plan, in the shape both the dry run and a written run print —
 * lines rather than a direct `console.log`, so the CLI action and a test can
 * both drive the same rendering.
 *
 * `groupScopesSkipped` is `readGroupScopesReport(store).skippedEntries` for the
 * target's own scope key (see `store/groupScopes.ts`) — how many entries in this
 * account's own groups were malformed and left untouched. Named here, not
 * folded into `groups`, because it is a fact about the target's *current* file,
 * not about what this run would bring.
 */
export function layoutPlanLines(
  plan: LayoutPlan,
  options: { groupScopesSkipped?: number } = {},
): string[] {
  const { groups, routines } = plan;
  const sourceWord = (n: number): string => `${n} other account${n === 1 ? '' : 's'}`;
  const lines: string[] = [];

  lines.push(pc.bold(`Groups (from ${sourceWord(groups.sources)})`));
  if (groups.items.length === 0) {
    lines.push(pc.dim('  nothing to do'));
  } else {
    for (const item of groups.items) {
      if (item.created || item.assign.length > 0) {
        const rows = item.assign.length;
        lines.push(
          `  ${pc.green('+')} ${item.name}${item.created ? pc.dim(' (new)') : ''}: ${rows} row${rows === 1 ? '' : 's'}`,
        );
      }
      for (const skip of item.skipped) {
        const reason = skip.reason === 'archived' ? 'archived here' : 'no matching card here';
        lines.push(`  ${pc.dim('·')} ${skip.title} — ${reason}`);
      }
    }
  }
  if (groups.conflicts.length > 0) {
    const count = groups.conflicts.length;
    lines.push(
      pc.dim(
        `  ${count} conversation${count === 1 ? '' : 's'} named for two different groups — the source with the latest activity won.`,
      ),
    );
  }
  if (options.groupScopesSkipped) {
    const n = options.groupScopesSkipped;
    lines.push(
      pc.dim(
        `  ${n} unrecognised entr${n === 1 ? 'y' : 'ies'} in this account's groups were left untouched.`,
      ),
    );
  }

  lines.push(pc.bold(`\nRoutines (from ${sourceWord(routines.sources)})`));
  if (routines.bring.length === 0 && routines.skipped.length === 0) {
    lines.push(pc.dim('  nothing to do'));
  } else {
    for (const item of routines.bring) {
      const when =
        item.cronExpression ??
        (item.fireAt !== undefined ? `once ${formatRoutineFireAt(item.fireAt)}` : '');
      lines.push(`  ${pc.green('+')} ${item.id}  ${pc.dim(when)}`);
    }
    for (const skip of routines.skipped) {
      // Already-here is the ordinary, idempotent case on a second run — not
      // worth a line every time, the same restraint `sweep`'s title pass takes
      // for a copy renamed on purpose.
      if (skip.reason === 'already-here') continue;
      // Every remaining reason gets its own words — a `disabled` routine used
      // to fall into the `else` branch below and print "SKILL.md missing",
      // which was simply wrong: nothing about a disabled routine's skill file
      // is missing, it is disabled in whichever account holds its newest copy.
      const detail =
        skip.reason === 'missed-one-shot'
          ? `missed one-shot (${formatRoutineFireAt(skip.firedAt)}), not brought`
          : skip.reason === 'disabled'
            ? 'disabled in its newest account, not brought'
            : 'SKILL.md missing, not brought';
      lines.push(`  ${pc.dim('·')} ${skip.id} — ${detail}`);
    }
  }

  if (Object.keys(plan.viewPrefs.account).length > 0) {
    lines.push(
      pc.dim(
        `\nAlso carrying the sidebar filter menu's account settings${plan.viewPrefs.from ? ` from ${shortId(plan.viewPrefs.from.accountUuid)}` : ''}.`,
      ),
    );
  }

  // Only when a sweep left something behind — a store with no deferred pin
  // move has nothing to say here, and says nothing.
  const pins = plan.pins;
  if (pins && (pins.moves.length > 0 || pins.unreadable)) {
    lines.push(pc.bold('\nPins (moves a sweep could not make with the app open)'));
    for (const move of pins.moves) {
      lines.push(`  ${pc.green('→')} "${move.staleTitle}" → "${move.cleanTitle}"`);
    }
    if (pins.unreadable) {
      lines.push(pc.yellow(`  could not read the pin list: ${pins.unreadable}`));
    }
  }

  // The same restraint: said only when the running app saved over a mark.
  const marks = plan.marks ?? [];
  if (marks.length > 0) {
    lines.push(pc.bold('\nMarks (the app saved these rows back over a sweep while it was open)'));
    for (const request of marks) lines.push(`  ${pc.cyan('~')} ${request.title}`);
  }

  return lines;
}

/**
 * What `applyLayout` actually wrote, once it has returned successfully.
 *
 * `result.written` is printed here too (not only buried in a thrown
 * `LayoutWriteError`'s message) — a successful run wrote just as many distinct
 * files as a partly-failed one, and naming them is not only a failure's story
 * to tell.
 */
export function layoutResultLines(result: ApplyLayoutResult): string[] {
  const lines = [
    pc.bold(
      `\n${result.cardsAssigned} row(s) grouped, ${result.routinesBrought} routine(s) brought` +
        `${result.viewPrefsCarried ? ', filter menu carried' : ''}` +
        `${result.pinsMoved ? `, ${result.pinsMoved} pin(s) moved` : ''}` +
        `${result.marksBack ? `, ${result.marksBack} mark(s) written again` : ''}.`,
    ),
  ];
  if (result.written.length > 0) {
    lines.push(pc.dim(`  wrote: ${result.written.join(', ')}`));
  }
  if (result.pinsError) {
    lines.push(
      pc.yellow(
        `  pins not moved: ${result.pinsError} — still pending, the next foster layout tries again.`,
      ),
    );
  }
  return lines;
}

/**
 * What `verifyLayoutGroups` found once the app was up again — the line that
 * decides whether "with the layout applied" may be printed at all. A drop is
 * said in full: how many rows, which groups, why, and what still works,
 * because the run above it has just reported writing them.
 */
export function layoutCheckLines(check: LayoutGroupsCheck): string[] {
  const total = check.kept.length + check.dropped.length;
  const seconds = Math.round(check.waitedMs / 1000);
  if (check.dropped.length === 0) {
    return [
      check.appRewrote
        ? pc.green(
            `\nChecked after the app rewrote its config: all ${total} row(s) are still in their groups.`,
          )
        : pc.dim(
            `\nThe app had not rewritten its config ${seconds}s after starting; all ${total} row(s) are still filed there.`,
          ),
    ];
  }
  const groups = [...new Set(check.dropped.map((entry) => entry.groupName))];
  return [
    pc.yellow(
      `\nThe app dropped ${check.dropped.length} of ${total} row(s) from their groups when it started` +
        ` (${groups.join(', ')}).`,
    ),
    pc.dim(
      "  Its sidebar groups sync with the account's server copy, and startup replaced this\n" +
        "  account's groups with the server's. File them from inside the app instead: its own\n" +
        '  create_group and move_sessions tools, fed from "foster layout --json".',
    ),
  ];
}

/**
 * `error.written`, read structurally rather than through `LayoutWriteError`'s
 * own declared shape: this milestone's other, concurrent change is adding a
 * `written: string[]` field to that class, and reading it this way means this
 * code already picks it up the moment it lands, without a compile-time
 * dependency on the exact shape landing first — see `writtenOf`'s own callers.
 * Today, before that field exists, this simply returns `undefined`, the same
 * as it would for an error that never wrote anything.
 */
export function writtenOf(error: unknown): string[] | undefined {
  if (!(error instanceof LayoutWriteError)) return undefined;
  const written = (error as unknown as { written?: unknown }).written;
  return Array.isArray(written) && written.every((entry) => typeof entry === 'string')
    ? written
    : undefined;
}

/**
 * `applyLayout` threw — a `LayoutWriteError` naming exactly what landed before
 * it failed, or anything else. Either way this says what was written (from
 * `writtenOf(error)`, when the error carries one, rather than only whatever the
 * message text happens to mention) and what failed, so a caller never has to
 * choose between showing the plan and showing the damage.
 */
export function layoutFailureLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [pc.red(`\n${message}`)];
  const written = writtenOf(error);
  if (written && written.length > 0) {
    lines.push(pc.dim(`  wrote: ${written.join(', ')}`));
  }
  return lines;
}

/**
 * Whether a fresh `planLayout` — read again once the app has actually closed —
 * would write a different amount than the plan shown before the restart gap
 * opened. Compared on exactly the counts `applyLayout` would act on: a plan
 * that only re-orders a group's existing rows, or only rewords a skip reason,
 * is not "different" in the sense that matters here.
 */
export function layoutPendingCountsChanged(
  before: LayoutPendingCounts,
  after: LayoutPendingCounts,
): boolean {
  return (
    before.groupsCreated !== after.groupsCreated ||
    before.cardsAssigned !== after.cardsAssigned ||
    before.routinesBrought !== after.routinesBrought ||
    before.viewKeysCarried !== after.viewKeysCarried ||
    (before.pinsMoved ?? 0) !== (after.pinsMoved ?? 0) ||
    (before.marksBack ?? 0) !== (after.marksBack ?? 0)
  );
}

/**
 * `state.machineRecord.notices` — the notices `readLocalStorageValue` surfaced
 * while reading the sidebar filter menu's machine-wide half (a recovered log,
 * a tolerant skip over a record it could not parse) — as dim lines. There is
 * no other read notice `readViewState` carries today, but this is named for
 * what it reports rather than for the one field that happens to hold it, so a
 * later notice source needs no second line at the call site.
 */
export function viewNoticeLines(state: ViewState): string[] {
  return (state.machineRecord?.notices ?? []).map((note) => pc.dim(note));
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
  // Said on the line itself, because it is the answer to the question the row
  // provokes: this account already showed that conversation, so why is there a
  // second one? Because the row it had opens a different file of it, and this
  // one opens records that file does not hold.
  const beyond = outcome.beyond
    ? pc.dim(
        ` (a second file of a conversation already here: ${outcome.beyond} record(s) no row here could open)`,
      )
    : '';
  const line = `  ${marks[outcome.status]} ${outcome.title}${detail}${beyond}`;
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
 * One fork of the branch pass, as the sweep lists it: which branch carried on,
 * then every row it added or marked, in the title each row now wears.
 */
export function forkLines(fork: ForkOutcome): string[] {
  const tip = fork.rows.find((row) => row.tip);
  const held = tip ? ` — the branch that carried on holds ${tip.total} records` : '';
  const lines = [pc.dim(`  fork ${shortId(fork.root)}: ${fork.rows.length} branches${held}`)];
  for (const outcome of fork.brought) lines.push(broughtLine(outcome));
  for (const outcome of fork.retitled) lines.push(retitleLine(outcome));
  for (const row of fork.skipped) {
    lines.push(`  ${pc.dim('·')} ${row.title}${pc.dim(` (${row.detail})`)}`);
  }
  return lines;
}

/**
 * One conversation this account shows twice, and which row to continue in.
 *
 * The row to continue in is named first and named plainly: it is the answer the
 * reader came for, and the marks below it only make sense once they know which
 * row the marking was measured against.
 */
export function filePlanLines(plan: FilePlan, retitled: readonly RetitleOutcome[]): string[] {
  const working = plan.rows.find((row) => row.working);
  const holds = working ? ` — the row to continue in holds ${working.total} records` : '';
  const lines = [
    pc.dim(`  ${plan.working.title || '(untitled)'}: ${plan.rows.length} rows${holds}`),
  ];
  const mine = new Set(plan.retitle.map((request) => request.path));
  for (const outcome of retitled) {
    if (mine.has(outcome.path)) lines.push(retitleLine(outcome));
  }
  for (const row of plan.skipped) {
    lines.push(`  ${pc.dim('·')} ${row.title}${pc.dim(` (${row.detail})`)}`);
  }
  return lines;
}

/** A row the branch pass added, named by the title the copy wears. */
function broughtLine(outcome: Outcome): string {
  const marks: Record<OutcomeStatus, string> = {
    fostered: pc.green('+'),
    returned: pc.green('-'),
    skipped: pc.dim('·'),
    failed: pc.red('x'),
  };
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${marks[outcome.status]} ${outcome.copyTitle ?? outcome.title}${detail}`;
}

/** A row the branch pass renamed: what it said, what it says now. */
export function retitleLine(outcome: RetitleOutcome): string {
  const mark =
    outcome.status === 'retitled'
      ? pc.green('~')
      : outcome.status === 'failed'
        ? pc.red('x')
        : pc.dim('·');
  const filed =
    outcome.archived === undefined
      ? ''
      : pc.dim(outcome.archived.to ? ' → archived view' : ' → out of the archived view');
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${mark} ${outcome.from || '(untitled)'} ${pc.dim('→')} ${outcome.to}${filed}${detail}`;
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
  const { fostered, restored, branches } = report;

  // The rows the branch pass added are copies too, and a first line that said
  // "0 fostered" over seven of them read as a run that did nothing.
  const rows = branches.counts.fostered;
  const forBranches = rows > 0 ? `, ${rows} row${rows === 1 ? '' : 's'} for branches` : '';
  lines.push(
    report.dryRun
      ? pc.bold(
          `Dry run: ${fostered.counts.fostered} would be fostered${forBranches}, ` +
            `${restored.counts.fostered} restored.`,
        )
      : pc.bold(
          `${fostered.counts.fostered} fostered${forBranches}, ${restored.counts.fostered} restored, ` +
            `${fostered.counts.skipped + branches.counts.skipped + restored.counts.skipped} skipped, ` +
            `${fostered.counts.failed + branches.counts.failed + restored.counts.failed} failed.`,
        ),
  );

  // Separate from the count above: these are copies already on this disk, not
  // rows the sweep just wrote, so folding them into "N fostered" would credit
  // the sweep with bringing something it merely repaired.
  const claims = report.worktreeClaims;
  if (claims.items.length > 0) {
    lines.push(
      report.dryRun
        ? `${claims.items.length} cop${claims.items.length === 1 ? 'y' : 'ies'} to release from worktree claims.`
        : `released ${claims.counts.released} from worktree claims` +
            (claims.counts.skipped + claims.counts.failed > 0
              ? ` (${claims.counts.skipped} skipped, ${claims.counts.failed} failed)`
              : '') +
            '.',
    );
  }

  // Said whenever any row lands there, because the archived view is where they
  // land and Recents is where people look. A run that brought a hundred
  // sessions and appears to have brought none is this sentence going unsaid.
  if (report.archived > 0) {
    const one = report.archived === 1;
    lines.push(
      `${report.archived} of the rows ${one ? 'is' : 'are'} in the app's archived view, not in Recents — ` +
        'archived copies stay archived, and the branches that stopped are filed there.',
    );
  }

  // Same reasoning as the worktree line above: a title brought back into step is
  // a copy repaired, not a row brought.
  const titles = report.titleSync;
  if (titles && titles.items.length > 0) {
    const one = titles.items.length === 1;
    lines.push(
      report.dryRun
        ? `${titles.items.length} title${one ? '' : 's'} to bring into step with ${one ? 'its' : 'their'} original.`
        : `${titles.counts.synced} title${titles.counts.synced === 1 ? '' : 's'} brought into step` +
            (titles.counts.skipped + titles.counts.failed > 0
              ? ` (${titles.counts.skipped} skipped, ${titles.counts.failed} failed)`
              : '') +
            '.',
    );
  }

  // The dates pass, when it was asked for. Native cards are called out on their
  // own: they are the app's rows rather than foster's copies, and somebody who
  // turned this on deserves to see how much of it landed there.
  const dates = report.dates;
  if (dates && dates.items.length > 0) {
    const one = dates.items.length === 1;
    const native = dates.counts.native > 0 ? `, ${dates.counts.native} of them native cards` : '';
    lines.push(
      report.dryRun
        ? `${dates.items.length} card${one ? '' : 's'} would have ${one ? 'its' : 'their'} date advanced to the transcript${native}.`
        : `${dates.counts.advanced} card date${dates.counts.advanced === 1 ? '' : 's'} advanced${native}` +
            (dates.counts.failed > 0 ? ` (${dates.counts.failed} failed)` : '') +
            '.',
    );
  }

  // Archived-flag-only writes: same reasoning as the worktree and title lines
  // above, a card repaired rather than a row brought.
  const archives = report.archiveSync;
  if (archives.items.length > 0) {
    const one = archives.items.length === 1;
    lines.push(
      report.dryRun
        ? `${archives.items.length} archived flag${one ? '' : 's'} out of step with the account last used.`
        : `${archives.counts.written} archived flag${archives.counts.written === 1 ? '' : 's'} brought into step` +
            (archives.counts.skipped + archives.counts.failed > 0
              ? ` (${archives.counts.skipped} skipped, ${archives.counts.failed} failed)`
              : '') +
            '.',
    );
  }

  const confirmation = report.confirmation;
  if (confirmation) {
    lines.push(
      confirmation.exhausted
        ? pc.green(
            'Nothing is left to sweep: a second run would foster 0, add or mark 0 rows for branches, ' +
              'mark 0 second files, restore 0, and release 0 worktree claims' +
              (confirmation.titlesOutOfStep === undefined ? '' : ', bring 0 titles into step') +
              (confirmation.archivesOutOfStep === undefined
                ? ''
                : ', and bring 0 archived flags into step') +
              '.',
          )
        : pc.yellow(
            `Not finished: ${confirmation.fosterable} still to foster, ` +
              `${confirmation.branches} row(s) still to add or mark for branches, ` +
              `${confirmation.secondFiles} row(s) still to mark as a second file, ` +
              `${confirmation.restorable} still to restore, ` +
              `${confirmation.worktreeClaims} worktree claim(s) still to release` +
              (confirmation.titlesOutOfStep
                ? `, ${confirmation.titlesOutOfStep} title(s) still out of step`
                : '') +
              (confirmation.archivesOutOfStep
                ? `, ${confirmation.archivesOutOfStep} archived flag(s) still out of step`
                : '') +
              '. Run it again.',
          ),
    );
    // Said only when it happened: a round beyond the first is this run finishing
    // work its own writes made, which used to be a second and third invocation.
    const rounds = report.rounds ?? 1;
    if (rounds > 1) {
      lines.push(
        pc.dim(
          `Took ${rounds} rounds in this one run — the writes of each left work for the next.`,
        ),
      );
    }
  }

  const layout = report.layout;
  // `planLayout` itself threw while the sweep was being planned — every count
  // above is `0` for a reason that has nothing to do with there being nothing
  // pending, and `totalLayoutPending(layout) > 0` below would stay silent about
  // it. Said on its own line, ahead of that check, so a failed plan never
  // quietly reads as a clean one.
  if (layout.error) {
    lines.push(pc.yellow(`Layout: could not plan — ${layout.error}`));
  } else if (totalLayoutPending(layout) > 0) {
    const parts: string[] = [];
    if (layout.cardsAssigned > 0)
      parts.push(`${layout.cardsAssigned} group row${layout.cardsAssigned === 1 ? '' : 's'}`);
    if (layout.groupsCreated > 0)
      parts.push(`${layout.groupsCreated} new group${layout.groupsCreated === 1 ? '' : 's'}`);
    if (layout.orderEntriesAdded > 0)
      parts.push(
        `${layout.orderEntriesAdded} order entr${layout.orderEntriesAdded === 1 ? 'y' : 'ies'}`,
      );
    if (layout.routinesBrought > 0)
      parts.push(`${layout.routinesBrought} routine${layout.routinesBrought === 1 ? '' : 's'}`);
    if (layout.viewKeysCarried > 0)
      parts.push(
        `${layout.viewKeysCarried} filter setting${layout.viewKeysCarried === 1 ? '' : 's'}`,
      );
    if (layout.pinsMoved) parts.push(`${layout.pinsMoved} pin${layout.pinsMoved === 1 ? '' : 's'}`);
    if (layout.marksBack)
      parts.push(`${layout.marksBack} mark${layout.marksBack === 1 ? '' : 's'} the app undid`);
    // Never written by the sweep itself — see `SweepReport.layout` — so this is
    // always phrased as waiting, dry run or not.
    lines.push(`Layout: ${parts.join(', ')} to bring — foster layout --yes --restart`);
  }

  const never = neverComesLine(report.neverComes);
  if (never) lines.push(pc.dim(never));

  if (branches.forks.length > 0) {
    const forks = branches.forks.length;
    const added = branches.counts.fostered;
    const marked = branches.retitled.filter((outcome) => outcome.status === 'retitled').length;
    const filed =
      branches.archived > 0 ? `, ${branches.archived} filed in the archived view as stale` : '';
    lines.push(
      `${forks} forked conversation${forks === 1 ? '' : 's'}, one row per branch: ` +
        `${added} row${added === 1 ? '' : 's'} added, ${marked} retitled${filed}.\n` +
        // What the reader has to know to pick a row: the clean title is the one
        // to continue in, and a marked one says when it was left.
        `The branch that carried on keeps its title; the others wear "${branches.staleTemplate.trim()}" ` +
        'with the moment of their last answer.\n' +
        'Nothing is hidden — foster consolidate collapses a fork to one row if you want that.',
    );
  }

  // Said in the same shape as the fork paragraph above, and for the same
  // reason: the reader's next act is picking a row, and this is the sentence
  // that tells them which one.
  const files = report.files;
  if (files.plans.length > 0) {
    const pairs = files.plans.length;
    const marked = files.retitled.filter((outcome) => outcome.status === 'retitled').length;
    const filed = files.archived > 0 ? `, ${files.archived} filed in the archived view` : '';
    lines.push(
      `${pairs} conversation${pairs === 1 ? '' : 's'} shown here more than once, one row per file: ` +
        `${marked} row${marked === 1 ? '' : 's'} marked${filed}.\n` +
        'The row whose last answer is the most recent keeps its title and is the one to continue in; ' +
        `the others wear "${files.otherFileTemplate.trim()}".\n` +
        'Nothing is merged: each row still opens its own file, and foster consolidate does not join them.',
    );
  }

  const unknownMark = unknownMarkNames(branches.forks, files.plans);
  if (unknownMark) lines.push(pc.yellow(unknownMark));

  const pinLine = pinFixesLine(report.pinFixes);
  if (pinLine) lines.push(pc.yellow(pinLine));

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
 * `foster sweep --prove`'s report, one `console.log` call per array entry —
 * kept a pure function, the way every other sweep-facing render here is, so
 * the words are testable without driving the CLI itself (`index.ts` runs the
 * program on import; see `tests/helpGroups.test.ts`).
 *
 * A gap line and a never-fosterable line both carry the conversation's short
 * id, the same way `outcomeLine`/`sessionLine` do elsewhere: two different
 * conversations can share a title, and a never-fosterable line with no id at
 * all made a genuine pair look like one entry printed twice.
 */
export function proveLines(prove: ProveReport): string[] {
  const lines: string[] = [pc.bold(`\nProof: ${prove.conversations} conversation(s) checked`)];

  if (prove.complete) {
    lines.push(pc.dim('  every one is fully reachable from this account.'));
  } else {
    lines.push(pc.red(`  ${prove.gaps.length} conversation(s) this account cannot fully reach:`));
    for (const gap of prove.gaps) {
      lines.push(
        `    ${pc.red('!')} ${gap.title ?? pc.dim('(untitled)')} ${pc.dim(`(${shortId(gap.cliSessionId)})`)}\n` +
          `        reaches ${gap.reachedByTarget} of ${gap.totalRecords} — ${gap.missing} record(s) short`,
      );
    }
  }

  if (prove.neverFosterable.length > 0) {
    lines.push(
      pc.dim(
        `  ${prove.neverFosterable.length} more never had a way in (scheduled task, never opened, ` +
          'or too large) — not counted above:',
      ),
    );
    for (const item of prove.neverFosterable) {
      lines.push(
        pc.dim(
          `      ${item.title ?? '(untitled)'} (${shortId(item.cliSessionId)}) — ${item.reason}`,
        ),
      );
    }
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
  const detail = Object.entries(never.byReason)
    .map(([reason, count]) => `${count} ${describeUnfosterable(reason as Unfosterable)}`)
    .join(', ');
  const one = never.total === 1;
  const scheduledOnly =
    (never.byReason['scheduled-task'] ?? 0) + (never.byReason['spawned-task'] ?? 0);
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
  const spawned = never.byReason['spawned-task'] ?? 0;
  const ways: string[] = [];
  if (scheduled > 0) {
    ways.push(
      `The scheduled ${scheduled === 1 ? 'one is' : 'ones are'} reachable as ordinary conversations: foster --include-scheduled.`,
    );
  }
  // Said separately from the schedules, and worth saying: a spawned session is
  // the one entry here that routinely holds a whole piece of work nothing else
  // points at. Left under a flat "never" it reads as an empty record.
  if (spawned > 0) {
    ways.push(
      `The background ${spawned === 1 ? 'one is' : 'ones are'} too: foster --include-spawned.`,
    );
  }
  const withEscape = ways.length > 0 ? [line, ...ways].join('\n') : line;

  const stranded = strandedNames(never);
  return stranded ? `${withEscape}\n${stranded}` : withEscape;
}

/** At most this many named before the line turns into a wall of titles. */
const NAMED_LIMIT = 10;

/**
 * The ones with no way in, by name.
 *
 * Only those: a scheduled task is named by `--include-scheduled` one line up,
 * and a spawned one the same way by `--include-spawned`, so repeating either
 * title lengthens the report without telling the reader anything they can act
 * on. What is left has no flag and no follow-up command, and a bare count of it
 * is the gap this exists to close — a sweep once reported "2 never opened" and
 * neither title appeared anywhere, which is indistinguishable from having
 * brought everything.
 *
 * Empty when everything blocked had a flag of its own, so a clean run stays quiet.
 */
function strandedNames(never: NeverComes): string {
  const stranded = never.sessions.filter(
    (session) => session.reason !== 'scheduled-task' && session.reason !== 'spawned-task',
  );
  if (stranded.length === 0) return '';
  const shown = stranded.slice(0, NAMED_LIMIT);
  const rest = stranded.length - shown.length;
  const titles = shown.map((session) => `  ${session.title ?? '(untitled)'}`);
  // Said before the list, because the reader has to know these are the ones a
  // second run will not fix either.
  const head = `The ${stranded.length === 1 ? 'one' : `${stranded.length}`} with no way in:`;
  const tail = rest > 0 ? `\n  ...and ${rest} more` : '';
  return `${head}\n${titles.join('\n')}${tail}`;
}

/**
 * Rows the branch pass left alone because they already wear a mark it cannot
 * account for — named the way `strandedNames` names a session with no way in,
 * so the user can fix the words by hand or run with the prefix that matches.
 *
 * Counted separately from every other skip: it is a decision left to the
 * user, not work the sweep failed to finish, so it never counts against
 * "nothing is left to sweep" — see `sweepSummary`'s confirmation line, which
 * this plays no part in.
 *
 * Empty when nothing wears an unexplained mark, so a clean run stays quiet.
 */
function unknownMarkNames(forks: ForkOutcome[], plans: readonly FilePlan[]): string {
  const rows = [
    ...forks.flatMap((fork) => fork.skipped),
    ...plans.flatMap((plan) => plan.skipped),
  ].filter((row) => row.detail === UNKNOWN_MARK_DETAIL);
  if (rows.length === 0) return '';
  const shown = rows.slice(0, NAMED_LIMIT);
  const rest = rows.length - shown.length;
  const titles = shown.map((row) => `  ${row.title}`);
  const one = rows.length === 1;
  const head = `${rows.length} row${one ? '' : 's'} ${one ? 'wears' : 'wear'} a mark foster cannot account for, left as ${one ? 'it is' : 'they are'}:`;
  const tail = rest > 0 ? `\n  ...and ${rest} more` : '';
  return (
    `${head}\n${titles.join('\n')}${tail}\n` +
    'Fix the words by hand, or run with the --stale-prefix/--branch-prefix/--other-file-prefix that matches them.'
  );
}

/**
 * Say which pinned rows the branch pass just left stale, and what to pin
 * instead — issue #23. Pinning lives in the app's own IndexedDB keyed on
 * session id, so a row the branch pass marks stale keeps whatever pin it had,
 * and the branch that carried on arrives unpinned.
 *
 * Named whether or not the pin could actually be moved: the read behind this
 * is attempted on every run, so there is something to say on a run
 * that could not write.
 *
 * Empty when the branch pass touched no pinned row, so a run with nothing
 * pinned stays quiet.
 */
function pinFixesLine(pinFixes: SweepReport['pinFixes']): string {
  // The check that could not run (#76). Said only when this run marked a row
  // stale, because that is the case where a pin may have been left pointing at
  // the archived one — and silence there reads as "nothing was pinned".
  if (pinFixes.unreadable) {
    return (
      'Rows were marked stale, and foster could not read the pin list to see whether one of\n' +
      `them was pinned: ${pinFixes.unreadable}\n` +
      'The app holds that database while it runs. Check with "foster pin" after the restart.'
    );
  }
  if (pinFixes.fixes.length === 0) return '';
  const one = pinFixes.fixes.length === 1;
  // Named by the title the sidebar shows now, mark included: the row before the
  // mark and the row to continue in usually share a title, and a line reading
  // `"X" ... pin "X" instead` names nothing (measured 23/09/2026).
  const named = pinFixes.fixes
    .map((fix) => {
      const what =
        fix.as === 'other-file' ? 'the other file of its conversation' : 'a branch that stopped';
      const instead = fix.cleanPinned
        ? `"${fix.cleanTitle}" is already pinned, so only this pin has to go`
        : `pin "${fix.cleanTitle}" instead`;
      return `  "${fix.markedTitle ?? fix.staleTitle}" is ${what} — ${instead}`;
    })
    .join('\n');
  const head = `${pinFixes.fixes.length} pinned row${one ? '' : 's'} ${one ? 'wears' : 'wear'} a mark this run put on:`;

  if (pinFixes.moved) {
    return `${head}\n${named}\nMoved: the pin${one ? '' : 's'} now sit${one ? 's' : ''} on the row to continue in.`;
  }
  const why = pinFixes.blocked
    ? `\n${pinFixes.blocked}`
    : '\nRe-run the sweep once the pin can be written, or move it by hand with "foster pin".';
  return `${head}\n${named}${why}`;
}

/** The name a worktree claim shows, whichever field the card carried. */
function claimName(item: { worktreeName?: string; worktreePath?: string }): string {
  return item.worktreeName ?? item.worktreePath ?? '(worktree)';
}

/** One line of a plan: what a copy still names, and where a release sends it. */
export function unclaimPlanLine(item: UnclaimItem): string {
  const to = item.cwdTo ?? item.cwdFrom ?? '';
  return `  ${item.title}  ${pc.dim(claimName(item))} ${pc.dim('→')} ${to}`;
}

/** The same line, marked with what actually happened to it. */
export function unclaimOutcomeLine(outcome: UnclaimOutcome): string {
  const mark =
    outcome.status === 'released'
      ? pc.green('-')
      : outcome.status === 'failed'
        ? pc.red('x')
        : pc.dim('·');
  const to = outcome.cwdTo ?? outcome.cwdFrom ?? '';
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${mark} ${outcome.title}  ${pc.dim(claimName(outcome))} ${pc.dim('→')} ${to}${detail}`;
}

/**
 * `formatDate` truncates to a day, which hides exactly the gap #47 is about —
 * a card and its transcript disagreeing by hours on the same date. This keeps
 * the minute.
 */
function formatDateTime(ms: number | undefined): string {
  if (!ms) return '(no date on the card)';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** One line of a `foster dates` plan: what a card wears now, and what it would move to. */
export function datePlanLine(item: DatePlanItem): string {
  const from = formatDateTime(item.from);
  const to = item.transcriptAt === undefined ? '?' : formatDateTime(item.transcriptAt);
  return `  ${item.title}  ${pc.dim(from)} ${pc.dim('→')} ${to}`;
}

/** The same line, marked with what actually happened to it. */
export function dateOutcomeLine(outcome: DateOutcome): string {
  const mark =
    outcome.status === 'dated'
      ? pc.green('+')
      : outcome.status === 'failed'
        ? pc.red('x')
        : pc.dim('·');
  const from = formatDateTime(outcome.from);
  const to = formatDateTime(outcome.to);
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${mark} ${shortId(outcome.sessionId)}  ${pc.dim(from)} ${pc.dim('→')} ${to}${detail}`;
}
