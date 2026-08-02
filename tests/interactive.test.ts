import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Safety from '../src/engine/safety.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
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
// are replaced: assertAppClosed calls the module's own inspectApp internally, so
// overriding only the export would leave the engine's gate live.
vi.mock('../src/engine/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Safety>();
  return {
    ...actual,
    inspectApp: () => ({ running: false, evidence: [] }),
    assertAppClosed: () => {},
  };
});

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
      OLD_ACCOUNT.accountUuid, // source account
      'all', // no filter
      '↪ ', // prefix
      true, // confirm
      'quit', // back at the menu
    ];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(2);
    expect(listActive(project(ledger.read()))).toHaveLength(2);
    expect(answers).toHaveLength(0);
  });

  it('narrows the batch by title before writing', async () => {
    answers = ['foster', OLD_ACCOUNT.accountUuid, 'title', 'refactor', '↪ ', true, 'quit'];

    await runInteractive(store, ledger);

    const copies = scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.data.title).toContain('Refactor parser');
  });

  it('writes nothing when the confirmation is declined, and keeps the menu open', async () => {
    answers = [
      'foster',
      OLD_ACCOUNT.accountUuid,
      'all',
      '↪ ',
      false, // decline
      'status', // menu is still running
      'quit',
    ];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('backing out of the source picker returns to the menu instead of exiting', async () => {
    answers = ['foster', '__back', 'quit'];

    await runInteractive(store, ledger);

    expect(scanAccount(store, NEW_ACCOUNT).filter((s) => s.isCopy)).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('returns fostered copies, leaving the origin untouched', async () => {
    answers = ['foster', OLD_ACCOUNT.accountUuid, 'all', '↪ ', true, 'return', 'all', true, 'quit'];

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
