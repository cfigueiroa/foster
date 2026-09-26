import { describe, expect, it } from 'vitest';
import {
  abbreviate,
  accountTree,
  formatAge,
  formatBytes,
  formatRoutineFireAt,
  groupByAccount,
  neverComesLine,
  proveLines,
  sweepSummary,
  unclaimOutcomeLine,
  unclaimPlanLine,
  viewCopyRestartCommand,
} from '../src/cli/render.js';
import type { NeverComes, NeverComeSession, SweepReport } from '../src/ops/sweep.js';
import type { ProveReport } from '../src/ops/prove.js';
import type { UnclaimItem, UnclaimOutcome } from '../src/engine/unclaim.js';
import { totalLayoutPending } from '../src/engine/layout.js';

const ACCOUNT_A = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_B = '11111111-1111-4111-8111-1111111111b1';
const ORG_1 = '00000000-0000-4000-8000-000000000001';
const ORG_2 = '00000000-0000-4000-8000-000000000002';
const ORG_3 = '11111111-1111-4111-8111-111111111113';

const row = (
  accountUuid: string,
  organizationUuid: string,
  nativeCount: number,
  isCurrent = false,
) => ({
  account: { accountUuid, organizationUuid },
  nativeCount,
  copyCount: 0,
  isCurrent,
});

/**
 * Colour codes sit in front of the indentation, so assertions about layout have
 * to look at the text the user actually sees.
 */
// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\[[0-9;]*m/g, '');

describe('groupByAccount', () => {
  it('collapses an account that owns several organizations into one entry', () => {
    const groups = groupByAccount([
      row(ACCOUNT_A, ORG_1, 185),
      row(ACCOUNT_A, ORG_2, 134),
      row(ACCOUNT_B, ORG_3, 13, true),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.organizations).toHaveLength(2);
    expect(groups[1]!.isCurrent).toBe(true);
  });
});

describe('accountTree', () => {
  /**
   * The flat rendering this replaced read as though the account identifier were
   * an organization, and as though one account with two organizations were two
   * accounts. These assertions pin the distinction.
   */
  it('states the account total and how many organizations it spans', () => {
    const output = accountTree(
      groupByAccount([row(ACCOUNT_A, ORG_1, 185), row(ACCOUNT_A, ORG_2, 134)]),
    );

    expect(output).toContain('319 session(s) in 2 organizations');
  });

  it('nests organizations under the account rather than beside it', () => {
    const output = accountTree(
      groupByAccount([row(ACCOUNT_A, ORG_1, 185), row(ACCOUNT_A, ORG_2, 134)]),
    );
    const lines = plain(output).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toMatch(/^\s/);
    expect(lines[1]).toMatch(/^\s+├ org /);
    expect(lines[2]).toMatch(/^\s+└ org /);
  });

  it('uses the singular for an account with one organization', () => {
    const output = accountTree(groupByAccount([row(ACCOUNT_B, ORG_3, 13)]));
    expect(output).toContain('13 session(s) in 1 organization');
    expect(output).not.toContain('organizations');
  });

  it('marks the signed-in account', () => {
    const output = accountTree(groupByAccount([row(ACCOUNT_B, ORG_3, 13, true)]));
    expect(output).toContain('this account');
  });

  it('prefers a human label over the identifier when one exists', () => {
    const output = accountTree(
      groupByAccount([row(ACCOUNT_A, ORG_1, 1)]),
      new Map([[ACCOUNT_A, 'old work account']]),
    );
    expect(output).toContain('old work account');
  });
});

describe('abbreviate', () => {
  it('keeps eight characters when that is already unambiguous', () => {
    const names = abbreviate([ACCOUNT_A, ACCOUNT_B]);
    expect(names.get(ACCOUNT_A)).toBe('00000000');
    expect(names.get(ACCOUNT_B)).toBe('11111111');
  });

  it('lengthens only as far as it must to stay distinct', () => {
    // These differ at the very last character.
    const names = abbreviate([ORG_1, ORG_2]);
    expect(names.get(ORG_1)).not.toBe(names.get(ORG_2));
    expect(names.get(ORG_1)).toBe(ORG_1);
  });

  it('does not choke on a single identifier', () => {
    expect(abbreviate([ORG_1]).get(ORG_1)).toBe('00000000');
  });
});

describe('the tree with colliding identifiers', () => {
  it('never prints the same name for two different organizations', () => {
    const tree = plain(
      accountTree(groupByAccount([row(ACCOUNT_A, ORG_1, 1), row(ACCOUNT_A, ORG_2, 1)])),
    );
    const shown = [...tree.matchAll(/org (\S+)/g)].map((match) => match[1]);

    expect(shown).toHaveLength(2);
    expect(new Set(shown).size).toBe(2);
  });

  it('leaves the account short when only the organizations collide', () => {
    const tree = plain(
      accountTree(groupByAccount([row(ACCOUNT_A, ORG_1, 1), row(ACCOUNT_A, ORG_2, 1)])),
    );
    expect(tree.split('\n')[0]).toContain('00000000  ');
  });
});

describe('formatBytes', () => {
  it('carries the unit when rounding would reach 1024', () => {
    // A byte short of a megabyte rounds up on the way to the screen, so a plain
    // `value >= 1024` carry left it reading "1024 KB".
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1.0 GB');
  });

  it('reads the ordinary sizes the way a person would', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(4176)).toBe('4.1 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
  });

  it('stops at the largest unit it has rather than inventing one', () => {
    expect(formatBytes(1024 ** 4)).toBe('1024 GB');
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-08-02T00:00:00Z');

  it('says when there is nothing to go on', () => {
    expect(formatAge(undefined, now)).toBe('never used');
  });

  it('reads in the units a person would use', () => {
    expect(formatAge(now, now)).toBe('today');
    expect(formatAge(now - 86_400_000, now)).toBe('yesterday');
    expect(formatAge(now - 5 * 86_400_000, now)).toBe('5 days ago');
    expect(formatAge(now - 90 * 86_400_000, now)).toBe('3 months ago');
    expect(formatAge(now - 800 * 86_400_000, now)).toBe('2 years ago');
  });

  it('does not report the future as a very long time ago', () => {
    expect(formatAge(now + 86_400_000, now)).toBe('just now');
  });
});

describe('formatRoutineFireAt', () => {
  const now = new Date('2026-09-22T12:00:00');

  it('omits the year when fireAt falls in the current year', () => {
    const fireAt = new Date(2026, 6, 1, 9, 0).getTime(); // 01/07/2026 09:00
    expect(formatRoutineFireAt(fireAt, now)).toBe('01/07 09:00');
  });

  it('prints the year when fireAt falls in a different year', () => {
    const fireAt = new Date(2027, 6, 1, 9, 0).getTime(); // 01/07/2027 09:00
    expect(formatRoutineFireAt(fireAt, now)).toBe('01/07/2027 09:00');
  });

  it('prints the year for a year already past, too', () => {
    const fireAt = new Date(2024, 11, 25, 18, 30).getTime(); // 25/12/2024 18:30
    expect(formatRoutineFireAt(fireAt, now)).toBe('25/12/2024 18:30');
  });

  it('passes an undated moment straight through', () => {
    expect(formatRoutineFireAt(undefined, now)).toBe('—');
  });
});

describe('viewCopyRestartCommand', () => {
  it('names both accounts by their real uuid — no <accountUuid> placeholder', () => {
    const from = { accountUuid: ACCOUNT_A, organizationUuid: ORG_1 };
    const to = { accountUuid: ACCOUNT_B, organizationUuid: ORG_2 };
    const command = viewCopyRestartCommand(from, to);

    expect(command).toBe(
      `foster view copy --from ${ACCOUNT_A} --to ${ACCOUNT_B} --to-org ${ORG_2} --yes --restart`,
    );
    expect(command).not.toContain('<accountUuid>');
  });
});

describe('sweepSummary', () => {
  const counts = { fostered: 0, skipped: 0, failed: 0, returned: 0 };
  const report = (overrides: Partial<SweepReport> = {}): SweepReport => ({
    store: 'C:\\store',
    target: { accountUuid: ACCOUNT_A, organizationUuid: ORG_1 },
    dryRun: false,
    fostered: { outcomes: [], counts },
    branches: {
      forks: [],
      outcomes: [],
      retitled: [],
      archived: 0,
      counts,
      staleTemplate: '(stale, stopped {when}) ',
      divergedTemplate: '(other branch, went on {when}) ',
    },
    restored: { outcomes: [], counts },
    files: {
      plans: [],
      retitled: [],
      archived: 0,
      otherFileTemplate: '(other file, stopped {when}) ',
    },
    worktreeClaims: { items: [], outcomes: [], counts: { released: 0, skipped: 0, failed: 0 } },
    archived: 0,
    liveWriters: [],
    neverComes: { total: 0, byReason: {}, sessions: [] },
    pinFixes: { fixes: [], moved: false },
    layout: {
      groupsCreated: 0,
      cardsAssigned: 0,
      orderEntriesAdded: 0,
      routinesBrought: 0,
      viewKeysCarried: 0,
    },
    unreadableCards: [],
    ...overrides,
  });

  it('names the cards a scan could not read, rather than only a smaller count', () => {
    const lines = sweepSummary(
      report({ unreadableCards: ['C:\\store\\accounts\\a\\local_broken.json'] }),
    );
    expect(lines.some((line) => line.includes('1 card could not be read'))).toBe(true);
    expect(lines.some((line) => line.includes('local_broken.json'))).toBe(true);
  });

  it('says nothing about unreadable cards when there are none', () => {
    const lines = sweepSummary(report());
    expect(lines.some((line) => line.includes('could not be read'))).toBe(false);
  });

  it('says one row per branch, and never that the app has to be closed', () => {
    const lines = sweepSummary(
      report({
        branches: {
          forks: [{ root: 'r', tip: 't', rows: [], brought: [], retitled: [], skipped: [] }],
          outcomes: [],
          retitled: [
            {
              path: 'p',
              sessionId: 's',
              from: 'Work',
              to: '(stale, stopped 01/09 18:10) Work',
              status: 'retitled',
              as: 'stale',
            },
          ],
          archived: 2,
          counts: { ...counts, fostered: 1 },
          staleTemplate: '(stale, stopped {when}) ',
          divergedTemplate: '(other branch, went on {when}) ',
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain(
      '1 forked conversation, one row per branch: 1 row added, 1 retitled, 2 filed in the archived view as stale.',
    );
    expect(lines).toContain('"(stale, stopped {when})"');
    expect(lines).not.toMatch(/needs the app closed/);
  });

  it('says nothing about forks when there are none', () => {
    expect(sweepSummary(report()).map(plain).join('\n')).not.toMatch(/fork/);
  });

  it('names a pinned row the branch pass marked stale, and the row to pin instead', () => {
    const lines = sweepSummary(
      report({
        pinFixes: {
          fixes: [
            {
              staleSessionId: 'local_stale',
              staleTitle: 'Macs',
              cleanTitle: 'Macs',
              cleanSessionId: 'local_clean',
            },
          ],
          moved: true,
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain('"Macs" is a branch that stopped — pin "Macs" instead');
    expect(lines).toMatch(/Moved:/);
  });

  it('still names the pin fix when the app was open and it could not move', () => {
    const lines = sweepSummary(
      report({
        pinFixes: {
          fixes: [
            {
              staleSessionId: 'local_stale',
              staleTitle: 'Macs',
              cleanTitle: 'Macs (other branch, went on 02/09 12:00)',
              cleanSessionId: 'local_clean',
            },
          ],
          moved: false,
          blocked: 'Claude Desktop is running (userData lockfile is held by a running app).',
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain('is a branch that stopped');
    expect(lines).toMatch(/Claude Desktop is running/);
    expect(lines).not.toMatch(/Moved:/);
  });

  /**
   * Measured 23/09/2026: the line read `"Jurídico & clientes" is a branch that
   * stopped — pin "Jurídico & clientes" instead`, naming two rows by the same
   * title, calling the other file of a conversation a branch, and asking to pin
   * a row that already was.
   */
  it('names the marked row by the title it shows, and says when the row to continue in is already pinned', () => {
    const lines = sweepSummary(
      report({
        pinFixes: {
          fixes: [
            {
              staleSessionId: 'local_stale',
              staleTitle: 'Clientes',
              markedTitle: '(other file, stopped 23/09 08:17) Clientes',
              as: 'other-file',
              cleanTitle: 'Clientes',
              cleanSessionId: 'local_clean',
              cleanPinned: true,
            },
          ],
          moved: false,
          deferred: true,
          blocked: 'Claude Desktop is running. Kept for later: "foster layout --yes --restart".',
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain(
      '"(other file, stopped 23/09 08:17) Clientes" is the other file of its conversation — ' +
        '"Clientes" is already pinned, so only this pin has to go',
    );
    expect(lines).toMatch(/foster layout --yes --restart/);
  });

  it('points at foster layout when the only thing waiting is a deferred pin', () => {
    const counts = {
      groupsCreated: 0,
      cardsAssigned: 0,
      orderEntriesAdded: 0,
      routinesBrought: 0,
      viewKeysCarried: 0,
      pinsMoved: 1,
    };
    // What decides the command a sweep hands over (`foster layout` rather than a
    // plain restart) and the argv of a detached one.
    expect(totalLayoutPending(counts)).toBe(1);
    const lines = sweepSummary(report({ layout: counts }))
      .map(plain)
      .join('\n');
    expect(lines).toContain('Layout: 1 pin to bring — foster layout --yes --restart');
  });

  it('says nothing about pins when the branch pass touched none', () => {
    expect(sweepSummary(report()).map(plain).join('\n')).not.toMatch(/pin/i);
  });

  it('says nothing about layout when nothing is pending', () => {
    expect(sweepSummary(report()).map(plain).join('\n')).not.toMatch(/Layout:/);
  });

  it('shows a "Layout:" line for a plan with only a pending order entry — nothing else pending', () => {
    // The old check only asked about cards and routines, so a plan that would
    // only reorder an existing group's rows fell through it silently.
    const lines = sweepSummary(
      report({
        layout: {
          groupsCreated: 0,
          cardsAssigned: 0,
          orderEntriesAdded: 3,
          routinesBrought: 0,
          viewKeysCarried: 0,
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain('Layout: 3 order entries to bring — foster layout --yes --restart');
  });

  it('shows a "Layout:" line for a plan with only the sidebar filter menu to carry', () => {
    const lines = sweepSummary(
      report({
        layout: {
          groupsCreated: 0,
          cardsAssigned: 0,
          orderEntriesAdded: 0,
          routinesBrought: 0,
          viewKeysCarried: 1,
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain('Layout: 1 filter setting to bring — foster layout --yes --restart');
  });

  it('names every kind of pending work together', () => {
    const lines = sweepSummary(
      report({
        layout: {
          groupsCreated: 1,
          cardsAssigned: 2,
          orderEntriesAdded: 3,
          routinesBrought: 4,
          viewKeysCarried: 5,
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain(
      'Layout: 2 group rows, 1 new group, 3 order entries, 4 routines, 5 filter settings to bring — foster layout --yes --restart',
    );
  });

  it('says a layout plan could not be made, rather than reading as nothing pending (R6)', () => {
    // Every count is 0 here for a reason that has nothing to do with there
    // being nothing to bring — `planLayout` itself threw while the sweep was
    // planning it. The old check only asked `totalLayoutPending(layout) > 0`,
    // so this read exactly like a clean run.
    const lines = sweepSummary(
      report({
        layout: {
          groupsCreated: 0,
          cardsAssigned: 0,
          orderEntriesAdded: 0,
          routinesBrought: 0,
          viewKeysCarried: 0,
          error:
            'claude_desktop_config.json holds a number literal a JSON round-trip would rewrite',
        },
      }),
    )
      .map(plain)
      .join('\n');

    expect(lines).toContain(
      'Layout: could not plan — claude_desktop_config.json holds a number literal a JSON round-trip would rewrite',
    );
  });
});

describe('unclaimPlanLine', () => {
  const item = (overrides: Partial<UnclaimItem> = {}): UnclaimItem => ({
    path: 'C:\\home\\repo\\.claude\\worktrees\\wt-a\\local_a.json',
    sessionId: 'local_a',
    title: 'Refactor parser',
    worktreeName: 'wt-a',
    worktreePath: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    cwdFrom: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    cwdTo: 'C:\\home\\repo',
    ...overrides,
  });

  it('names the title, the worktree, and where the release would send cwd', () => {
    const line = plain(unclaimPlanLine(item()));
    expect(line).toContain('Refactor parser');
    expect(line).toContain('wt-a');
    expect(line).toContain('C:\\home\\repo');
  });

  it('falls back to the worktree path when there is no name', () => {
    const line = plain(unclaimPlanLine(item({ worktreeName: undefined })));
    expect(line).toContain('C:\\home\\repo\\.claude\\worktrees\\wt-a');
  });

  it('shows the cwd the card already wears when the release would not move it', () => {
    const line = plain(unclaimPlanLine(item({ cwdTo: undefined })));
    expect(line).toContain(item().cwdFrom);
  });
});

describe('unclaimOutcomeLine', () => {
  const outcome = (overrides: Partial<UnclaimOutcome> = {}): UnclaimOutcome => ({
    path: 'C:\\home\\repo\\.claude\\worktrees\\wt-a\\local_a.json',
    sessionId: 'local_a',
    title: 'Refactor parser',
    status: 'released',
    worktreeName: 'wt-a',
    cwdFrom: 'C:\\home\\repo\\.claude\\worktrees\\wt-a',
    cwdTo: 'C:\\home\\repo',
    ...overrides,
  });

  it('marks a release, a skip and a failure differently', () => {
    expect(plain(unclaimOutcomeLine(outcome({ status: 'released' })))).toContain('-');
    expect(plain(unclaimOutcomeLine(outcome({ status: 'skipped' })))).toContain('·');
    expect(plain(unclaimOutcomeLine(outcome({ status: 'failed' })))).toContain('x');
  });

  it('carries the detail along for a skip or a failure', () => {
    const line = plain(
      unclaimOutcomeLine(outcome({ status: 'failed', detail: 'the card could not be read' })),
    );
    expect(line).toContain('the card could not be read');
  });
});

describe('neverComesLine', () => {
  const never = (sessions: NeverComeSession[]): NeverComes => {
    const byReason: Partial<Record<NeverComeSession['reason'], number>> = {};
    for (const one of sessions) byReason[one.reason] = (byReason[one.reason] ?? 0) + 1;
    return { total: sessions.length, byReason, sessions };
  };

  it('names the ones with no way in, so the count is not the only trace of them', () => {
    // The whole reason this exists: a sweep reported "2 never opened" and the two
    // titles appeared nowhere, which reads exactly like having brought everything.
    const line = plain(
      neverComesLine(
        never([
          { title: 'Guard for every versioned plist', reason: 'never-opened' },
          { title: 'Half-written draft', reason: 'too-large' },
        ]),
      ),
    );

    expect(line).toContain('Guard for every versioned plist');
    expect(line).toContain('Half-written draft');
    expect(line).toContain('2 with no way in');
  });

  it('leaves scheduled tasks unnamed, because the flag above already answers them', () => {
    const line = plain(
      neverComesLine(
        never([
          { title: 'Nightly watchdog', reason: 'scheduled-task' },
          { title: 'Second watchdog', reason: 'scheduled-task' },
        ]),
      ),
    );

    expect(line).toContain('foster --include-scheduled');
    expect(line).not.toContain('Nightly watchdog');
    expect(line).not.toContain('with no way in');
  });

  it('names the stranded ones even when scheduled tasks are the bulk of the gap', () => {
    const line = plain(
      neverComesLine(
        never([
          ...Array.from({ length: 8 }, (_, i) => ({
            title: `Watchdog ${i}`,
            reason: 'scheduled-task' as const,
          })),
          { title: 'The one nobody would find', reason: 'never-opened' },
        ]),
      ),
    );

    expect(line).toContain('The one nobody would find');
    expect(line).toContain('The one with no way in');
  });

  it('caps the list rather than printing a wall of titles', () => {
    const line = plain(
      neverComesLine(
        never(
          Array.from({ length: 13 }, (_, i) => ({
            title: `Stranded ${i}`,
            reason: 'never-opened' as const,
          })),
        ),
      ),
    );

    expect(line).toContain('Stranded 9');
    expect(line).not.toContain('Stranded 10');
    expect(line).toContain('...and 3 more');
  });

  it('gives an untitled session a name to be listed under', () => {
    const line = plain(neverComesLine(never([{ title: undefined, reason: 'never-opened' }])));

    expect(line).toContain('(untitled)');
  });

  it('stays empty when there is no gap at all', () => {
    expect(neverComesLine(never([]))).toBe('');
  });
});

describe('proveLines', () => {
  const baseReport = (overrides: Partial<ProveReport> = {}): ProveReport => ({
    conversations: 2,
    gaps: [],
    neverFosterable: [],
    complete: true,
    ...overrides,
  });

  it('prints a short id on a never-fosterable line, the same way a gap line does', () => {
    // Two different conversations can share a title — measured on a real
    // store (D2, 21 of 29 `--prove` gaps false alarms) — and a
    // never-fosterable line naming only the title made that pair read as one
    // entry printed twice. The id is what tells them apart.
    const lines = proveLines(
      baseReport({
        neverFosterable: [
          {
            cliSessionId: '00000000-0000-4000-8000-0000000000d1',
            title: 'Sweep fixes',
            reason: 'scheduled-task',
          },
          {
            cliSessionId: '11111111-1111-4111-8111-1111111111d2',
            title: 'Sweep fixes',
            reason: 'spawned-task',
          },
        ],
      }),
    ).map(plain);

    const text = lines.join('\n');
    expect(text).toContain('00000000');
    expect(text).toContain('11111111');
    // The two lines must differ from each other, or the id addition changed
    // nothing about telling the pair apart.
    const named = lines.filter((line) => line.includes('Sweep fixes'));
    expect(named).toHaveLength(2);
    expect(named[0]).not.toBe(named[1]);
  });

  it('reports completion with no gap section when the report is complete', () => {
    const text = proveLines(baseReport()).map(plain).join('\n');
    expect(text).toContain('fully reachable');
    expect(text).not.toContain('cannot fully reach');
  });

  it('names every gap with its own short id, same as a never-fosterable line', () => {
    const text = proveLines(
      baseReport({
        complete: false,
        gaps: [
          {
            cliSessionId: '00000000-0000-4000-8000-0000000000d3',
            title: 'Gap one',
            totalRecords: 5,
            reachedByTarget: 3,
            missing: 2,
          },
        ],
      }),
    )
      .map(plain)
      .join('\n');

    expect(text).toContain('00000000');
    expect(text).toContain('reaches 3 of 5');
  });
});
