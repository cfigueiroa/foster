import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Thirty-four commands in one flat list is a wall, not a menu, so `--help` files
 * them under headings. The risk is not that the grouping breaks — Commander
 * prints what it is given — but that the next command added lands outside every
 * heading and sits alone under a bare "Commands:", which reads like an oversight
 * and is one.
 *
 * Asserted against the source rather than a rendered `--help`: `index.ts` runs
 * the program on import, so there is nothing to load into a test without
 * spawning a process, and what this guards is a line the author has to write.
 */
const source = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');

/** Every top-level command, with the text that follows its declaration. */
function topLevelCommands(): { name: string; tail: string }[] {
  const found: { name: string; tail: string }[] = [];
  const declaration = /\n\s*\.command\('([a-z]+)'\)/g;
  for (const match of source.matchAll(declaration)) {
    // Subcommands are declared against `client`, `profile` and `app` rather than
    // `program`, and are grouped by the parent they hang from.
    const before = source.slice(Math.max(0, match.index - 120), match.index);
    if (!/\bprogram\s*$/.test(before)) continue;
    found.push({ name: match[1]!, tail: source.slice(match.index, match.index + 400) });
  }
  return found;
}

describe('--help groups', () => {
  it('files every top-level command under a heading', () => {
    const ungrouped = topLevelCommands()
      .filter((command) => !command.tail.includes('.helpGroup('))
      .map((command) => command.name);

    expect(ungrouped).toEqual([]);
  });

  it('finds the commands at all, so the check cannot pass by matching nothing', () => {
    expect(topLevelCommands().length).toBeGreaterThan(20);
  });
});
