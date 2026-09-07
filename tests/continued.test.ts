import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { continuedNote, continuedSince } from '../src/engine/continued.js';
import { fosterSessions } from '../src/engine/executor.js';
import { Ledger } from '../src/ledger/log.js';
import { listActive, project } from '../src/ledger/project.js';
import { scanAccount } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * Work done in a copy lands in the conversation, which both accounts share, but
 * the card in the original account is frozen at the moment of the foster. After
 * a return the row therefore comes back wearing an old date, which reads exactly
 * like the work being rolled back. This is what lets foster say otherwise.
 */

const CARD_AT = 1_700_000_000_000;
const CLI_ID = '00000000-0000-4000-8000-0000000000b7';

function seed(): { store: StoreLayout; ledger: Ledger } {
  const store = makeStore();
  writeSession(
    store,
    OLD_ACCOUNT,
    session({
      sessionId: '00000000-0000-4000-8000-0000000000b6',
      cliSessionId: CLI_ID,
      lastActivityAt: CARD_AT,
      title: 'Work',
    }),
  );
  const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-cont-')), 'l.jsonl'));
  fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });
  return { store, ledger };
}

/** A transcript on disk whose last write is `at`. */
function transcript(at: number, id = CLI_ID): NodeJS.ProcessEnv {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-cfg-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, '{}\n', 'utf8');
  utimesSync(file, new Date(at), new Date(at));
  return { CLAUDE_CONFIG_DIR: config };
}

describe('continuedSince', () => {
  it('finds a conversation whose transcript is newer than the original card', () => {
    const { store, ledger } = seed();
    const env = transcript(CARD_AT + 3 * 60 * 60 * 1000);

    const continued = continuedSince(store, listActive(project(ledger.read())), env);
    expect(continued).toHaveLength(1);
    expect(continued[0]!.cardAt).toBe(CARD_AT);
    expect(continued[0]!.transcriptAt).toBeGreaterThan(CARD_AT);
    // The conversation lives in one file, which is by definition all of it, so
    // the original's own card reaches everything there is.
    expect(continued[0]!.reachesFully).toBe(true);
    expect(continuedNote(continued)).toMatch(/Nothing is lost/);
  });

  it('says nothing about a conversation nobody touched since', () => {
    // The two stamps are written by different processes seconds apart, so exact
    // equality is not the test — anything inside a minute is "not continued".
    const { store, ledger } = seed();
    const env = transcript(CARD_AT + 10_000);

    expect(continuedSince(store, listActive(project(ledger.read())), env)).toEqual([]);
  });

  it('reads the conversation id off the copy when the ledger predates it', () => {
    // Entries written before the ledger kept cliSessionId still have to work:
    // this is exactly the ledger of anyone who fostered before this release.
    const { store, ledger } = seed();
    const env = transcript(CARD_AT + 3 * 60 * 60 * 1000);
    const [active] = listActive(project(ledger.read()));
    const withoutId = { ...active! };
    delete withoutId.cliSessionId;

    expect(continuedSince(store, [withoutId], env)).toHaveLength(1);
  });

  it('says nothing when the conversation is not on disk', () => {
    const { store, ledger } = seed();
    const config = mkdtempSync(path.join(tmpdir(), 'foster-cfg-'));
    mkdirSync(path.join(config, 'projects'), { recursive: true });

    expect(
      continuedSince(store, listActive(project(ledger.read())), { CLAUDE_CONFIG_DIR: config }),
    ).toEqual([]);
  });

  it('says nothing when the original card is gone', () => {
    // Nothing to be confused by: there is no stale row to explain.
    const { ledger } = seed();
    const env = transcript(CARD_AT + 3 * 60 * 60 * 1000);
    const other = makeStore();

    expect(continuedSince(other, listActive(project(ledger.read())), env)).toEqual([]);
  });
});

/**
 * #49's second half: `continuedNote` used to say "nothing is lost" whenever a
 * stale card was found, with no check that the original's own working
 * directory could actually open the fuller transcript. It cannot when the
 * conversation continued in a directory the original never named — #36
 * established that one `cliSessionId` can occupy more than one file, and a card
 * opens only the one under the project directory for its own `cwd`.
 */
describe('#49: the reassurance is gated on reach', () => {
  const CLI_ID_2 = '00000000-0000-4000-8000-0000000000c1';
  const ORIGIN_2 = '00000000-0000-4000-8000-0000000000c2';
  const SHARED = '00000000-0000-4000-8000-0000000000c3';
  const REPO_ONLY = '00000000-0000-4000-8000-0000000000c5';
  const TREE = 'C:\\work\\project\\.claude\\worktrees\\w';
  const REPO = 'C:\\work\\project';

  /**
   * Two files for one conversation: the worktree's, frozen at the point the
   * work moved on, and the repository's, which kept growing — so the
   * repository's file is a strict superset of the worktree's, the way a
   * conversation that genuinely continued elsewhere looks on disk.
   */
  function multiFileEnv(at: number): NodeJS.ProcessEnv {
    const config = mkdtempSync(path.join(tmpdir(), 'foster-cont2-'));
    const treeDir = path.join(config, 'projects', 'C--work-project--claude-worktrees-w');
    const repoDir = path.join(config, 'projects', 'C--work-project');
    mkdirSync(treeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const treeFile = path.join(treeDir, `${CLI_ID_2}.jsonl`);
    const repoFile = path.join(repoDir, `${CLI_ID_2}.jsonl`);
    writeFileSync(treeFile, JSON.stringify({ uuid: SHARED }), 'utf8');
    writeFileSync(
      repoFile,
      [SHARED, REPO_ONLY].map((uuid) => JSON.stringify({ uuid })).join('\n'),
      'utf8',
    );
    utimesSync(treeFile, new Date(at), new Date(at));
    utimesSync(repoFile, new Date(at), new Date(at));
    return { CLAUDE_CONFIG_DIR: config };
  }

  function seedInTree(): { store: StoreLayout; ledger: Ledger } {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: ORIGIN_2,
        cliSessionId: CLI_ID_2,
        cwd: TREE,
        originCwd: TREE,
        lastActivityAt: CARD_AT,
        title: 'Work',
      }),
    );
    const ledger = new Ledger(
      path.join(mkdtempSync(path.join(tmpdir(), 'foster-cont2-l-')), 'l.jsonl'),
    );
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });
    return { store, ledger };
  }

  it('marks a fostering whose origin cwd cannot reach the fuller file', () => {
    const { store, ledger } = seedInTree();
    const env = multiFileEnv(CARD_AT + 3 * 60 * 60 * 1000);

    const continued = continuedSince(store, listActive(project(ledger.read())), env);

    expect(continued).toHaveLength(1);
    expect(continued[0]!.reachesFully).toBe(false);
  });

  it('does not say "nothing is lost" for one that cannot reach it', () => {
    const { store, ledger } = seedInTree();
    const env = multiFileEnv(CARD_AT + 3 * 60 * 60 * 1000);
    const continued = continuedSince(store, listActive(project(ledger.read())), env);

    expect(continuedNote(continued)).not.toMatch(/Nothing is lost/);
  });

  it('still says everything comes back when the origin cwd is the one that carried on', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({
        sessionId: ORIGIN_2,
        cliSessionId: CLI_ID_2,
        cwd: REPO,
        originCwd: REPO,
        lastActivityAt: CARD_AT,
        title: 'Work',
      }),
    );
    const ledger = new Ledger(
      path.join(mkdtempSync(path.join(tmpdir(), 'foster-cont2-l2-')), 'l.jsonl'),
    );
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });
    const env = multiFileEnv(CARD_AT + 3 * 60 * 60 * 1000);

    const continued = continuedSince(store, listActive(project(ledger.read())), env);

    expect(continued[0]!.reachesFully).toBe(true);
    expect(continuedNote(continued)).toMatch(/Nothing is lost/);
  });
});
