import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { project } from '../src/ledger/project.js';
import type { StoreLayout } from '../src/domain/types.js';

/**
 * The three credential sources and the API are mocked; the ledger is real, so
 * the assertions are about what gets *written down* — the whole point of the
 * feature is that identifying an account persists it the way a sign-in would.
 * The API is keyed by token so a wrong key is a wrong account, not a failure.
 */
vi.mock('../src/store/credential.js', () => ({ readAccessToken: vi.fn() }));
vi.mock('../src/store/clients.js', () => ({ listClients: vi.fn(() => []) }));
vi.mock('../src/store/cliCredential.js', () => ({ readCliCredential: vi.fn() }));
vi.mock('../src/engine/vault.js', () => ({
  vaultRoot: vi.fn(() => '/vault'),
  listAll: vi.fn(() => []),
  currentCredential: vi.fn(),
  rememberCredential: vi.fn(),
}));
vi.mock('../src/engine/anthropicApi.js', () => ({ fetchLiveProfile: vi.fn() }));

const { readAccessToken } = await import('../src/store/credential.js');
const { fetchLiveProfile } = await import('../src/engine/anthropicApi.js');
const { listClients } = await import('../src/store/clients.js');
const { readCliCredential } = await import('../src/store/cliCredential.js');
const { identifyAccount, canIdentify } = await import('../src/engine/identify.js');

const WANTED = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const store = { root: 'C:\\Store' } as StoreLayout;

function ledger(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-id-')), 'ledger.jsonl'));
}

beforeEach(() => {
  vi.mocked(readAccessToken).mockReset();
  vi.mocked(fetchLiveProfile).mockReset();
  // The API answers for whatever token it is given, by account.
  vi.mocked(fetchLiveProfile).mockImplementation(async (auth) => {
    if (auth.token === 'key-wanted')
      return { accountUuid: WANTED, email: 'her@x.test', name: 'Her' };
    if (auth.token === 'key-other') return { accountUuid: OTHER, email: 'him@x.test' };
    return undefined;
  });
});

describe('identifyAccount', () => {
  it('records the identity when a held credential answers as the asked account', async () => {
    vi.mocked(readAccessToken).mockReturnValue({ token: 'key-wanted' });
    const log = ledger();

    const outcome = await identifyAccount(store, log, WANTED, 1000);

    expect(outcome.profile?.name).toBe('Her');
    const seen = project(log.read()).identities.get(WANTED);
    expect(seen?.email).toBe('her@x.test');
    expect(seen?.name).toBe('Her');
  });

  it('never records against the asked account when the credential belongs to someone else', async () => {
    // The only credential on the machine is for OTHER; asking about WANTED must
    // not write OTHER's identity onto WANTED.
    vi.mocked(readAccessToken).mockReturnValue({ token: 'key-other' });
    const log = ledger();

    const outcome = await identifyAccount(store, log, WANTED, 1000);

    expect(outcome.profile).toBeUndefined();
    expect(outcome.reason).toBe('no-answer');
    expect(project(log.read()).identities.get(WANTED)).toBeUndefined();
  });

  it('reports expired-only when the only credential has lapsed, without calling the API', async () => {
    vi.mocked(readAccessToken).mockReturnValue({ token: 'key-wanted', expiresAt: 1 });
    const log = ledger();

    const outcome = await identifyAccount(store, log, WANTED, 10_000);

    expect(outcome.reason).toBe('expired-only');
    expect(vi.mocked(fetchLiveProfile)).not.toHaveBeenCalled();
  });

  it('reports no-credential when foster holds nothing to ask with', async () => {
    vi.mocked(readAccessToken).mockReturnValue(undefined);
    const log = ledger();

    const outcome = await identifyAccount(store, log, WANTED, 1000);

    expect(outcome.reason).toBe('no-credential');
  });
});

describe('canIdentify', () => {
  it('is true with a live credential and false when the only one is expired', () => {
    vi.mocked(readAccessToken).mockReturnValue({ token: 'key-wanted' });
    expect(canIdentify(store, 1000)).toBe(true);

    vi.mocked(readAccessToken).mockReturnValue({ token: 'key-wanted', expiresAt: 1 });
    expect(canIdentify(store, 10_000)).toBe(false);
  });

  // The D4 guard from the other direction: `client register` must never let
  // identify present a fleet credential to the API. identify.ts calls
  // `listClients()` with no arguments at all, so a registered root cannot
  // reach it no matter what the ledger holds — proved here by handing
  // `listClients` an implementation that WOULD return the container's signed-in
  // child if it ever received registered dirs, then showing a registered
  // container in the ledger changes nothing about what identify sees.
  it('does not present a credential from a client root registered in the ledger', () => {
    const log = ledger();
    log.append({ kind: 'client_root_registered', root: 'C:\\accounts', as: 'container' });
    expect(project(log.read()).clientRoots.get('C:\\accounts')).toBe('container');

    vi.mocked(listClients).mockImplementationOnce((_env, _extra, registeredDirs) =>
      registeredDirs && registeredDirs.length > 0
        ? ([
            {
              configDir: 'C:\\accounts\\llm02',
              isDefault: false,
              inUse: false,
              signedIn: true,
              conversations: 0,
              live: 0,
            },
          ] as ReturnType<typeof listClients>)
        : [],
    );
    vi.mocked(readCliCredential).mockReturnValue({
      raw: '{}',
      accessToken: 'key-fleet',
      oauth: { accessToken: 'key-fleet' },
    } as unknown as ReturnType<typeof readCliCredential>);
    vi.mocked(readAccessToken).mockReturnValue(undefined);

    // If identify's call site ever grew a default that read the ledger, this
    // would flip to true on the fleet credential above.
    expect(canIdentify(store, 1000)).toBe(false);
  });
});
