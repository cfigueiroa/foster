import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDuplicates } from '../src/engine/duplicates.js';
import { FOLLOWED_BRANCH, fosterSessions } from '../src/engine/executor.js';
import { lineageAt } from '../src/engine/lineage.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, listRepointed, project } from '../src/ledger/project.js';
import { selectReturnTargets } from '../src/ops/active.js';
import { conversationRoot } from '../src/store/transcripts.js';
import { scanAccount } from '../src/store/scanner.js';
import type { CodeSessionData, StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * A branch is one piece of work wearing two identifiers.
 *
 * The app forks a conversation it cannot continue — something else is writing it —
 * by copying the history into a new transcript and moving the card onto that. The
 * check that keeps one sidebar from showing one conversation twice compares
 * `cliSessionId`, which is precisely the field the fork changes, so the pair walks
 * straight past it. These are the tests for recognising the two halves.
 */

const ROOT = '00000000-0000-4000-8000-0000000000e0';
const ORIGINAL = '00000000-0000-4000-8000-0000000000e1';
const BRANCH = '00000000-0000-4000-8000-0000000000e2';
const UNRELATED = '00000000-0000-4000-8000-0000000000e3';
/** A second fork of the same work, for the case where a card is moved twice. */
const SECOND = '00000000-0000-4000-8000-0000000000f2';

/** A config directory with transcripts in it, as CLAUDE_CONFIG_DIR points at. */
function transcripts(files: Record<string, string[]>): NodeJS.ProcessEnv {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-lin-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  for (const [id, records] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${id}.jsonl`), `${records.join('\n')}\n`, 'utf8');
  }
  return { CLAUDE_CONFIG_DIR: config };
}

/** The app's own bookkeeping, which carries no uuid and is rewritten on every save. */
const META = JSON.stringify({ type: 'custom-title', customTitle: '↪ Work' });

function record(uuid: string): string {
  return JSON.stringify({ uuid, type: 'user', timestamp: '2026-08-06T05:12:01.370Z' });
}

/**
 * One conversation and the branch the app forked out of it.
 *
 * The branch carries the history it was given and then two records of its own,
 * while the original got one more after the fork — the shape a real one has, and
 * the only shape in which "which half carried on?" has an answer. Both halves
 * holding one record each would be a genuine tie, which is a different test.
 */
function forked(): NodeJS.ProcessEnv {
  return transcripts({
    [ORIGINAL]: [META, record(ROOT), record('00000000-0000-4000-8000-0000000000e4')],
    [BRANCH]: [
      META,
      record(ROOT),
      record('00000000-0000-4000-8000-0000000000e5'),
      record('00000000-0000-4000-8000-0000000000ea'),
      record('00000000-0000-4000-8000-0000000000eb'),
    ],
    [UNRELATED]: [META, record('00000000-0000-4000-8000-0000000000e6')],
    // No card points at this one, so it is invisible to every weighing until
    // something moves a card onto it.
    [SECOND]: [META, record(ROOT), record('00000000-0000-4000-8000-0000000000f3')],
  });
}

function projects(env: NodeJS.ProcessEnv): string[] {
  return [path.join(env.CLAUDE_CONFIG_DIR!, 'projects')];
}

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-lin-l-')), 'l.jsonl'));
}

/** The destination already holds the original; the branch waits in the old account. */
function branchWaiting(): { store: StoreLayout; ledger: Ledger } {
  const store = makeStore();
  writeSession(
    store,
    NEW_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000e7', cliSessionId: ORIGINAL }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000e8', cliSessionId: BRANCH }),
  );
  return { store, ledger: ledgerIn() };
}

describe('conversationRoot', () => {
  it('is the first record carrying a uuid, not the first line', () => {
    const env = forked();
    const file = path.join(env.CLAUDE_CONFIG_DIR!, 'projects', '-workspace-project');
    expect(conversationRoot(path.join(file, `${ORIGINAL}.jsonl`))).toBe(ROOT);
  });

  it('is shared by a conversation and the branch forked out of it', () => {
    const kin = lineageAt(projects(forked()));
    expect(kin.sameWork(ORIGINAL, BRANCH)).toBe(true);
    expect(kin.sameWork(ORIGINAL, UNRELATED)).toBe(false);
  });

  it('answers nothing for a conversation with no transcript on disk', () => {
    const kin = lineageAt(projects(forked()));
    expect(kin.rootOf('00000000-0000-4000-8000-0000000000e9')).toBeUndefined();
    // Unanswerable is not "the same": a missing transcript must not make two
    // unrelated conversations collide on undefined.
    expect(kin.sameWork('00000000-0000-4000-8000-0000000000e9', ORIGINAL)).toBe(false);
  });
});

describe('fostering a branch', () => {
  it('refuses a second row for work the account already shows', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.detail).toBe('this account already has a branch of that conversation');
  });

  it('still allows it when the session was named one by one', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
      explicit: true,
    });

    expect(outcomes[0]!.status).toBe('fostered');
  });

  it('does not refuse a conversation that merely has no transcript', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ea', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: '00000000-0000-4000-8000-0000000000eb',
        cliSessionId: '00000000-0000-4000-8000-0000000000ec',
      }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });

    expect(outcomes[0]!.status).toBe('fostered');
  });

  it('brings one row when a sweep finds both halves at once', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ed', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ee', cliSessionId: BRANCH }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });

    expect(outcomes.filter((o) => o.status === 'fostered')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1);
  });

  it('makes the same marks on a dry run as on a real one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000ef', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f0', cliSessionId: BRANCH }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
      dryRun: true,
    });

    expect(outcomes.filter((o) => o.status === 'fostered')).toHaveLength(1);
  });
});

/**
 * What the app does to a copy it cannot continue: it writes the history into a
 * new transcript and moves this card onto it.
 *
 * The marker goes with the save, which is the detail that makes this worth
 * simulating rather than asserting about. The app rebuilds a session from a fixed
 * list of fields, so `_foster` does not survive — and a file read afterwards
 * cannot say who wrote it. Only the ledger can.
 */
function appBranches(copyPath: string, to: string): void {
  const data = JSON.parse(readFileSync(copyPath, 'utf8')) as CodeSessionData;
  delete data._foster;
  writeFileSync(copyPath, JSON.stringify({ ...data, cliSessionId: to }), 'utf8');
}

describe('a copy the app branched', () => {
  /** One card in the destination, holding the original conversation. */
  function fostered(): {
    store: StoreLayout;
    ledger: Ledger;
    projectsDirs: string[];
    copyPath: string;
  } {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f1', cliSessionId: ORIGINAL }),
    );
    const ledger = ledgerIn();
    const projectsDirs = projects(forked());
    const first = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });
    return { store, ledger, projectsDirs, copyPath: first[0]!.copyPath! };
  }

  it('is followed rather than replaced by a second card', () => {
    const { store, ledger, projectsDirs, copyPath } = fostered();
    appBranches(copyPath, BRANCH);

    const again = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    expect(again[0]!.status).toBe('skipped');
    expect(again[0]!.detail).toBe(FOLLOWED_BRANCH);
    // The whole point. Re-minting here is what turned one piece of work into two
    // rows in one sidebar, in the run that was meant to tidy up.
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(1);
    expect(listActive(project(ledger.read()))[0]!.cliSessionId).toBe(BRANCH);
  });

  it('is not offered back as something foster moved', () => {
    const { ledger, projectsDirs, store, copyPath } = fostered();
    appBranches(copyPath, BRANCH);
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    // The app moved this card, not foster. `consolidate --undo` works from this
    // list, and offering to put back a move foster never made would promise
    // something it has no business promising.
    expect(listRepointed(project(ledger.read()))).toHaveLength(0);
  });

  it('settles: sweeping again adds nothing', () => {
    const { store, ledger, projectsDirs, copyPath } = fostered();
    appBranches(copyPath, BRANCH);

    for (let run = 0; run < 3; run++) {
      fosterSessions(scanAccount(store, OLD_ACCOUNT), {
        store,
        ledger,
        target: NEW_ACCOUNT,
        projectsDirs,
      });
    }

    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(1);
    expect(listActive(project(ledger.read()))).toHaveLength(1);
  });

  it('is left out of a bulk return, and still reachable by name', () => {
    const { store, ledger, projectsDirs, copyPath } = fostered();
    appBranches(copyPath, BRANCH);
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    // The card is foster's file, so removing it is within the rules — but what it
    // holds is a conversation born from opening that row, with no other card
    // anywhere. A sweep-wide return would take the work out of every sidebar and
    // leave nothing for `restore`, which only sees what the *app* deleted.
    expect(selectReturnTargets(store, ledger).selected).toHaveLength(0);

    // `return --session` names the origin session, as its own help says.
    const originSessionId = listActive(project(ledger.read()))[0]!.originSessionId;
    expect(
      selectReturnTargets(store, ledger, { sessionIds: [originSessionId] }).selected,
    ).toHaveLength(1);
  });

  it('ends foster’s claim to undo a move the app has overtaken', () => {
    const { store, ledger, projectsDirs, copyPath } = fostered();
    const copy = listActive(project(ledger.read()))[0]!;

    // Consolidate moves the card once, which is a move foster can put back.
    ledger.append({
      kind: 'card_repointed',
      sessionId: copy.copySessionId,
      target: NEW_ACCOUNT,
      path: copyPath,
      from: ORIGINAL,
      to: BRANCH,
      native: false,
    });
    appBranches(copyPath, BRANCH);
    expect(listRepointed(project(ledger.read()))).toHaveLength(1);

    // Then the app forks it again and takes the card somewhere foster never put
    // it. "Put it back where the app had it" no longer describes anything foster
    // is responsible for, and doing it would drop the newest branch's only card.
    appBranches(copyPath, SECOND);
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    expect(listRepointed(project(ledger.read()))).toHaveLength(0);
  });

  it('is replaced when the card holds unrelated work', () => {
    const { store, ledger, projectsDirs, copyPath } = fostered();
    appBranches(copyPath, UNRELATED);

    const again = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    // Not a branch of anything foster brought: the conversation it was fostered
    // for has no card here at all, and writing one is the whole command.
    expect(again[0]!.status).toBe('fostered');
    expect(scanAccount(store, NEW_ACCOUNT)).toHaveLength(2);
  });
});

describe('which half of a fork the account is on', () => {
  it('is counted when the half turned away is the one that carried on', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });

    // The branch holds three records the original never got; the original holds
    // one the branch never got. Refusing it is still right — what was missing is
    // any way to find out that the row being kept is the one that stopped.
    expect(outcomes[0]!.standing).toEqual({
      here: ORIGINAL,
      theirOnly: 3,
      hereOnly: 1,
      ahead: true,
    });
  });

  it('says so without alarm when the account already has the better half', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f5', cliSessionId: BRANCH }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f6', cliSessionId: ORIGINAL }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });

    expect(outcomes[0]!.standing!.ahead).toBe(false);
  });

  it('is left off a session the account simply already has', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f7', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f8', cliSessionId: ORIGINAL }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });

    // Two cards for one conversation open the same transcript. There is no half
    // to be on the wrong side of, and weighing would read whole transcripts to
    // say nothing.
    expect(outcomes[0]!.standing).toBeUndefined();
  });
});

describe('findDuplicates', () => {
  it('reports a branch pair apart from an exact one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d1', cliSessionId: BRANCH }),
    );
    const ledger = ledgerIn();
    // Fostered while the destination had nothing, which is how the pairs already
    // on disk were made: the other half arrived afterwards.
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d2', cliSessionId: ORIGINAL }),
    );

    const report = findDuplicates(
      store,
      listActive(project(ledger.read())),
      lineageAt(projects(forked())),
    );
    expect(report.branches).toHaveLength(1);
    expect(report.copies).toHaveLength(0);
    expect(report.appMade).toBe(0);
  });

  it('keeps one row when both halves are copies, and it is the live one', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d5', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d6', cliSessionId: BRANCH }),
    );
    const ledger = ledgerIn();
    const env = forked();
    const projectsDirs = projects(env);
    // Fostered one at a time, as two accounts' sweeps would have done it before
    // the refusal existed: neither run could see the other half arriving.
    for (const card of scanAccount(store, OLD_ACCOUNT)) {
      fosterSessions([card], { store, ledger, target: NEW_ACCOUNT, projectsDirs, explicit: true });
    }
    // The half that stopped, given the newer file. This is not a contrivance: the
    // app rewrites its bookkeeping into a transcript whenever the card is opened,
    // so the stale half gets a fresh mtime from being looked at — and the rule
    // that used to decide this read exactly that timestamp, which meant clicking
    // the wrong row was enough to make foster keep it.
    const staleFile = path.join(
      env.CLAUDE_CONFIG_DIR!,
      'projects',
      '-workspace-project',
      `${ORIGINAL}.jsonl`,
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(staleFile, later, later);

    const active = listActive(project(ledger.read()));
    const report = findDuplicates(store, active, lineageAt(projectsDirs));

    // Both are copies and each is a branch of the other. Reporting both would be
    // true of each and ruinous together: --branches would take the work out of
    // the sidebar altogether.
    expect(report.branches).toHaveLength(1);
    const removed = new Set(report.branches.map((f) => f.copySessionId));
    const kept = active.filter((f) => !removed.has(f.copySessionId));
    expect(kept).toHaveLength(1);
    // And the survivor is the branch that carried on — measured by the records it
    // holds that the other half never got, not by whichever file was touched last.
    expect(kept[0]!.cliSessionId).toBe(BRANCH);
  });

  it('leaves an unrelated conversation alone', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d3', cliSessionId: UNRELATED }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
    });
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d4', cliSessionId: ORIGINAL }),
    );

    const report = findDuplicates(
      store,
      listActive(project(ledger.read())),
      lineageAt(projects(forked())),
    );
    expect(report.branches).toHaveLength(0);
    expect(report.copies).toHaveLength(0);
  });
});

/**
 * The sweep's branch pass: a row for a branch the account already shows another
 * branch of. Narrower than naming the session — that also brings back a copy
 * the user deleted in the app, and a bulk pass must not.
 */
describe('accepting a branch', () => {
  it('fosters a branch of work the account shows, when asked for branches', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
      acceptBranches: true,
    });

    expect(outcomes[0]!.status).toBe('fostered');
    expect(outcomes[0]!.copyTitle).toBe('Sample session');
  });

  it('still refuses a second card for exactly the conversation the account shows', () => {
    const store = makeStore();
    writeSession(
      store,
      NEW_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000e7', cliSessionId: ORIGINAL }),
    );
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000e8', cliSessionId: ORIGINAL }),
    );

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger: ledgerIn(),
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
      acceptBranches: true,
    });

    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.detail).toBe('this account already has that conversation');
  });

  it('writes the copy archived when told to, and records that as its own decision', () => {
    const { store, ledger } = branchWaiting();

    const outcomes = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs: projects(forked()),
      acceptBranches: true,
      prefix: '(stale) ',
      archive: true,
    });

    expect(outcomes[0]!.copyTitle).toBe('(stale) Sample session');
    const copy = scanAccount(store, NEW_ACCOUNT).find((entry) => entry.isCopy);
    expect(copy!.data.isArchived).toBe(true);
    expect(listActive(project(ledger.read()))[0]!.archivedByFoster).toBe(true);
  });
});

describe('the transcript index', () => {
  it('lists every path a conversation occupies, from the walk the answers share', () => {
    const kin = lineageAt(projects(forked()));

    expect(kin.transcripts().get(ORIGINAL)).toHaveLength(1);
    expect(kin.transcripts().has(SECOND)).toBe(true);
    expect(kin.rootOf(ORIGINAL)).toBe(ROOT);
  });
});

/**
 * The mirror of "a copy the app branched": the card that was copied *from* is
 * the one the app moved.
 *
 * Measured on a real store: 38 of 8312 active fosterings had an origin card
 * holding a conversation other than the one recorded against it. Keyed on the
 * card alone, the ledger answered "already fostered" for work it had never
 * copied — and no sweep, not even one naming the session outright, would bring
 * it. The conversation is what was fostered; the card is only where it was
 * found.
 */
describe('an origin card the app branched', () => {
  function fosteredFrom(): {
    store: StoreLayout;
    ledger: Ledger;
    projectsDirs: string[];
    originPath: string;
  } {
    const store = makeStore();
    const originPath = writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f1', cliSessionId: ORIGINAL }),
    );
    const ledger = ledgerIn();
    const projectsDirs = projects(forked());
    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });
    return { store, ledger, projectsDirs, originPath };
  }

  it('brings the conversation the card now holds, instead of calling it already fostered', () => {
    const { store, ledger, projectsDirs, originPath } = fosteredFrom();
    appBranches(originPath, UNRELATED);

    const again = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    expect(again).toHaveLength(1);
    expect(again[0]!.status).toBe('fostered');
  });

  it('keeps the fostering of the conversation it copied before', () => {
    const { store, ledger, projectsDirs, originPath } = fosteredFrom();
    appBranches(originPath, UNRELATED);

    fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    // Two rows, two fosterings: the second must not evict the first, or the copy
    // already in the sidebar would stop being anything `foster return` knows.
    const active = listActive(project(ledger.read()));
    expect(active).toHaveLength(2);
    expect(active.map((entry) => entry.cliSessionId).sort()).toEqual([ORIGINAL, UNRELATED].sort());
  });

  it('is still skipped when the card holds the conversation it was fostered for', () => {
    const { store, ledger, projectsDirs } = fosteredFrom();

    const again = fosterSessions(scanAccount(store, OLD_ACCOUNT), {
      store,
      ledger,
      target: NEW_ACCOUNT,
      projectsDirs,
    });

    expect(again[0]).toMatchObject({ status: 'skipped', detail: 'already fostered' });
  });
});
