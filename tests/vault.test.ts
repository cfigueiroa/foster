import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCredential } from '../src/store/cliCredential.js';
import {
  currentCredential,
  listAll,
  rememberCredential,
  slugFor,
  surfaceSlug,
  vaultOutsideProfile,
  vaultRoot,
  versionsOf,
} from '../src/engine/vault.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-vault-'));
}

/** A credential file shaped the way the CLI writes one. */
function credential(token: string, expiresAt?: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `refresh-${token}`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      scopes: ['user:inference', 'user:profile'],
    },
  });
}

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const ENV = 'C:\\Users\\someone\\.claude';
const FLEET = 'C:\\Users\\someone\\.claude-accounts\\alice';

describe('vaultRoot', () => {
  it('sits under foster’s own directory, beside the ledger', () => {
    expect(vaultRoot({ FOSTER_HOME: 'C:\\somewhere' })).toBe(path.join('C:\\somewhere', 'vault'));
  });
});

describe('slugFor', () => {
  it('makes a filename fragment, and keeps it readable', () => {
    expect(slugFor('Alice.Smith+tag@Example.test')).toMatch(
      /^alice\.smith-tag-example\.test-[0-9a-f]{8}$/,
    );
  });

  it('never returns an empty name', () => {
    expect(slugFor('@@@')).toMatch(/^unknown-[0-9a-f]{8}$/);
  });

  it('separates two inputs whose readable halves collide', () => {
    // Both reduce to `jos-example.test`. Without the digest one would overwrite
    // the other, and the record check would then report the destroyed account as
    // one that was never held.
    expect(slugFor('josé@example.test')).not.toBe(slugFor('josç@example.test'));
  });
});

describe('surfaceSlug', () => {
  it('folds capitalisation into one history where the filesystem does', () => {
    // Splitting them would give one account two histories that each look
    // complete. Which spellings are one directory is the filesystem's answer,
    // not this module's, so the assertion follows the platform rather than
    // asserting Windows behaviour everywhere.
    const folded =
      surfaceSlug('C:\\Users\\Someone\\.claude') === surfaceSlug('c:\\users\\someone\\.claude');
    expect(folded).toBe(process.platform === 'win32');
  });

  it('keeps genuinely different directories apart', () => {
    expect(surfaceSlug(ENV)).not.toBe(surfaceSlug(FLEET));
  });
});

describe('the identity of a credential is (surface, account)', () => {
  it('keeps one account’s two token families apart', () => {
    // The constraint this whole layout exists for: the same account signed into
    // two config directories has two independent families, from two logins,
    // whose refresh tokens rotate separately. Keyed by account alone, the second
    // remember would overwrite the first and a switch could install one surface's
    // credential into the other.
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('env-token')));
    rememberCredential(root, FLEET, ALICE, parseCredential(credential('fleet-token')));

    expect(currentCredential(root, ENV, ALICE)?.credential.accessToken).toBe('env-token');
    expect(currentCredential(root, FLEET, ALICE)?.credential.accessToken).toBe('fleet-token');
    expect(listAll(root)).toHaveLength(2);
  });

  it('does not offer one surface’s credential to another', () => {
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('env-token')));

    expect(currentCredential(root, FLEET, ALICE)).toBeUndefined();
  });
});

describe('the vault never loses a credential', () => {
  it('keeps every version, newest first in front', () => {
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('first')), { now: 1 });
    rememberCredential(root, ENV, ALICE, parseCredential(credential('second')), { now: 2 });
    rememberCredential(root, ENV, ALICE, parseCredential(credential('third')), { now: 3 });

    expect(currentCredential(root, ENV, ALICE)?.credential.accessToken).toBe('third');
    const all = versionsOf(root, ENV, ALICE);
    expect(all).toHaveLength(3);
    expect(all.map((entry) => entry.savedAt)).toEqual([1, 2, 3]);
  });

  it('reports how many versions stand behind the current one', () => {
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('first')), { now: 1 });
    rememberCredential(root, ENV, ALICE, parseCredential(credential('second')), { now: 2 });

    expect(currentCredential(root, ENV, ALICE)?.entry.versions).toBe(2);
    expect(listAll(root)[0]?.versions).toBe(2);
  });

  it('appends nothing when the credential has not changed', () => {
    // Guard runs on a timer; a token that has not rotated should cost nothing.
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('same')), { now: 1 });
    const second = rememberCredential(root, ENV, ALICE, parseCredential(credential('same')), {
      now: 2,
    });

    expect(second.appended).toBe(false);
    expect(versionsOf(root, ENV, ALICE)).toHaveLength(1);
    // The entry still describes the version on file, not the call that was skipped.
    expect(second.entry.savedAt).toBe(1);
  });
});

describe('rememberCredential', () => {
  it('round-trips the credential byte for byte', () => {
    const root = scratch();
    // An unknown field is the point: a re-serialised credential would drop it,
    // and a dropped field is how you get a file that parses and does not work.
    const raw = '{"claudeAiOauth":{"accessToken":"t1"},"somethingFosterDoesNotKnow":true}';

    rememberCredential(root, ENV, ALICE, parseCredential(raw));

    expect(currentCredential(root, ENV, ALICE)?.credential.raw).toBe(raw);
  });

  it('records the expiry and the account id so the shelf reads without opening anything', () => {
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('t', 1_700_000_000_000)), {
      accountUuid: '00000000-0000-4000-8000-00000000000a',
    });

    const entry = listAll(root)[0]!;
    expect(entry.expiresAt).toBe(1_700_000_000_000);
    expect(entry.accountUuid).toBe('00000000-0000-4000-8000-00000000000a');
  });
});

describe('the vault never leaks a token into its own listing', () => {
  it('lists identities, times and counts, and no credential', () => {
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('super-secret')));

    expect(JSON.stringify(listAll(root))).not.toContain('super-secret');
    expect(JSON.stringify(versionsOf(root, ENV, ALICE))).not.toContain('super-secret');
  });
});

describe('currentCredential', () => {
  it('believes the record, not the path', () => {
    // The path is a convenience. A record that claims to be someone else is the
    // one mistake here that could sign a user into an account they did not ask
    // for, so it is refused rather than returned.
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('alices')));
    const file = versionsOf(root, ENV, ALICE)[0]!.file;
    appendFileSync(
      file,
      `${JSON.stringify({ v: 1, surface: ENV, email: BOB, savedAt: 9, credential: credential('bobs') })}\n`,
    );

    expect(currentCredential(root, ENV, ALICE)).toBeUndefined();
  });

  it('matches an address regardless of case', () => {
    const root = scratch();
    rememberCredential(root, ENV, 'Alice@Example.test', parseCredential(credential('t')));

    expect(currentCredential(root, ENV, 'alice@example.test')?.entry.email).toBe(
      'Alice@Example.test',
    );
  });

  it('survives a torn last line by falling back to the version before it', () => {
    // The failure an append-only file is meant to make cheap: a crash mid-write
    // costs the newest record and nothing else.
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('good')), { now: 1 });
    const file = versionsOf(root, ENV, ALICE)[0]!.file;
    appendFileSync(file, '{"v":1,"surface":"C:\\\\x","email":"a@b.test","cred');

    expect(currentCredential(root, ENV, ALICE)?.credential.accessToken).toBe('good');
  });

  it('skips a record whose version this build does not know', () => {
    // Guessing at the shape of a credential store is how you hand back something
    // that is not what it claims to be.
    const root = scratch();
    const dir = path.join(root, surfaceSlug(ENV));
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, `${slugFor(ALICE)}.jsonl`),
      `${JSON.stringify({ v: 2, surface: ENV, email: ALICE, savedAt: 1, credential: credential('future') })}\n`,
    );

    expect(currentCredential(root, ENV, ALICE)).toBeUndefined();
    expect(listAll(root)).toEqual([]);
  });
});

describe('the history stays readable by hand', () => {
  it('is one JSON object per line, with the identity in plain sight', () => {
    // A recovery property, and a deliberate one: if foster is gone, the way back
    // to a working credential should be one obvious step in any shell. The README
    // documents this shape for that reason.
    const root = scratch();
    rememberCredential(root, ENV, ALICE, parseCredential(credential('t')), { now: 5 });
    const lines = readFileSync(versionsOf(root, ENV, ALICE)[0]!.file, 'utf8')
      .trim()
      .split('\n');

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ v: 1, surface: ENV, email: ALICE, savedAt: 5 });
    expect(record.credential).toBe(credential('t'));
  });
});

describe('vaultOutsideProfile', () => {
  it('accepts foster’s own directory under the profile', () => {
    expect(
      vaultOutsideProfile(
        path.join('C:\\Users\\someone', '.foster', 'vault'),
        'C:\\Users\\someone',
      ),
    ).toBe(false);
  });

  it('flags a vault relocated off the profile', () => {
    // FOSTER_HOME predates the vault and now relocates unencrypted tokens.
    expect(vaultOutsideProfile('D:\\shared\\foster\\vault', 'C:\\Users\\someone')).toBe(true);
  });
});
