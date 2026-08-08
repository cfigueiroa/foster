import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { log, select } from '@clack/prompts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Safety from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { accountDir } from '../src/domain/paths.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/** Scripted answers, consumed in order by the mocked prompts. */
let answers: unknown[] = [];
const CANCELLED = Symbol('cancelled');

vi.mock('@clack/prompts', () => {
  const next = () => Promise.resolve(answers.shift());
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    select: vi.fn(next),
    confirm: vi.fn(next),
    text: vi.fn(next),
    multiselect: vi.fn(next),
    isCancel: (value: unknown) => value === CANCELLED,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      message: vi.fn(),
    },
  };
});

// The real probe reports whatever Claude Desktop is doing on the machine running
// the tests, which has nothing to do with the flow under test. Both entry points
// are replaced: assertRemovable calls the module's own lockfile check internally,
// so overriding only the export would leave the engine's gate live.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertRemovable: () => {},
  };
});

// Nothing in a test may close or launch the real Claude Desktop. Stubbed rather
// than trusted: a scripted answer that drifted by one step could otherwise pick
// "Restart it" and take down the machine's running app mid-suite.
vi.mock('../src/engine/desktop.js', () => ({
  inspectDesktop: () => ({ running: false, codeSessions: 0, selfHosted: false }),
  quitDesktop: () => Promise.resolve({ outcome: 'not-running' }),
  startDesktop: () => Promise.resolve(true),
  packagedAppId: () => undefined,
  runningStores: () => [],
  readProcesses: () => [],
  hostedByDesktop: () => false,
  DesktopControlError: class extends Error {},
}));

const { runInteractive } = await import('../src/cli/interactive.js');

let store: StoreLayout;
let ledger: Ledger;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-int-')), 'l.jsonl'));
  // The current account must exist as a directory to be resolvable as a target.
  writeSession(store, NEW_ACCOUNT, session({ sessionId: '11111111-1111-4111-8111-11111111aaaa' }));
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000a1', title: 'Refactor parser' }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: '00000000-0000-4000-8000-0000000000a2', title: 'Fix the build' }),
  );
});

describe('the guided menu', () => {
  it('fosters a whole account and returns to the menu afterwards', async () => {
    answers = [
      'foster', // menu
      ['0'], // source: the old account's only organization
      'all', // take every session
      'go', // confirm
      'later', // decline the offer to restart the app

      'quit', // back at the menu
    ];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(2);
    expect(listActive(project(ledger.read()))).toHaveLength(2);
    expect(answers).toHaveLength(0);
  });

  it('narrows the batch by title before writing', async () => {
    answers = ['foster', ['0'], 'title', 'refactor', 'go', 'later', 'quit'];

    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Refactor parser');
  });

  it('writes nothing when the confirmation is declined, and keeps the menu open', async () => {
    answers = [
      'foster',
      ['0'],
      'all',
      'cancel', // decline
      'status', // menu is still running
      'quit',
    ];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('backing out of the source picker returns to the menu instead of exiting', async () => {
    // Ticking nothing is how you leave a multiselect: there is no Back row to press.
    answers = ['foster', [], 'quit'];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('returns fostered copies, leaving the origin untouched', async () => {
    answers = ['foster', ['0'], 'all', 'go', 'later', 'return', 'all', true, 'later', 'quit'];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(listActive(project(ledger.read()))).toHaveLength(0);
    expect(scanAccount(store, OLD_ACCOUNT)).toHaveLength(2);
    // Asserted explicitly: an empty active list is also what a run that never
    // fostered anything would produce, so it proves nothing on its own.
    expect(ledger.read().filter((event) => event.kind === 'returned')).toHaveLength(2);
  });

  it('treats Ctrl+C at the menu as quit', async () => {
    answers = [CANCELLED];

    await expect(runInteractive(store, ledger)).resolves.toBeUndefined();
  });
});

/**
 * An account can hold more than one organization, and the sidebar only ever reads
 * one of them. Taking the whole account and taking a single organization are both
 * legitimate, and sessions filed under a second organization of the *current*
 * account are just as invisible as another account's.
 */
describe('organizations within an account', () => {
  const OTHER_ORG = {
    accountUuid: OLD_ACCOUNT.accountUuid,
    organizationUuid: '00000000-0000-4000-8000-00000000000f',
  };
  const SIBLING_ORG = {
    accountUuid: NEW_ACCOUNT.accountUuid,
    organizationUuid: '11111111-1111-4111-8111-11111111000f',
  };

  it('fosters a single organization without dragging in the rest of the account', async () => {
    writeSession(
      store,
      OTHER_ORG,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b1', title: 'Second org work' }),
    );

    // 0 = the whole account, 1 = its first organization, 2 = its second.
    answers = ['foster', ['2'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Second org work');
  });

  it('offers a shortcut that takes every organization of the account', async () => {
    writeSession(
      store,
      OTHER_ORG,
      session({ sessionId: '00000000-0000-4000-8000-0000000000b2', title: 'Second org work' }),
    );

    answers = ['foster', ['0'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    // Two from the first organization plus one from the second.
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(3);
  });

  it('can foster from another organization of the account already signed in', async () => {
    writeSession(
      store,
      SIBLING_ORG,
      session({ sessionId: '11111111-1111-4111-8111-1111111100b3', title: 'Sibling org work' }),
    );
    // Which organization the sidebar reads is inferred from how recently the app
    // touched its directory, so the target has to be the newer one here — as it
    // would be in practice, since that is the one being written to.
    const target = accountDir(store, NEW_ACCOUNT);
    const later = new Date(Date.now() + 60_000);
    utimesSync(target, later, later);

    // 0 = every account at once, 1 = the old account's organization, 2 = this
    // account's other organization. Both accounts contribute one eligible
    // organization, so neither gets the whole-account shortcut. The sibling must
    // be offered at all: excluding the entire current account would make that
    // session permanently unreachable.
    answers = ['foster', ['2'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Sibling org work');
  });

  it('never offers the directory the sidebar already reads', async () => {
    // Only the old account's single organization is a valid source here, so any
    // index beyond the first would mean the target itself was on the list.
    answers = ['foster', ['1'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });
});

/**
 * The scan below this screen always took a list of directories, so being able to
 * name only one of them was a limit of the picker alone: consolidating three
 * accounts meant three passes through the whole flow.
 */
describe('taking more than one source at once', () => {
  const THIRD_ACCOUNT = {
    accountUuid: '22222222-2222-4222-8222-222222222221',
    organizationUuid: '22222222-2222-4222-8222-222222222222',
  };

  it('sweeps every account in one pass', async () => {
    writeSession(
      store,
      THIRD_ACCOUNT,
      session({ sessionId: '22222222-2222-4222-8222-2222222200c1', title: 'Third account work' }),
    );

    // 0 = the row that stands for both accounts.
    answers = ['foster', ['0'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(3);
    expect(copies.map((c) => c.data.title)).toContainEqual(
      expect.stringContaining('Third account work'),
    );
  });

  it('counts a directory once when the account and its organization are both ticked', async () => {
    writeSession(
      store,
      {
        accountUuid: OLD_ACCOUNT.accountUuid,
        organizationUuid: '00000000-0000-4000-8000-00000000000f',
      },
      session({ sessionId: '00000000-0000-4000-8000-0000000000c2', title: 'Second org work' }),
    );

    // 0 = the whole account, 1 = its first organization: overlapping, not
    // contradictory, and the overlap must not produce a second copy.
    answers = ['foster', ['0', '1'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(3);
  });

  it('refuses to read this installation and another one in the same pass', async () => {
    answers = ['foster', ['0', '__other_store'], 'quit'];
    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(vi.mocked(log.error).mock.calls.flat()).toContainEqual(
      expect.stringMatching(/one installation at a time/i),
    );
    expect(answers).toHaveLength(0);
  });
});

describe('backing out of any step', () => {
  /**
   * The "Back" entry carries a string, while callers checked for a symbol. The
   * filter step checked only the symbol, so the literal fell through and was used
   * as a lookup key — the menu crashed with "Cannot read properties of undefined".
   */
  it('returns to the menu from the filter step instead of crashing', async () => {
    answers = ['foster', ['0'], '__back', 'quit'];

    await expect(runInteractive(store, ledger)).resolves.toBeUndefined();

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('returns to the menu from the destination step', async () => {
    // A second destination has to exist for the step to be asked at all.
    writeSession(
      store,
      {
        accountUuid: NEW_ACCOUNT.accountUuid,
        organizationUuid: '11111111-1111-4111-8111-1111111100dd',
      },
      session({ sessionId: '11111111-1111-4111-8111-1111111100de' }),
    );
    const active = accountDir(store, NEW_ACCOUNT);
    const later = new Date(Date.now() + 60_000);
    utimesSync(active, later, later);

    answers = ['foster', ['0'], '__back', 'quit'];

    await expect(runInteractive(store, ledger)).resolves.toBeUndefined();
    expect(answers).toHaveLength(0);
  });
});

describe('choosing where the copies go', () => {
  const ELSEWHERE = {
    accountUuid: OLD_ACCOUNT.accountUuid,
    organizationUuid: '00000000-0000-4000-8000-0000000000e1',
  };

  it('can write into an organization other than the one in use', async () => {
    // ELSEWHERE is a second organization of the old account: available as a
    // destination precisely because it is not the source and not the target.
    writeSession(store, ELSEWHERE, session({ sessionId: '00000000-0000-4000-8000-0000000000e2' }));

    // Source = the old account's first organization (index 1, after the
    // whole-account shortcut at 0). The destination picker is keyed by
    // account/organization rather than by position, so it is named outright.
    const destination = `${ELSEWHERE.accountUuid}/${ELSEWHERE.organizationUuid}`;
    answers = ['foster', ['1'], 'all', 'elsewhere', destination, 'go', 'quit'];
    await runInteractive(store, ledger);

    // Nothing landed where the sidebar reads; it all went to the chosen place.
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(scanAccount(store, ELSEWHERE).filter((s) => s.isCopy)).toHaveLength(2);
  });

  it('does not ask when the current directory is the only destination', async () => {
    // Only the old account's organization is a source, and nothing else exists,
    // so the flow must not consume an answer for a question with one option.
    answers = ['foster', ['0'], 'all', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(2);
    expect(answers).toHaveLength(0);
  });
});

describe('picking sessions individually', () => {
  it('takes only the ticked ones', async () => {
    // Sessions are offered most recently used first, so index 0 is deterministic.
    answers = ['foster', ['0'], 'pick', ['0'], 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
    expect(answers).toHaveLength(0);
  });

  it('treats ticking nothing as a change of mind rather than a batch of zero', async () => {
    answers = ['foster', ['0'], 'pick', [], 'quit'];
    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });
});

describe('the confirmation screen', () => {
  it('changes the prefix without leaving it', async () => {
    answers = ['foster', ['0'], 'all', 'prefix', '[old] ', 'go', 'later', 'quit'];
    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(copy.data.title).toMatch(/^\[old] /);
  });

  it('writes nothing when the answer is one it does not understand', async () => {
    // A prompt that returns something unexpected used to spin the loop forever.
    answers = ['foster', ['0'], 'all', 'something-else', 'quit'];

    await expect(runInteractive(store, ledger)).resolves.toBeUndefined();
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });
});

describe('naming an account', () => {
  it('records the label and uses it afterwards', async () => {
    answers = ['label', OLD_ACCOUNT.accountUuid, 'the old one', 'quit'];
    await runInteractive(store, ledger);

    expect(project(ledger.read()).labels.get(OLD_ACCOUNT.accountUuid)).toBe('the old one');
  });

  it('keeps the old name when the answer is blank', async () => {
    answers = ['label', OLD_ACCOUNT.accountUuid, '   ', 'quit'];
    await runInteractive(store, ledger);

    expect(project(ledger.read()).labels.has(OLD_ACCOUNT.accountUuid)).toBe(false);
  });

  it('does not turn an empty submission into the word "undefined"', async () => {
    // clack resolves an empty text prompt as undefined rather than '', which a
    // String() once coerced into a name that passed every emptiness check.
    answers = ['label', OLD_ACCOUNT.accountUuid, undefined, 'quit'];
    await runInteractive(store, ledger);

    expect(project(ledger.read()).labels.has(OLD_ACCOUNT.accountUuid)).toBe(false);
  });
});

describe('the main menu', () => {
  it('leaves rather than looping when the answer is unrecognised', async () => {
    // Exhausting the scripted answers yields undefined, which matches no case.
    answers = ['not-a-menu-entry'];

    await expect(runInteractive(store, ledger)).resolves.toBeUndefined();
  });
});

describe('bringing sessions from another installation', () => {
  /**
   * A second profile is a whole separate store. Nothing in the store foster
   * resolved points at it, so the menu has to offer it explicitly — and the copy
   * has to record which store it came from.
   */
  it('fosters across stores and records the origin', async () => {
    const other = makeStore();
    writeFileSync(
      other.configFile,
      JSON.stringify({ lastKnownAccountUuid: OLD_ACCOUNT.accountUuid }),
      'utf8',
    );
    writeSession(
      other,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000d1', title: 'In the other profile' }),
    );

    answers = [
      'foster',
      ['__other_store'], // "Another installation or profile…"
      '__type_a_path', // not running, so type where it lives
      other.root,
      ['0'], // its only account/organization
      'all',
      'go',
      'later',
      'quit',
    ];
    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('In the other profile');
    expect(copies[0]!.data._foster!.originStore).toBe(other.root);
    // The other store is left exactly as it was.
    expect(scanAccount(other, OLD_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
  });

  it('comes back to the menu when the path is not a store', async () => {
    answers = [
      'foster',
      ['__other_store'],
      '__type_a_path',
      mkdtempSync(path.join(tmpdir(), 'not-a-store-')),
      'quit',
    ];

    await expect(runInteractive(store, ledger)).resolves.toBeUndefined();
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });
});

describe('working on another installation', () => {
  /**
   * Reading from another profile was already possible; acting in one meant
   * quitting and relaunching with --store, which is a strange thing to ask of a
   * menu that stays open on purpose.
   */
  it('points the whole menu at the other store', async () => {
    const other = makeStore();
    writeFileSync(
      other.configFile,
      JSON.stringify({ lastKnownAccountUuid: OLD_ACCOUNT.accountUuid }),
      'utf8',
    );
    writeSession(
      other,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000f1' }),
    );
    // A second account in that store, to foster from once we are there.
    writeSession(
      other,
      NEW_ACCOUNT,
      session({ sessionId: '11111111-1111-4111-8111-1111111100f2' }),
    );

    answers = [
      'installation',
      '__type_a_path',
      other.root,
      'foster', // now operating inside the other store
      ['0'],
      'all',
      'go',
      'later',
      'quit',
    ];
    await runInteractive(store, ledger);

    // The copies landed in the other store, and the one we started in is untouched.
    expect(scanAccount(other, OLD_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(1);
    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('refuses a store nobody has signed into, and stays where it was', async () => {
    const empty = makeStore();

    answers = ['installation', '__type_a_path', empty.root, 'quit'];
    await runInteractive(store, ledger);

    expect(answers).toHaveLength(0);
  });

  it('offers a store it has worked in before, instead of asking for the path again', async () => {
    // A stopped profile announces itself nowhere: not in the environment, not in
    // the process table. The ledger is the one place it is written down.
    const other = makeStore();
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_00000000-0000-4000-8000-0000000000e1',
      origin: OLD_ACCOUNT,
      target: NEW_ACCOUNT,
      copySessionId: 'local_00000000-0000-4000-8000-0000000000e2',
      copyPath: path.join(
        accountDir(other, NEW_ACCOUNT),
        'local_00000000-0000-4000-8000-0000000000e2.json',
      ),
      prefix: '',
    });

    answers = ['installation', other.root, 'quit'];
    await runInteractive(store, ledger);

    expect(offeredBy('Work on which installation?')).toContain(other.root);
  });
});

/** The values a scripted screen actually offered, for asserting on a menu. */
function offeredBy(message: string): string[] {
  const calls = vi.mocked(select).mock.calls as unknown as Array<
    [{ message: string; options: Array<{ value: string }> }]
  >;
  // The mock is shared across the file, so its calls accumulate: the screen this
  // test opened is the last one with that message, not the first.
  const prompt = calls.map(([only]) => only).findLast((arg) => arg.message === message);
  return (prompt?.options ?? []).map((option) => option.value);
}
