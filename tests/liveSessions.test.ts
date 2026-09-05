import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveBranchNote } from '../src/engine/continued.js';
import type { ProcessRow } from '../src/engine/desktop.js';
import {
  buildHostedIndex,
  describeWriters,
  endableWriter,
  hostedStoreFor,
  isSelfHostedBy,
  liveSessions,
  pruneRegistry,
  staleRegistryEntries,
  writerAliveWith,
  type HostCandidate,
} from '../src/store/liveSessions.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

const CONVERSATION = '00000000-0000-4000-8000-0000000000e1';

/** A process table: a CLI session, foster under it, and an unrelated session. */
const TREE: ProcessRow[] = [
  { pid: 100, parentPid: 1, name: 'claude.exe', path: '', commandLine: '', startedAt: 1_000 },
  { pid: 200, parentPid: 100, name: 'node.exe', path: '', commandLine: '', startedAt: 2_000 },
  { pid: 900, parentPid: 1, name: 'claude.exe', path: '', commandLine: '', startedAt: 1_000 },
];

function registryWith(entries: Record<string, unknown>[]): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'foster-live-')), 'sessions');
  mkdirSync(root, { recursive: true });
  entries.forEach((entry, index) =>
    writeFileSync(path.join(root, `${index}.json`), JSON.stringify(entry), 'utf8'),
  );
  return root;
}

describe('isSelfHostedBy', () => {
  it('recognises the session foster was started from', () => {
    // Ending it would kill the command reporting the result, which is the one
    // process a command must never end.
    expect(isSelfHostedBy(100, () => TREE, 200)).toBe(true);
  });

  it('does not claim an unrelated session', () => {
    expect(isSelfHostedBy(900, () => TREE, 200)).toBe(false);
  });

  it('refuses to walk into a parent younger than its child', () => {
    // A recycled pid can point at a process that started later; treating it as an
    // ancestor would mark an unrelated session as this one.
    const recycled: ProcessRow[] = [
      { pid: 100, parentPid: 1, name: 'claude.exe', path: '', commandLine: '', startedAt: 9_000 },
      { pid: 200, parentPid: 100, name: 'node.exe', path: '', commandLine: '', startedAt: 2_000 },
    ];
    expect(isSelfHostedBy(100, () => recycled, 200)).toBe(false);
  });

  it('concludes nothing when the process table is unavailable', () => {
    expect(isSelfHostedBy(100, () => [], 200)).toBe(false);
  });
});

describe('describeWriters', () => {
  it('names the process and where it is running', () => {
    const root = registryWith([{ pid: 900, sessionId: CONVERSATION, cwd: '/work/thing' }]);

    expect(
      describeWriters(
        [CONVERSATION],
        [root],
        () => TREE,
        () => true,
      ),
    ).toEqual([{ pid: 900, cwd: '/work/thing' }]);
  });

  it('ignores conversations that have no writer', () => {
    const root = registryWith([{ pid: 900, sessionId: 'something-else', cwd: '/elsewhere' }]);

    expect(
      describeWriters(
        [CONVERSATION],
        [root],
        () => TREE,
        () => true,
      ),
    ).toEqual([]);
  });

  it('matches the conversation whatever case it is written in', () => {
    const root = registryWith([
      { pid: 900, sessionId: CONVERSATION.toUpperCase(), cwd: '/work/thing' },
    ]);

    expect(
      describeWriters(
        [CONVERSATION],
        [root],
        () => TREE,
        () => true,
      ),
    ).toHaveLength(1);
  });

  it('drops a writer whose pid now belongs to something else', () => {
    // The fork warning is read as "somebody is writing this right now". A pid
    // that has been reused makes it say so about a database worker.
    const root = registryWith([recordAsWritten({ pid: 7272 })]);
    const recycled = [
      process_({ pid: 7272, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + HOUR }),
    ];

    expect(describeWriters([CONVERSATION], [root], () => recycled, against(recycled))).toEqual([]);
  });
});

describe('liveSessions reading entrypoint', () => {
  it('carries the entrypoint the record wrote', () => {
    const root = registryWith([
      { pid: 900, sessionId: CONVERSATION, cwd: '/work/thing', entrypoint: 'claude-desktop' },
    ]);

    const live = liveSessions([root], () => true);
    expect(live[0]?.entrypoint).toBe('claude-desktop');
  });

  it('leaves it undefined for a record too old to carry one', () => {
    const root = registryWith([{ pid: 900, sessionId: CONVERSATION, cwd: '/work/thing' }]);

    const live = liveSessions([root], () => true);
    expect(live[0]?.entrypoint).toBeUndefined();
  });
});

describe('hostedStoreFor', () => {
  // The registry's own `sessionId` is the CLI's id for the conversation. The
  // card the app writes is named after a *different* id — its own — and
  // carries the CLI id inside itself as `cliSessionId`. These fixtures keep
  // the two deliberately distinct, the way a real card does: a lookup that
  // only matched by filename would pass every test here and still fail on a
  // real machine, which is exactly what happened.
  const CARD_ID = '00000000-0000-4000-8000-00000000000c';
  const OTHER_CARD_ID = '00000000-0000-4000-8000-00000000000d';

  function candidateFor(root: string, overrides: Partial<HostCandidate> = {}): HostCandidate {
    return { root, exists: true, ...overrides };
  }

  it('names the store and account holding the card', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: CARD_ID, cliSessionId: CONVERSATION }));
    const candidate = candidateFor(store.root, {
      name: 'work',
      accountUuid: OLD_ACCOUNT.accountUuid,
    });

    const index = buildHostedIndex([candidate]);
    expect(
      hostedStoreFor({ sessionId: CONVERSATION, entrypoint: 'claude-desktop' }, index),
    ).toEqual(candidate);
  });

  it('never looks up a terminal session, even when a card carries its id as cliSessionId', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: CARD_ID, cliSessionId: CONVERSATION }));
    const index = buildHostedIndex([candidateFor(store.root)]);

    expect(hostedStoreFor({ sessionId: CONVERSATION }, index)).toBeUndefined();
    expect(
      hostedStoreFor({ sessionId: CONVERSATION, entrypoint: 'terminal' }, index),
    ).toBeUndefined();
  });

  it('leaves a hosted entry unlabeled when no card claims its id, instead of guessing', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: CARD_ID, cliSessionId: 'unrelated-conversation' }),
    );
    const index = buildHostedIndex([candidateFor(store.root)]);

    expect(
      hostedStoreFor({ sessionId: CONVERSATION, entrypoint: 'claude-desktop' }, index),
    ).toBeUndefined();
  });

  it('does not check inside a store that no longer exists', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: CARD_ID, cliSessionId: CONVERSATION }));
    const index = buildHostedIndex([candidateFor(store.root, { exists: false })]);

    expect(
      hostedStoreFor({ sessionId: CONVERSATION, entrypoint: 'claude-desktop' }, index),
    ).toBeUndefined();
  });

  it('assigns each session to its own store when two are standing', () => {
    const storeA = makeStore();
    writeSession(storeA, OLD_ACCOUNT, session({ sessionId: CARD_ID, cliSessionId: 'session-a' }));
    const storeB = makeStore();
    writeSession(
      storeB,
      NEW_ACCOUNT,
      session({ sessionId: OTHER_CARD_ID, cliSessionId: 'session-b' }),
    );
    const candidateA = candidateFor(storeA.root, { name: 'a' });
    const candidateB = candidateFor(storeB.root, { name: 'b' });
    const index = buildHostedIndex([candidateA, candidateB]);

    expect(hostedStoreFor({ sessionId: 'session-a', entrypoint: 'claude-desktop' }, index)).toEqual(
      candidateA,
    );
    expect(hostedStoreFor({ sessionId: 'session-b', entrypoint: 'claude-desktop' }, index)).toEqual(
      candidateB,
    );
  });

  it('attributes an entry to the second of two stores when only that one holds its card', () => {
    const storeA = makeStore();
    writeSession(
      storeA,
      OLD_ACCOUNT,
      session({ sessionId: CARD_ID, cliSessionId: 'unrelated-conversation' }),
    );
    const storeB = makeStore();
    writeSession(
      storeB,
      NEW_ACCOUNT,
      session({ sessionId: OTHER_CARD_ID, cliSessionId: CONVERSATION }),
    );
    const candidateA = candidateFor(storeA.root, { name: 'a' });
    const candidateB = candidateFor(storeB.root, { name: 'b' });
    const index = buildHostedIndex([candidateA, candidateB]);

    expect(
      hostedStoreFor({ sessionId: CONVERSATION, entrypoint: 'claude-desktop' }, index),
    ).toEqual(candidateB);
  });

  it('leaves an entry unlabelled when no card anywhere claims its id', () => {
    const storeA = makeStore();
    writeSession(storeA, OLD_ACCOUNT, session({ sessionId: CARD_ID, cliSessionId: 'unrelated-a' }));
    const storeB = makeStore();
    writeSession(
      storeB,
      NEW_ACCOUNT,
      session({ sessionId: OTHER_CARD_ID, cliSessionId: 'unrelated-b' }),
    );
    const index = buildHostedIndex([candidateFor(storeA.root), candidateFor(storeB.root)]);

    expect(
      hostedStoreFor({ sessionId: CONVERSATION, entrypoint: 'claude-desktop' }, index),
    ).toBeUndefined();
  });
});

/**
 * The clocks the identity check compares.
 *
 * `RECORDED_AT` is when the CLI wrote the registry file; `WRITER_STARTED` is when
 * the process it describes was created, a couple of seconds earlier — the order
 * every real record is written in.
 */
const RECORDED_AT = Date.parse('2026-08-24T20:45:00.000Z');
const WRITER_STARTED = RECORDED_AT - 2_000;
const HOUR = 3_600_000;

/** Windows' own clock: 100-nanosecond ticks since 1601, which is what the CLI records. */
function filetime(epochMs: number): string {
  return String((BigInt(epochMs) + 11_644_473_600_000n) * 10_000n);
}

/** A registry file in the shape the CLI actually writes one. */
function recordAsWritten(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 4242,
    sessionId: CONVERSATION,
    cwd: 'C:\\work\\thing',
    startedAt: RECORDED_AT,
    procStart: filetime(WRITER_STARTED),
    version: '2.1.237',
    kind: 'interactive',
    ...over,
  };
}

function process_(over: Partial<ProcessRow> & { pid: number }): ProcessRow {
  return {
    parentPid: 1,
    name: 'claude.exe',
    path: 'D:\\roaming\\Claude\\claude-code\\2.1.237\\claude.exe',
    commandLine: '',
    startedAt: WRITER_STARTED,
    ...over,
  };
}

/** The default check, against a given table, with liveness forced — the pid always answers. */
function against(rows: ProcessRow[]) {
  return writerAliveWith(
    () => rows,
    () => true,
  );
}

describe('a pid that answers but is not the writer', () => {
  it('does not count as live when the process is younger than the record', () => {
    // The case that put this here: after a reboot, pids get handed out again from
    // the bottom, and a day-old registry lands on whatever took the number.
    const root = registryWith([recordAsWritten({ pid: 7272 })]);
    const rows = [
      process_({ pid: 7272, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 12 * HOUR }),
    ];

    expect(liveSessions([root], against(rows))).toEqual([]);
  });

  it('does not count when another claude took the pid', () => {
    // The name proves nothing: the desktop app, its Code sessions, and every
    // other session on the machine are all claude.exe. Only the creation time
    // separates this pid from the one the record was written for.
    const root = registryWith([recordAsWritten({ pid: 21944 })]);
    const anotherSession = [process_({ pid: 21944, startedAt: RECORDED_AT + 9 * HOUR })];

    expect(liveSessions([root], against(anotherSession))).toEqual([]);
  });

  it('does not count when the pid is the desktop app rather than a session', () => {
    // A record with no creation time to check falls back to what the process is,
    // and the app the CLI runs under is claude.exe too.
    const root = registryWith([recordAsWritten({ pid: 21944, procStart: undefined })]);
    const desktop = [
      process_({
        pid: 21944,
        path: 'C:\\Program Files\\WindowsApps\\Claude_1.34493.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe',
        startedAt: WRITER_STARTED,
      }),
    ];

    expect(liveSessions([root], against(desktop))).toEqual([]);
  });

  it('does not count when a record without a creation time is older than its process', () => {
    // The weaker check for older records: the CLI writes the file moments after
    // starting, so a process that started afterwards cannot be the one it names.
    const root = registryWith([recordAsWritten({ procStart: undefined })]);
    const younger = [process_({ pid: 4242, startedAt: RECORDED_AT + HOUR })];

    expect(liveSessions([root], against(younger))).toEqual([]);
  });
});

describe('a pid that is still its writer', () => {
  it('counts when the creation times match', () => {
    const root = registryWith([recordAsWritten()]);
    const rows = [process_({ pid: 4242 })];

    const live = liveSessions([root], against(rows));
    expect(live).toHaveLength(1);
    expect(live[0]?.identity.procStartedAt).toBe(WRITER_STARTED);
  });

  it('reads the creation time Windows actually reports', () => {
    // Both sides of the comparison come from the same clock but through different
    // formats — FILETIME ticks in the record, an ISO timestamp in the process
    // table. This pair was taken off a running session on Windows 11.
    const root = registryWith([recordAsWritten({ procStart: '134321318964741541' })]);
    const rows = [process_({ pid: 4242, startedAt: Date.parse('2026-08-25T11:44:56.4741540Z') })];

    expect(liveSessions([root], against(rows))).toHaveLength(1);
  });

  it('counts a record with no creation time whose process still looks like one', () => {
    const root = registryWith([recordAsWritten({ procStart: undefined })]);
    const rows = [process_({ pid: 4242 })];

    expect(liveSessions([root], against(rows))).toHaveLength(1);
  });

  it('counts the entry when the process table could not be read', () => {
    // The registry is what says a conversation has a writer. Disbelieving it
    // because nothing could be checked would drop the fork protection exactly
    // when it cannot be corroborated.
    const root = registryWith([recordAsWritten()]);

    expect(liveSessions([root], against([]))).toHaveLength(1);
  });
});

describe('ending a writer', () => {
  const identity = { pid: 4242, procStartedAt: WRITER_STARTED, recordedAt: RECORDED_AT };

  it('is allowed for the process the record named', () => {
    expect(endableWriter(identity, [process_({ pid: 4242 })])).toEqual({ ok: true });
  });

  it('is refused when the pid has been reused', () => {
    // `foster live --stop` runs taskkill /F /T. Against a recycled pid that is a
    // stranger's process and every child it has.
    const recycled = [
      process_({ pid: 4242, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 12 * HOUR }),
    ];

    const verdict = endableWriter(identity, recycled);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('4242');
    expect(verdict.reason).toContain('postgres.exe');
    expect(verdict.reason).toContain('Windows reuses pids');
  });

  it('is refused when the process could not be identified at all', () => {
    const verdict = endableWriter(identity, []);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('does not kill what it cannot name');
  });

  it('says so plainly where there is no process table to read', () => {
    // An empty table on Windows is a failed read and worth retrying. Anywhere
    // else it is the platform, and the same sentence would send somebody to
    // debug PowerShell on a machine that has none.
    const verdict = endableWriter(identity, [], false);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('only reads the process table on Windows');
  });

  it('is allowed for an older record whose process is consistent with it', () => {
    // No creation time to prove anything with, but nothing contradicts the
    // record either: refusing here would leave those sessions unstoppable.
    const older = { pid: 4242, recordedAt: RECORDED_AT };
    expect(endableWriter(older, [process_({ pid: 4242 })])).toEqual({ ok: true });
  });
});

/**
 * A partial row — everything tasklist reports once wmic and PowerShell have
 * both failed — carries a pid and a name and nothing else: no path, no parent,
 * no creation time. That is the weakest evidence this module ever reasons
 * from, and it must never come out looking stronger than it is: a name alone
 * still proves a stranger, but it can never confirm or even suggest a match,
 * because there is no creation time left to contradict a wrong guess and no
 * parent link left for isSelfHostedBy to see foster's own ancestry with.
 */
describe('a partial row (tasklist)', () => {
  const partialClaude: ProcessRow = {
    pid: 4242,
    parentPid: 0,
    name: 'claude.exe',
    path: '',
    commandLine: '',
    partial: true,
  };
  const partialGit: ProcessRow = {
    pid: 4242,
    parentPid: 0,
    name: 'git.exe',
    path: '',
    commandLine: '',
    partial: true,
  };

  it('refuses to end a claude.exe row even when the record carries a creation time', () => {
    const identity = { pid: 4242, procStartedAt: WRITER_STARTED, recordedAt: RECORDED_AT };
    const verdict = endableWriter(identity, [partialClaude]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('tasklist');
    expect(verdict.reason).toContain('creation time');

    // The registry still says a writer exists, and nothing here contradicts
    // it — fork protection must not fall away just because the table is thin.
    expect(against([partialClaude])(4242, identity)).toBe(true);
  });

  it('refuses a claude.exe row even for a record with no creation time to compare at all', () => {
    // The weaker check other records fall back to ('plausible') must never be
    // reached here: with no path and no parent link, foster cannot tell this
    // pid apart from itself, let alone from a stranger.
    const identity = { pid: 4242, recordedAt: RECORDED_AT };
    const verdict = endableWriter(identity, [partialClaude]);
    expect(verdict.ok).toBe(false);
  });

  it('still recognises an unrelated process name as a stranger', () => {
    const identity = { pid: 4242, procStartedAt: WRITER_STARTED, recordedAt: RECORDED_AT };
    const verdict = endableWriter(identity, [partialGit]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('4242');
    expect(verdict.reason).toContain('git.exe');
    expect(verdict.reason).toContain('Windows reuses pids');

    expect(against([partialGit])(4242, identity)).toBe(false);
  });
});

describe('pruning the registry', () => {
  /** The companion file a session leaves beside its record. */
  function peerKey(root: string, pid: number, body: Record<string, unknown> | string): string {
    const file = path.join(root, `${pid}.hash${pid}.key`);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return file;
  }

  function keyFor(startedAt = WRITER_STARTED): Record<string, unknown> {
    return { peerToken: 'f'.repeat(32), procStartFt: filetime(startedAt) };
  }

  it('lists only files that are provably over', () => {
    const root = registryWith([
      recordAsWritten({ pid: 4242 }),
      recordAsWritten({ pid: 7272, sessionId: '00000000-0000-4000-8000-0000000000e2' }),
      recordAsWritten({ pid: 9999, sessionId: '00000000-0000-4000-8000-0000000000e3' }),
    ]);
    const rows = [
      process_({ pid: 4242 }),
      process_({ pid: 7272, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 12 * HOUR }),
    ];

    const stale = staleRegistryEntries(
      [root],
      (pid) => pid !== 9999,
      () => rows,
    );

    expect(stale.map((item) => item.pid).sort()).toEqual([7272, 9999]);
    expect(stale.find((item) => item.pid === 9999)?.why).toContain('gone');
    expect(stale.find((item) => item.pid === 7272)?.why).toContain('postgres.exe');
    expect(stale.find((item) => item.pid === 7272)?.sessionId).toBe(
      '00000000-0000-4000-8000-0000000000e2',
    );
  });

  it('takes the peer keys left beside them', () => {
    // The CLI clears records it finds stale but not the keys, so these are what a
    // long-running machine is actually full of. They carry the same creation time
    // the record does, which is what makes them answerable rather than guesswork.
    const root = registryWith([]);
    peerKey(root, 4242, keyFor());
    peerKey(root, 9999, keyFor());

    const stale = staleRegistryEntries(
      [root],
      (pid) => pid !== 9999,
      () => [process_({ pid: 4242 })],
    );

    expect(stale).toHaveLength(1);
    expect(stale[0]?.pid).toBe(9999);
    expect(stale[0]?.sessionId).toBeUndefined();
  });

  it('takes a peer key whose pid now belongs to somebody else', () => {
    const root = registryWith([]);
    peerKey(root, 7272, keyFor());
    const rows = [
      process_({ pid: 7272, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 12 * HOUR }),
    ];

    expect(
      staleRegistryEntries(
        [root],
        () => true,
        () => rows,
      ),
    ).toHaveLength(1);
  });

  it('keeps a peer key it cannot read', () => {
    // Nothing is inferred about a file that did not parse. It is somebody else's
    // format, and the only claim ever made about one is that the process it names
    // is gone.
    const root = registryWith([]);
    peerKey(root, 9999, '{');

    expect(
      staleRegistryEntries(
        [root],
        () => false,
        () => [],
      ),
    ).toEqual([]);
  });

  it('keeps what it cannot identify', () => {
    // Deleting on suspicion would strip the fork protection from a conversation
    // that still has a writer.
    const root = registryWith([recordAsWritten()]);
    peerKey(root, 4242, keyFor());

    expect(
      staleRegistryEntries(
        [root],
        () => true,
        () => [],
      ),
    ).toEqual([]);
  });

  it('removes the files it listed and leaves the rest', () => {
    const root = registryWith([
      recordAsWritten({ pid: 4242 }),
      recordAsWritten({ pid: 7272, sessionId: '00000000-0000-4000-8000-0000000000e2' }),
    ]);
    peerKey(root, 4242, keyFor());
    peerKey(root, 7272, keyFor());
    const rows = [
      process_({ pid: 4242 }),
      process_({ pid: 7272, name: 'postgres.exe', path: '', startedAt: RECORDED_AT + 12 * HOUR }),
    ];

    const stale = staleRegistryEntries(
      [root],
      () => true,
      () => rows,
    );
    const { removed, failed } = pruneRegistry(stale);

    expect(failed).toEqual([]);
    expect(removed).toHaveLength(2);
    expect(existsSync(path.join(root, '0.json'))).toBe(true);
    expect(existsSync(path.join(root, '4242.hash4242.key'))).toBe(true);
    expect(existsSync(path.join(root, '1.json'))).toBe(false);
    expect(existsSync(path.join(root, '7272.hash7272.key'))).toBe(false);
  });
});

describe('liveBranchNote', () => {
  it('names each writer, because "finish there" needs a there', () => {
    const note = liveBranchNote([{ pid: 3848, cwd: 'C:/work/foster' }]);

    expect(note).toContain('1 of these is being written');
    expect(note).toContain('pid 3848');
    expect(note).toContain('C:/work/foster');
    expect(note).toContain('foster live --stop');
  });

  it('says which one is the session running foster', () => {
    const note = liveBranchNote([{ pid: 3848, cwd: 'C:/work/foster', isSelf: true }]);

    expect(note).toContain('this one, running foster');
  });

  it('reads as a plural when there are several, and admits an unknown directory', () => {
    const note = liveBranchNote([{ pid: 1 }, { pid: 2 }]);

    expect(note).toContain('2 of these are being written');
    expect(note).toContain('(unknown directory)');
  });
});
