/**
 * One identifier, abbreviated, refused rather than guessed at.
 *
 * `--from`, `--to`, `label`, live `--stop` and the agent all mean the same
 * thing by a prefix: exactly one id, or an error. The policies that used to
 * live next to each flag — silent no-match, keep-every-match, case-sensitive
 * here and not there — are the reason a typo did different things in different
 * commands.
 */

export type UniquePrefix<T> =
  { kind: 'one'; id: string; items: T[] } | { kind: 'none' } | { kind: 'ambiguous'; ids: string[] };

export function uniquePrefix<T>(
  items: readonly T[],
  prefix: string,
  idOf: (item: T) => string,
): UniquePrefix<T> {
  const needle = prefix.toLowerCase();
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = idOf(item);
    if (!id.toLowerCase().startsWith(needle)) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), item]);
  }

  const ids = [...grouped.keys()];
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length > 1) return { kind: 'ambiguous', ids };
  const id = ids[0]!;
  return { kind: 'one', id, items: grouped.get(id)! };
}

export function requireUniquePrefix<T>(
  items: readonly T[],
  prefix: string,
  idOf: (item: T) => string,
  describe: { none: string; ambiguous: (ids: string[]) => string },
): T[] {
  const result = uniquePrefix(items, prefix, idOf);
  if (result.kind === 'none') throw new Error(describe.none);
  if (result.kind === 'ambiguous') throw new Error(describe.ambiguous(result.ids));
  return result.items;
}

/** The message `--from` / `--to` already use, so every caller reads the same. */
export function ambiguousIds(flag: string, prefix: string, kind: string, ids: string[]): string {
  return (
    `${flag} "${prefix}" is ambiguous: it matches ${ids.length} ${kind}s.\n` +
    ids.map((id) => `  ${id}`).join('\n')
  );
}
