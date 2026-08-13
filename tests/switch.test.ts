import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCredential, readCliCredential } from '../src/store/cliCredential.js';
import { currentCredential, rememberCredential, versionsOf } from '../src/engine/vault.js';
import {
  applySwitch,
  asOAuthToken,
  identify,
  planSwitch,
  rememberCurrent,
} from '../src/engine/switch.js';

/**
 * The API is mocked by token, not by call count: every assertion here is about
 * *which account* a token turns out to belong to, and a mock keyed on the token
 * is the only kind that can tell a successful switch from a rollback.
 */
vi.mock('../src/engine/anthropicApi.js', () => ({
  fetchLiveProfile: vi.fn(),
  fetchLiveUsage: vi.fn(),
}));
const { fetchLiveProfile } = await import('../src/engine/anthropicApi.js');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const OWNERS: Record<string, string> = { 'token-alice': ALICE, 'token-bob': BOB };

beforeEach(() => {
  vi.mocked(fetchLiveProfile).mockReset();
  vi.mocked(fetchLiveProfile).mockImplementation(async (auth) => {
    const email = OWNERS[auth.token];
    return email ? { email } : undefined;
  });
});

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-switch-'));
}

function credential(token: string, expiresAt?: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });
}

/** A config directory holding a credential, and optionally a cached profile. */
function client(token?: string, cachedEmail?: string): string {
  const dir = scratch();
  if (token) writeFileSync(path.join(dir, '.credentials.json'), credential(token));
  if (cachedEmail) {
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: cachedEmail } }),
    );
  }
  return dir;
}

/** Put a credential in the vault for a client — the only way one becomes switchable. */
function vaulted(root: string, configDir: string, email: string, token: string, now?: number) {
  rememberCredential(root, configDir, email, parseCredential(credential(token)), { now });
}

describe('asOAuthToken', () => {
  it('converts the CLI’s milliseconds into the seconds the API client expects', () => {
    // The two credential sources disagree on units and nothing in the types says
    // so. Passing milliseconds straight through makes every token look valid for
    // fifty thousand years, which silently disables the freshness check.
    const at = 1_800_000_000_000;
    expect(asOAuthToken(parseCredential(credential('t', at)))?.expiresAt).toBe(1_800_000_000);
  });

  it('is nothing at all when the file carried no token', () => {
    expect(asOAuthToken(parseCredential('{}'))).toBeUndefined();
  });
});

describe('identify', () => {
  it('prefers the API, and says the answer is verified', async () => {
    const dir = client('token-alice', 'stale@example.test');
    expect(await identify(dir)).toEqual({ email: ALICE, verified: true });
  });

  it('carries the account id when the profile had one', async () => {
    vi.mocked(fetchLiveProfile).mockResolvedValue({
      email: ALICE,
      accountUuid: '00000000-0000-4000-8000-00000000000a',
    });

    expect((await identify(client('token-alice'))).accountUuid).toBe(
      '00000000-0000-4000-8000-00000000000a',
    );
  });

  it('falls back to the cached profile, and marks it unverified', async () => {
    const dir = client('token-nobody', 'cached@example.test');
    const identity = await identify(dir);

    expect(identity.email).toBe('cached@example.test');
    expect(identity.verified).toBe(false);
  });

  it('never claims a check it skipped', async () => {
    const dir = client('token-alice', 'cached@example.test');
    const identity = await identify(dir, { offline: true });

    expect(identity.verified).toBe(false);
    expect(vi.mocked(fetchLiveProfile)).not.toHaveBeenCalled();
  });

  it('reports an empty directory as nobody, without reaching the network', async () => {
    const identity = await identify(scratch());

    expect(identity).toEqual({ verified: false, note: 'no credential here' });
    expect(vi.mocked(fetchLiveProfile)).not.toHaveBeenCalled();
  });

  it('does not ask about a token whose own clock says it is finished', async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, '.credentials.json'), credential('token-alice', 1));

    expect((await identify(dir, { now: 2 })).verified).toBe(false);
    expect(vi.mocked(fetchLiveProfile)).not.toHaveBeenCalled();
  });
});

describe('planSwitch', () => {
  it('refuses when the vault has never held that account for this client', async () => {
    const plan = await planSwitch({
      configDir: client('token-alice'),
      target: BOB,
      vaultRoot: scratch(),
    });

    expect(plan.blockers[0]).toContain('no credential for');
  });

  it('refuses a credential recorded against a different client', async () => {
    // One account signed into two directories has two token families. Offering
    // one here would install the other surface's credential.
    const root = scratch();
    const dir = client('token-alice');
    vaulted(root, client(), BOB, 'token-bob');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });

    expect(plan.blockers[0]).toContain('different token family');
  });

  it('refuses to switch to the account already there', async () => {
    const root = scratch();
    const dir = client('token-alice');
    vaulted(root, dir, ALICE, 'token-alice');

    const plan = await planSwitch({ configDir: dir, target: ALICE, vaultRoot: root });

    expect(plan.blockers[0]).toContain('already the account here');
  });

  it('takes the newest version, and says how many stand behind it', async () => {
    const root = scratch();
    const dir = client('token-alice');
    vaulted(root, dir, BOB, 'token-stale', 1);
    vaulted(root, dir, BOB, 'token-bob', 2);

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });

    expect(plan.blockers).toEqual([]);
    expect(plan.takenAt).toBe(2);
    expect(plan.versions).toBe(2);
  });

  it('names the live sessions that could overwrite the result', async () => {
    const dir = client('token-alice');
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    writeFileSync(
      path.join(dir, 'sessions', 'a.json'),
      JSON.stringify({ pid: 4242, sessionId: 'conv-1', cwd: 'C:\\work' }),
    );
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({
      configDir: dir,
      target: BOB,
      vaultRoot: root,
      alive: (pid) => pid === 4242,
    });

    expect(plan.clobberers).toEqual([{ pid: 4242, cwd: 'C:\\work' }]);
  });
});

describe('an identity foster cannot verify stops the switch', () => {
  // The two paths that used to destroy a credential. Both start the same way:
  // foster cannot say, from the API, who is signed in here — so it has no name
  // to file the outgoing credential under, and filing it wrong is worse than
  // not switching, because an append-only store cannot take a wrong label back.

  it('refuses when the account here cannot be identified at all', async () => {
    const dir = client('token-nobody');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });

    expect(plan.blockers.join(' ')).toContain('cannot establish which account');
    expect(readCliCredential(dir)?.accessToken).toBe('token-nobody');
  });

  it('refuses when only a cached address names it, because the cache lags a swap', async () => {
    const dir = client('token-bob', ALICE);
    const root = scratch();
    vaulted(root, dir, ALICE, 'token-alice');
    vi.mocked(fetchLiveProfile).mockResolvedValue(undefined);

    const plan = await planSwitch({ configDir: dir, target: ALICE, vaultRoot: root });

    expect(plan.blockers.join(' ')).toContain('cannot establish which account');
    expect(currentCredential(root, dir, ALICE)?.credential.accessToken).toBe('token-alice');
  });

  it('does not block on a cached address that says you are already here', async () => {
    // The mirror of the case above: after a switch A→B the cache still says A,
    // and comparing against it would refuse the switch back to A.
    const dir = client('token-alice', 'stale@example.test');
    const root = scratch();
    vaulted(root, dir, 'stale@example.test', 'token-x');

    const plan = await planSwitch({
      configDir: dir,
      target: 'stale@example.test',
      vaultRoot: root,
    });

    expect(plan.blockers).toEqual([]);
  });

  it('refuses at the moment of writing too, not only at planning', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');
    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });

    const outcome = await applySwitch({ ...plan, from: { verified: false } }, { vaultRoot: root });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('nowhere safe to file it');
    expect(readCliCredential(dir)?.accessToken).toBe('token-alice');
  });

  it('still lets an empty directory be signed in, because nothing is at risk', async () => {
    const dir = scratch();
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    expect(plan.blockers).toEqual([]);
    expect((await applySwitch(plan, { vaultRoot: root })).ok).toBe(true);
  });

  it('plans offline and refuses to apply, rather than writing and reverting', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({
      configDir: dir,
      target: BOB,
      vaultRoot: root,
      offline: true,
    });

    expect(plan.blockers.join(' ')).toContain('without --offline');
    expect(vi.mocked(fetchLiveProfile)).not.toHaveBeenCalled();
  });
});

describe('applySwitch', () => {
  it('records the outgoing account and installs the incoming one', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    const outcome = await applySwitch(plan, { vaultRoot: root });

    expect(outcome.ok).toBe(true);
    expect(outcome.landed).toBe(BOB);
    expect(readCliCredential(dir)?.accessToken).toBe('token-bob');
    expect(currentCredential(root, dir, ALICE)?.credential.accessToken).toBe('token-alice');
  });

  it('removes nothing: the installed credential is still on file afterwards', async () => {
    // The whole point of the append-only shelf. A positional vault would have
    // consumed this entry on the way past.
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    await applySwitch(plan, { vaultRoot: root });

    expect(currentCredential(root, dir, BOB)?.credential.accessToken).toBe('token-bob');
    expect(versionsOf(root, dir, BOB)).toHaveLength(1);
  });

  it('keeps every earlier version of the account it displaces', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, ALICE, 'token-alice-old', 1);
    vaulted(root, dir, BOB, 'token-bob', 2);

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    await applySwitch(plan, { vaultRoot: root });

    // The older Alice is still there, underneath the one just recorded.
    const alice = versionsOf(root, dir, ALICE);
    expect(alice).toHaveLength(2);
    expect(alice[0]?.savedAt).toBe(1);
  });

  it('switching back and forth never grows past the versions that really differ', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    await applySwitch(await planSwitch({ configDir: dir, target: BOB, vaultRoot: root }), {
      vaultRoot: root,
    });
    await applySwitch(await planSwitch({ configDir: dir, target: ALICE, vaultRoot: root }), {
      vaultRoot: root,
    });

    expect(readCliCredential(dir)?.accessToken).toBe('token-alice');
    expect(versionsOf(root, dir, ALICE)).toHaveLength(1);
    expect(versionsOf(root, dir, BOB)).toHaveLength(1);
  });

  it('says the cached profile will disagree until the CLI runs', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-bob');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    const outcome = await applySwitch(plan, { vaultRoot: root });

    expect(outcome.message).toContain('foster clients');
  });

  it('puts the previous account back when the stored credential does not check out', async () => {
    const dir = client('token-alice');
    const root = scratch();
    // A credential that has gone stale since it was taken: it parses, and the
    // API does not recognise it. This is the ordinary failure here.
    vaulted(root, dir, BOB, 'token-rotted');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    const outcome = await applySwitch(plan, { vaultRoot: root });

    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.message).toContain('sign into');
    expect(readCliCredential(dir)?.accessToken).toBe('token-alice');
  });

  it('leaves both credentials on file after a rollback', async () => {
    const dir = client('token-alice');
    const root = scratch();
    vaulted(root, dir, BOB, 'token-rotted');

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    await applySwitch(plan, { vaultRoot: root });

    expect(currentCredential(root, dir, ALICE)?.credential.accessToken).toBe('token-alice');
    expect(currentCredential(root, dir, BOB)?.credential.accessToken).toBe('token-rotted');
  });

  it('refuses to act on a plan that was already blocked', async () => {
    const plan = await planSwitch({
      configDir: client('token-alice'),
      target: BOB,
      vaultRoot: scratch(),
    });
    const outcome = await applySwitch(plan, { vaultRoot: scratch() });

    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(false);
  });

  it('writes the credential whole, so an unknown field survives the trip', async () => {
    const dir = client('token-alice');
    const root = scratch();
    const raw = '{"claudeAiOauth":{"accessToken":"token-bob"},"futureField":[1,2,3]}';
    rememberCredential(root, dir, BOB, parseCredential(raw));

    const plan = await planSwitch({ configDir: dir, target: BOB, vaultRoot: root });
    await applySwitch(plan, { vaultRoot: root });

    expect(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).toBe(raw);
  });
});

describe('rememberCurrent', () => {
  it('records a verified account', () => {
    const dir = client('token-alice');
    const root = scratch();

    expect(rememberCurrent(dir, { email: ALICE, verified: true }, root)).toEqual({
      recorded: true,
      appended: true,
    });
    expect(currentCredential(root, dir, ALICE)?.credential.accessToken).toBe('token-alice');
  });

  it('records nothing for an unverified identity', () => {
    // Filing under a guessed address is how the vault would come to hold a record
    // labelled with the wrong account — and append-only cannot take that back.
    const dir = client('token-alice');
    const root = scratch();

    expect(rememberCurrent(dir, { email: ALICE, verified: false }, root).recorded).toBe(false);
    expect(currentCredential(root, dir, ALICE)).toBeUndefined();
  });

  it('appends nothing when nothing has changed', () => {
    const dir = client('token-alice');
    const root = scratch();
    rememberCurrent(dir, { email: ALICE, verified: true }, root);

    expect(rememberCurrent(dir, { email: ALICE, verified: true }, root)).toEqual({
      recorded: true,
      appended: false,
    });
    expect(versionsOf(root, dir, ALICE)).toHaveLength(1);
  });

  it('records nothing when there is no credential to copy', () => {
    expect(rememberCurrent(scratch(), { email: ALICE, verified: true }, scratch()).recorded).toBe(
      false,
    );
  });
});
