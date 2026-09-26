import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `NAMES_ACCOUNTS` (`src/cli/index.ts`) is a plain module-level `Set`, never
 * exported, so this reads the source the same way `helpGroups.test.ts` does
 * rather than importing it — `index.ts` runs the program on import, which
 * makes it awkward to load in isolation.
 *
 * `installations` sat in this set naming a command that has never existed:
 * every real subcommand in this CLI is `profile list`, and `installations` is
 * only ever a word in that command's own description. It never changed
 * `preAction`'s behaviour and is removed as dead weight, not a behaviour fix
 * — this guards it staying gone.
 */
const source = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');

function namesAccounts(): string[] {
  const match = source.match(/const NAMES_ACCOUNTS = new Set\(\[([\s\S]*?)\]\);/);
  if (!match) throw new Error('could not find NAMES_ACCOUNTS in src/cli/index.ts');
  return [...match[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
}

describe('NAMES_ACCOUNTS', () => {
  it('does not name "installations" — no command is ever named that', () => {
    expect(namesAccounts()).not.toContain('installations');
  });

  it('still names the commands that actually print an account by name', () => {
    // Not an exhaustive list to maintain here — just enough to catch the set
    // being emptied by accident along with the one entry this removes.
    expect(namesAccounts()).toEqual(
      expect.arrayContaining(['accounts', 'doctor', 'status', 'stores', 'sweep', 'whoami']),
    );
  });
});
