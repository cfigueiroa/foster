import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountDir, layoutFor, sessionPath } from '../src/domain/paths.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../src/domain/types.js';
import type {
  CloudApiError,
  CloudSessionDetail,
  CloudSessionSummary,
  TeleportEvent,
} from '../src/engine/cloudApi.js';
import { pullCloudSession } from '../src/engine/cloudImportWrite.js';
import type { CloudAuthResult } from '../src/store/cloudAuth.js';
import type { ClaudeClient } from '../src/store/clients.js';
import { Ledger } from '../src/ledger/log.js';
import { applyCloudSweep, planCloudSweep, normalizeRepoSlug } from '../src/ops/cloudSweep.js';
import { writeFileAtomic } from '../src/util/fsatomic.js';

const TARGET: AccountRef = {
  accountUuid: '11111111-1111-4111-8111-111111111111',
  organizationUuid: '11111111-1111-4111-8111-111111111112',
};
const OTHER: AccountRef = {
  accountUuid: '22222222-2222-4222-8222-222222222221',
  organizationUuid: '22222222-2222-4222-8222-222222222222',
};

let store: StoreLayout;
let ledger: Ledger;
let repoDir: string;

function client(configDir: string, overrides: Partial<ClaudeClient> = {}): ClaudeClient {
  return {
    configDir,
    isDefault: false,
    inUse: false,
    signedIn: true,
    conversations: 0,
    live: 0,
    ...overrides,
  };
}

function session(overrides: Partial<CloudSessionSummary> = {}): CloudSessionSummary {
  return {
    id: 'cse_00000000000000000000000001',
    title: 'Fix the thing',
    status: 'idle',
    repo: { repo: 'acme/widgets' },
    ...overrides,
  };
}

function writeCard(account: AccountRef, sessionId: string, data: Partial<CodeSessionData>) {
  mkdirSync(accountDir(store, account), { recursive: true });
  const card: CodeSessionData = {
    sessionId,
    cliSessionId: sessionId.replace('local_', ''),
    lastFocusedAt: 1,
    ...data,
  };
  writeFileAtomic(sessionPath(store, account, sessionId), JSON.stringify(card));
}

beforeEach(() => {
  store = layoutFor(mkdtempSync(path.join(tmpdir(), 'foster-cloud-sweep-store-')));
  ledger = new Ledger(
    path.join(mkdtempSync(path.join(tmpdir(), 'foster-cloud-sweep-led-')), 'ledger.jsonl'),
  );
  repoDir = mkdtempSync(path.join(tmpdir(), 'foster-cloud-sweep-repo-'));
});

describe('normalizeRepoSlug', () => {
  it('accepts an already-bare owner/repo', () => {
    expect(normalizeRepoSlug('acme/widgets')).toBe('acme/widgets');
  });

  it('lowercases and strips .git', () => {
    expect(normalizeRepoSlug('Acme/Widgets.git')).toBe('acme/widgets');
  });

  it('reads owner/repo out of an https clone URL', () => {
    expect(normalizeRepoSlug('https://github.com/acme/widgets.git')).toBe('acme/widgets');
  });

  it('reads owner/repo out of an scp-style git@ URL', () => {
    expect(normalizeRepoSlug('git@github.com:acme/widgets.git')).toBe('acme/widgets');
  });

  it('gives up on something that is not a repo reference at all', () => {
    expect(normalizeRepoSlug('not a url')).toBeUndefined();
  });
});

describe('planCloudSweep', () => {
  it('plans a pull from another account into a local checkout whose git remote matches', async () => {
    writeCard(TARGET, 'local_target-1', { cwd: repoDir, originCwd: repoDir });

    const otherConfigDir = mkdtempSync(path.join(tmpdir(), 'foster-cloud-sweep-cfg-'));
    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client(otherConfigDir)],
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: {
            accessToken: 'tok',
            organizationUuid: OTHER.organizationUuid,
            accountUuid: OTHER.accountUuid,
          },
        }),
        listCloudSessions: async () => [session()],
        gitRemoteOrigin: (dir: string) => (dir === repoDir ? 'acme/widgets' : undefined),
      },
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      cloudSessionId: 'cse_00000000000000000000000001',
      into: repoDir,
      sourceAccountUuid: OTHER.accountUuid,
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.accountsNeedingLogin).toEqual([]);
  });

  it('skips the target account itself', async () => {
    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client('/home/target/.claude', { isDefault: true })],
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: {
            accessToken: 'tok',
            organizationUuid: TARGET.organizationUuid,
            accountUuid: TARGET.accountUuid,
          },
        }),
        listCloudSessions: async () => {
          throw new Error('must not be called for the target account');
        },
      },
    });
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('reports an expired credential per account rather than failing the run', async () => {
    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client('/home/other/.claude')],
        readCloudAuth: (): CloudAuthResult => ({ ok: false, reason: 'expired' }),
      },
    });
    expect(plan.accountsNeedingLogin).toHaveLength(1);
    expect(plan.accountsNeedingLogin[0]!.reason).toContain('refresh');
    expect(plan.accountsNeedingLogin[0]!.configDir).toBe('/home/other/.claude');
  });

  it('skips a session already pulled', async () => {
    writeCard(TARGET, 'local_target-1', { cwd: repoDir, originCwd: repoDir });
    // Record the session as already imported by writing through the real
    // pull path once, the same as a previous sweep would have.
    const detail: CloudSessionDetail = {
      id: 'cse_00000000000000000000000001',
      title: 'Fix the thing',
      status: 'idle',
      repo: { repo: 'acme/widgets' },
    };
    pullCloudSession('cse_00000000000000000000000001', detail, [], {
      store,
      ledger,
      state: { imported: new Map(), active: new Map() } as never,
      target: TARGET,
      cwd: repoDir,
      dryRun: false,
      now: 1,
    });

    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client('/home/other/.claude')],
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: { accessToken: 'tok', organizationUuid: OTHER.organizationUuid },
        }),
        listCloudSessions: async () => [session()],
        gitRemoteOrigin: () => 'acme/widgets',
      },
    });
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'already pulled', count: 1 }]);
  });

  it('skips an archived-in-the-cloud session unless includeArchived is set', async () => {
    writeCard(TARGET, 'local_target-1', { cwd: repoDir, originCwd: repoDir });
    const deps = {
      listClients: () => [client('/home/other/.claude')],
      readCloudAuth: (): CloudAuthResult => ({
        ok: true,
        auth: { accessToken: 'tok', organizationUuid: OTHER.organizationUuid },
      }),
      listCloudSessions: async () => [session({ status: 'archived' })],
      gitRemoteOrigin: () => 'acme/widgets',
    };

    const withoutArchived = await planCloudSweep({ store, ledger, target: TARGET, deps });
    expect(withoutArchived.items).toEqual([]);
    expect(withoutArchived.skipped).toEqual([{ reason: 'archived in the cloud', count: 1 }]);

    const withArchived = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      includeArchived: true,
      deps,
    });
    expect(withArchived.items).toHaveLength(1);
  });

  it('reports a repo with no matching local checkout, named by owner/repo', async () => {
    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client('/home/other/.claude')],
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: { accessToken: 'tok', organizationUuid: OTHER.organizationUuid },
        }),
        listCloudSessions: async () => [session({ repo: { repo: 'acme/widgets' } })],
        gitRemoteOrigin: () => undefined,
        repoRoots: [],
      },
    });
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'no local checkout for acme/widgets', count: 1 }]);
  });

  it('reports an error listing one account without failing the others', async () => {
    writeCard(TARGET, 'local_target-1', { cwd: repoDir, originCwd: repoDir });
    const apiError: CloudApiError = { code: 'unexpected', message: 'boom' };
    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client('/home/broken/.claude'), client('/home/other/.claude')],
        readCloudAuth: (configDir): CloudAuthResult => ({
          ok: true,
          auth: {
            accessToken: 'tok',
            organizationUuid: OTHER.organizationUuid,
            accountUuid: configDir.includes('broken') ? 'broken-account' : OTHER.accountUuid,
          },
        }),
        listCloudSessions: async (auth) =>
          auth.accountUuid === 'broken-account' ? apiError : [session()],
        gitRemoteOrigin: () => 'acme/widgets',
      },
    });
    expect(plan.accountErrors).toEqual([{ configDir: '/home/broken/.claude', reason: 'boom' }]);
    expect(plan.items).toHaveLength(1);
  });

  it('paginates through every session a listCloudSessions call names (regression for the API fix)', async () => {
    writeCard(TARGET, 'local_target-1', { cwd: repoDir, originCwd: repoDir });
    const many = Array.from({ length: 25 }, (_, i) =>
      session({ id: `cse_${String(i).padStart(20, '0')}` }),
    );
    const plan = await planCloudSweep({
      store,
      ledger,
      target: TARGET,
      deps: {
        listClients: () => [client('/home/other/.claude')],
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: { accessToken: 'tok', organizationUuid: OTHER.organizationUuid },
        }),
        // Stands in for `listCloudSessions` already having paginated — this
        // module never re-implements pagination, it just trusts the full list.
        listCloudSessions: async () => many,
        gitRemoteOrigin: () => 'acme/widgets',
      },
    });
    expect(plan.items).toHaveLength(25);
  });
});

describe('applyCloudSweep', () => {
  it('pulls every planned item and reports pulled/failed counts', async () => {
    const detail: CloudSessionDetail = {
      id: 'cse_00000000000000000000000001',
      title: 'Fix the thing',
      status: 'idle',
      repo: { repo: 'acme/widgets' },
    };
    const events: TeleportEvent[] = [
      {
        eventId: 'u1',
        eventType: 'user',
        payload: {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          isSidechain: false,
          sessionId: 'x',
          timestamp: '2026-09-01T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        },
      },
    ];

    const result = await applyCloudSweep({
      store,
      ledger,
      target: TARGET,
      plan: {
        items: [
          {
            cloudSessionId: 'cse_00000000000000000000000001',
            title: 'Fix the thing',
            sourceConfigDir: '/home/other/.claude',
            into: repoDir,
            repo: { repo: 'acme/widgets' },
          },
        ],
        skipped: [],
        accountsNeedingLogin: [],
        accountErrors: [],
      },
      now: 1_700_000_000_000,
      deps: {
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: { accessToken: 'tok', organizationUuid: OTHER.organizationUuid },
        }),
        fetchCloudSession: async () => detail,
        fetchTeleportEvents: async () => events,
      },
    });

    expect(result.pulled).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.outcomes[0]!.status).toBe('imported');
    expect(existsSync(result.outcomes[0]!.cardPath!)).toBe(true);
  });

  it('reports one failure without aborting the rest', async () => {
    const detail: CloudSessionDetail = {
      id: 'cse_00000000000000000000000002',
      title: 'Second one',
      status: 'idle',
      repo: { repo: 'acme/other' },
    };
    const failError: CloudApiError = { code: 'not_found', message: 'gone' };

    const result = await applyCloudSweep({
      store,
      ledger,
      target: TARGET,
      plan: {
        items: [
          {
            cloudSessionId: 'cse_00000000000000000000000001',
            title: 'Fails',
            sourceConfigDir: '/home/other/.claude',
            into: repoDir,
            repo: { repo: 'acme/widgets' },
          },
          {
            cloudSessionId: 'cse_00000000000000000000000002',
            title: 'Second one',
            sourceConfigDir: '/home/other/.claude',
            into: repoDir,
            repo: { repo: 'acme/other' },
          },
        ],
        skipped: [],
        accountsNeedingLogin: [],
        accountErrors: [],
      },
      now: 1_700_000_000_000,
      deps: {
        readCloudAuth: (): CloudAuthResult => ({
          ok: true,
          auth: { accessToken: 'tok', organizationUuid: OTHER.organizationUuid },
        }),
        fetchCloudSession: async (_auth, id) => (id.endsWith('001') ? failError : detail),
        fetchTeleportEvents: async () => [],
      },
    });

    expect(result.pulled).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.outcomes.find((o) => o.cloudSessionId.endsWith('001'))!.status).toBe('failed');
    expect(result.outcomes.find((o) => o.cloudSessionId.endsWith('002'))!.status).toBe('imported');
  });
});
