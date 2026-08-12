import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeClient } from '../src/store/clients.js';
import { parseCredential } from '../src/store/cliCredential.js';
import { currentCredential, rememberCredential, versionsOf } from '../src/engine/vault.js';
import { applyMigration, planMigration } from '../src/engine/vaultMigrate.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-migrate-'));
}

function credential(token: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}` } });
}

/** A record in the layout that keyed by account alone and never said which client. */
function legacy(root: string, shelf: string, email: string, token: string, savedAt = 1): string {
  const dir = path.join(root, shelf);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${email.replace(/[^a-z0-9.]+/gi, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({ v: 1, email, savedAt, credential: credential(token) }, null, 2),
  );
  return file;
}

/** A client on the machine, with an optional live credential and cached identity. */
function client(token?: string, email?: string): ClaudeClient {
  const dir = scratch();
  if (token) writeFileSync(path.join(dir, '.credentials.json'), credential(token));
  return {
    configDir: dir,
    isDefault: false,
    inUse: false,
    signedIn: Boolean(token),
    ...(email ? { identity: { email } } : {}),
    conversations: 0,
    live: 0,
  };
}

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

describe('planMigration', () => {
  it('places a record whose credential a client still holds', () => {
    // The strongest evidence there is: byte for byte, this is that client's file.
    const root = scratch();
    legacy(root, 'rolling', ALICE, 'token-alice');
    const holder = client('token-alice', ALICE);

    const [item] = planMigration(root, { clients: [holder, client('other', BOB)] }).items;

    expect(item?.surface).toBe(holder.configDir);
    expect(item?.evidence).toBe('the credential matches this client');
  });

  it('places a record when exactly one client is signed in as that account', () => {
    // Weaker — the cached profile lags — so it is reported as inferred.
    const root = scratch();
    legacy(root, 'accounts', BOB, 'token-bob-old');
    const onBob = client('something-else', BOB);

    const [item] = planMigration(root, { clients: [onBob, client('x', ALICE)] }).items;

    expect(item?.surface).toBe(onBob.configDir);
    expect(item?.evidence).toBe('the only client on that account');
  });

  it('refuses when two clients are on that account', () => {
    // The exact ambiguity the new key exists for. Guessing here would write a
    // credential into a history where it does not belong, permanently.
    const root = scratch();
    legacy(root, 'accounts', ALICE, 'token-alice');

    const [item] = planMigration(root, {
      clients: [client('a', ALICE), client('b', ALICE)],
    }).items;

    expect(item?.surface).toBeUndefined();
    expect(item?.blocker).toContain('2 clients are signed in as');
  });

  it('refuses when no client holds or claims it', () => {
    const root = scratch();
    legacy(root, 'accounts', ALICE, 'token-alice');

    const [item] = planMigration(root, { clients: [client('b', BOB)] }).items;

    expect(item?.blocker).toContain('--to-client');
  });

  it('lets --to-client settle what evidence could not', () => {
    const root = scratch();
    legacy(root, 'accounts', ALICE, 'token-alice');

    const [item] = planMigration(root, { clients: [], toClient: 'C:\\chosen' }).items;

    expect(item?.surface).toBe('C:\\chosen');
    expect(item?.evidence).toBe('named with --to-client');
  });

  it('reports an unreadable file instead of failing the whole plan', () => {
    const root = scratch();
    mkdirSync(path.join(root, 'accounts'), { recursive: true });
    writeFileSync(path.join(root, 'accounts', 'torn.json'), '{"v":1,"email":');
    legacy(root, 'rolling', ALICE, 'token-alice');

    const plan = planMigration(root, { clients: [client('token-alice', ALICE)] });

    expect(plan.items).toHaveLength(2);
    expect(plan.items.some((item) => item.blocker?.includes('not a vault envelope'))).toBe(true);
  });

  it('writes nothing', () => {
    const root = scratch();
    const file = legacy(root, 'rolling', ALICE, 'token-alice');
    planMigration(root, { clients: [client('token-alice', ALICE)] });

    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(root, 'legacy'))).toBe(false);
  });
});

describe('applyMigration', () => {
  it('moves the record into the client’s history, keeping its timestamp', () => {
    const root = scratch();
    legacy(root, 'rolling', ALICE, 'token-alice', 1234);
    const holder = client('token-alice', ALICE);

    const outcome = applyMigration(planMigration(root, { clients: [holder] }));

    expect(outcome.migrated).toBe(1);
    const current = currentCredential(root, holder.configDir, ALICE);
    expect(current?.credential.accessToken).toBe('token-alice');
    expect(current?.entry.savedAt).toBe(1234);
  });

  it('archives rather than deletes', () => {
    // A migration is no more entitled to make a credential unreachable than a
    // switch is.
    const root = scratch();
    const file = legacy(root, 'rolling', ALICE, 'token-alice');
    applyMigration(planMigration(root, { clients: [client('token-alice', ALICE)] }));

    expect(existsSync(file)).toBe(false);
    const archived = path.join(root, 'legacy', 'rolling', path.basename(file));
    expect(existsSync(archived)).toBe(true);
    expect(JSON.parse(readFileSync(archived, 'utf8')).credential).toBe(credential('token-alice'));
  });

  it('leaves an unplaced record exactly where it is', () => {
    const root = scratch();
    const file = legacy(root, 'accounts', ALICE, 'token-alice');

    const outcome = applyMigration(planMigration(root, { clients: [client('b', BOB)] }));

    expect(outcome.skipped).toBe(1);
    expect(outcome.migrated).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it('is idempotent: running it twice appends once', () => {
    const root = scratch();
    legacy(root, 'rolling', ALICE, 'token-alice');
    const holder = client('token-alice', ALICE);

    applyMigration(planMigration(root, { clients: [holder] }));
    // The second run finds nothing left on the old shelves at all.
    const second = applyMigration(planMigration(root, { clients: [holder] }));

    expect(second.migrated).toBe(0);
    expect(versionsOf(root, holder.configDir, ALICE)).toHaveLength(1);
  });

  it('counts a record the history already had without appending it again', () => {
    const root = scratch();
    const holder = client('token-alice', ALICE);
    // Recorded the ordinary way first, then the same bytes found on an old shelf.
    rememberCredential(root, holder.configDir, ALICE, parseCredential(credential('token-alice')));
    legacy(root, 'rolling', ALICE, 'token-alice');

    const outcome = applyMigration(planMigration(root, { clients: [holder] }));

    expect(outcome.alreadyPresent).toBe(1);
    expect(outcome.migrated).toBe(0);
    expect(versionsOf(root, holder.configDir, ALICE)).toHaveLength(1);
  });

  it('migrates both shelves in one pass', () => {
    const root = scratch();
    const holder = client('token-alice', ALICE);
    legacy(root, 'rolling', ALICE, 'token-alice');
    legacy(root, 'accounts', ALICE, 'token-alice-older', 1);

    const outcome = applyMigration(planMigration(root, { clients: [holder] }));

    expect(outcome.migrated).toBe(2);
    expect(versionsOf(root, holder.configDir, ALICE)).toHaveLength(2);
  });
});
