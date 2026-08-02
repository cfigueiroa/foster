import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { continuedSince } from '../src/engine/continued.js';
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
