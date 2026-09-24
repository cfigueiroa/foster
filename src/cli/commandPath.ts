import type { Command } from 'commander';

/**
 * The full command line a leaf answers to, e.g. `app status` rather than just
 * `status` — `command.name()` alone answers only the leaf's own name, which a
 * subcommand's name can share with an unrelated top-level command. Matching
 * `preAction` on the bare name (`src/cli/index.ts`) made `foster app status`
 * trip `identifyHeldAccounts` (a network call) every time, purely because a
 * *different*, top-level `status` command is one that hook means to cover.
 *
 * A standalone module, not a function inside `index.ts`, because `index.ts`
 * runs the program on import and so cannot be driven in a test
 * (`tests/helpGroups.test.ts`'s own note) — this is small enough, and
 * self-contained enough, to be worth pulling out rather than leaving
 * untested.
 */
export function commandPath(command: Command): string {
  const parts: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    parts.unshift(current.name());
  }
  return parts.join(' ');
}
