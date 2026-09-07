import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { uniquePrefix } from '../src/domain/prefix.js';
import { Ledger } from '../src/ledger/log.js';
import { copySessionIds, listActive, project } from '../src/ledger/project.js';
import { applyLabel } from '../src/ops/label.js';
import { fosterableFrom, listFosterable } from '../src/ops/foster.js';
import { partitionByStore, selectReturnTargets } from '../src/ops/active.js';
import { fosterSessions } from '../src/engine/executor.js';
import { lineageAt } from '../src/engine/lineage.js';
import { sidebarOf } from '../src/engine/sidebar.js';
import { scanAccount, scanStore } from '../src/store/scanner.js';
import type { StoreLayout } from '../src/domain/types.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

function ledgerIn(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-ops-')), 'l.jsonl'));
}

describe('uniquePrefix', () => {
  const ids = ['aaaa1111-0000-4000-8000-000000000001', 'bbbb2222-0000-4000-8000-000000000002'];

  it('resolves a unique prefix, case-insensitively', () => {
    const result = uniquePrefix(ids, 'AAAA', (id) => id);
    expect(result).toEqual({ kind: 'one', id: ids[0], items: [ids[0]] });
  });

  it('refuses an ambiguous prefix rather than picking one', () => {
    const result = uniquePrefix(
      ['aaaa1111-0000-4000-8000-000000000001', 'aaaa2222-0000-4000-8000-000000000002'],
      'aaaa',
      (id) => id,
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('says none rather than guessing', () => {
    expect(uniquePrefix(ids, 'ffff', (id) => id)).toEqual({ kind: 'none' });
  });
});

describe('listFosterable', () => {
  it('does not offer a copy that has lost its on-disk marker', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c1' }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });

    const [copy] = listActive(project(ledger.read()));
    const stripped = JSON.parse(readFileSync(copy!.copyPath, 'utf8')) as Record<string, unknown>;
    delete stripped._foster;
    writeFileSync(copy!.copyPath, JSON.stringify(stripped), 'utf8');

    // The destination is the source: a later sweep from NEW would otherwise
    // treat the opened copy as a native session and offer it again.
    const offered = listFosterable(store, [NEW_ACCOUNT], ledger);
    expect(offered.map((s) => s.data.sessionId)).not.toContain(copy!.copySessionId);
  });
});

/**
 * #49 first half: `applyFilter` used to refuse any copy whose conversation still
 * had a card of its own, on identity alone. A copy fostered while the origin
 * card was still there, then opened and continued in a working directory the
 * origin never named, holds records nothing else can reach and was never
 * offered back — `foster list --all --archived` could enumerate every session
 * in every account and still not name it. The fix mirrors #69's correction to
 * `resolveExisting`: ask what the copy reaches beyond the destination, not
 * whether it is the last card left.
 */
describe('#49: a copy that carried on becomes a source', () => {
  const CLI_ID = '00000000-0000-4000-8000-0000000000d1';
  const ORIGIN_ID = '00000000-0000-4000-8000-0000000000d2';
  const COPY_ID = '00000000-0000-4000-8000-0000000000d3';
  const SHARED = '00000000-0000-4000-8000-0000000000d4';
  const REPO_ONLY = '00000000-0000-4000-8000-0000000000d5';
  const TREE = 'C:\\work\\project\\.claude\\worktrees\\w';
  const REPO = 'C:\\work\\project';

  /**
   * Two files for one conversation: the worktree's, where the origin's own card
   * is frozen, and the repository's, which kept growing after the copy was
   * opened elsewhere and the work continued there.
   */
  function multiFileProjectsDirs(): string[] {
    const config = mkdtempSync(path.join(tmpdir(), 'foster-src-'));
    const treeDir = path.join(config, 'projects', 'C--work-project--claude-worktrees-w');
    const repoDir = path.join(config, 'projects', 'C--work-project');
    mkdirSync(treeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(treeDir, `${CLI_ID}.jsonl`), JSON.stringify({ uuid: SHARED }), 'utf8');
    writeFileSync(
      path.join(repoDir, `${CLI_ID}.jsonl`),
      [SHARED, REPO_ONLY].map((uuid) => JSON.stringify({ uuid })).join('\n'),
      'utf8',
    );
    return [path.join(config, 'projects')];
  }

  /**
   * A store with the origin's own card in OLD_ACCOUNT (frozen in the worktree)
   * and a copy in NEW_ACCOUNT — written directly with the `_foster` marker
   * rather than through `fosterSessions`, since what is under test is the shape
   * a copy is left in once it has carried on, not how it got there. `copyCwd`
   * names the repository, the fuller of the two files, the way the app's own
   * rewrite would leave it after the conversation continued there.
   */
  function seed(): { store: StoreLayout } {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: ORIGIN_ID, cliSessionId: CLI_ID, cwd: TREE, originCwd: TREE }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: COPY_ID,
        cliSessionId: CLI_ID,
        cwd: REPO,
        originCwd: REPO,
        _foster: {
          originAccountUuid: OLD_ACCOUNT.accountUuid,
          originOrganizationUuid: OLD_ACCOUNT.organizationUuid,
          originSessionId: `local_${ORIGIN_ID}`,
          fosteredAt: 1_700_000_000_000,
          toolVersion: '0.0.0',
        },
      }),
    );
    return { store };
  }

  it('offers the copy back once it reaches records the origin cannot', () => {
    const { store } = seed();
    const kin = lineageAt(multiFileProjectsDirs());
    const ledger = ledgerIn();
    const copies = copySessionIds(ledger.read());
    const here = sidebarOf(store, OLD_ACCOUNT, copies, kin);

    const offered = fosterableFrom(scanStore(store, copies), [NEW_ACCOUNT], {}, here);

    expect(offered.map((s) => s.data.sessionId)).toContain(`local_${COPY_ID}`);
  });

  it('stays refused without a reach check to ask, exactly as it did before', () => {
    const { store } = seed();
    const ledger = ledgerIn();
    const copies = copySessionIds(ledger.read());

    // No `here` — the old call shape every caller had before #49.
    const offered = fosterableFrom(scanStore(store, copies), [NEW_ACCOUNT], {});

    expect(offered.map((s) => s.data.sessionId)).not.toContain(`local_${COPY_ID}`);
  });

  it('leaves an ordinary copy refused even with a reach check, when it reaches nothing new', () => {
    const store = makeStore();
    // Both cards open the same single file, so the copy is exactly redundant.
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: ORIGIN_ID, cliSessionId: CLI_ID, cwd: REPO, originCwd: REPO }),
    );
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: COPY_ID,
        cliSessionId: CLI_ID,
        cwd: REPO,
        originCwd: REPO,
        _foster: {
          originAccountUuid: OLD_ACCOUNT.accountUuid,
          originOrganizationUuid: OLD_ACCOUNT.organizationUuid,
          originSessionId: `local_${ORIGIN_ID}`,
          fosteredAt: 1_700_000_000_000,
          toolVersion: '0.0.0',
        },
      }),
    );
    const ledger = ledgerIn();
    const copies = copySessionIds(ledger.read());
    const here = sidebarOf(store, OLD_ACCOUNT, copies, lineageAt([]));

    const offered = fosterableFrom(scanStore(store, copies), [NEW_ACCOUNT], {}, here);

    expect(offered.map((s) => s.data.sessionId)).not.toContain(`local_${COPY_ID}`);
  });
});

describe('applyLabel', () => {
  it('records the name against the account a prefix names', () => {
    const ledger = ledgerIn();
    const result = applyLabel(
      ledger,
      '11111111',
      'work',
      [NEW_ACCOUNT.accountUuid, OLD_ACCOUNT.accountUuid],
      OLD_ACCOUNT.accountUuid,
    );
    expect(result).toEqual({ accountUuid: NEW_ACCOUNT.accountUuid, label: 'work' });
    expect(project(ledger.read()).labels.get(NEW_ACCOUNT.accountUuid)).toBe('work');
  });

  it('refuses an empty name', () => {
    const ledger = ledgerIn();
    expect(() =>
      applyLabel(ledger, NEW_ACCOUNT.accountUuid, '   ', [NEW_ACCOUNT.accountUuid], undefined),
    ).toThrow(/must not be empty/);
  });
});

describe('selectReturnTargets', () => {
  it('refuses a session prefix that matches nothing', () => {
    const store = makeStore();
    const ledger = ledgerIn();
    expect(() => selectReturnTargets(store, ledger, { sessionIds: ['ffffffff'] })).toThrow(
      /No fostered copy matches/,
    );
  });

  it('scopes to this store and counts the rest', () => {
    const store = makeStore();
    writeSession(
      store,
      OLD_ACCOUNT,
      session({ sessionId: '00000000-0000-4000-8000-0000000000c2' }),
    );
    const ledger = ledgerIn();
    fosterSessions(scanAccount(store, OLD_ACCOUNT), { store, ledger, target: NEW_ACCOUNT });

    const otherRoot = mkdtempSync(path.join(tmpdir(), 'foster-ops-other-'));
    mkdirSync(path.join(otherRoot, 'claude-code-sessions'), { recursive: true });
    const [active] = listActive(project(ledger.read()));
    const elsewhere = {
      ...active!,
      copyPath: path.join(otherRoot, 'claude-code-sessions', 'gone.json'),
    };

    const { here, elsewhere: other } = partitionByStore([active!, elsewhere], store);
    expect(here).toHaveLength(1);
    expect(other).toHaveLength(1);
  });
});
