import { existsSync } from 'node:fs';
import {
  candidateStoreRoots,
  directoryKey,
  layoutFor,
  resolveStore,
  storeRootOfCopy,
} from '../domain/paths.js';
import type { StoreLayout } from '../domain/types.js';
import { uniquePrefix } from '../domain/prefix.js';
import type { LedgerEvent } from '../ledger/types.js';
import { project, type LedgerState } from '../ledger/project.js';
import { readProcesses, runningStores, type ProcessLister } from './desktop.js';
import { lockfileHeld } from './lockfile.js';
import { readConfig } from '../store/config.js';

/**
 * Every installation foster can name without being told.
 *
 * Four sources, and all four are needed. The installed app, so switching back
 * to it from a profile does not mean typing a package path. The instances that
 * are up, because a profile announces itself nowhere but on its own command
 * line. The stores the ledger has written into before — a stopped profile is
 * written down nowhere else, and having to retype its path on every visit was
 * the whole friction. And the names registered on purpose — `foster profile
 * register` — for a profile that has neither run nor been fostered into yet.
 *
 * Directories that have since gone are dropped rather than offered: a menu
 * entry that fails when picked is worse than one that was never there. A
 * registered name is the one exception — see `KnownStore.exists`.
 */
export interface KnownStore {
  root: string;
  /**
   * The name it was registered under, when it has one — `foster profile
   * register <path> --name work`. A store reached only through the ledger or a
   * running process has none; one that is also registered keeps whichever hint
   * says how foster first found it, name attached, rather than being relisted
   * as a second, redundant entry.
   */
  name?: string;
  /**
   * How foster came to know about it. A store that only a command line names is
   * a profile by definition — nothing else could have started it that way.
   * `registered` is the one hint that can outlive the directory: see `exists`.
   */
  hint: 'installed app' | 'profile' | 'used before' | 'registered';
  running: boolean;
  /**
   * Whether the directory is still there. Every other hint requires this to be
   * true to be offered at all — a menu entry that fails when picked is worse
   * than one that was never there. A registered name is the exception: it is
   * the one thing foster remembers on purpose, so a root that has gone stays
   * listed, marked gone, instead of silently dropping the name that pointed at
   * it — `foster profile forget` is how you actually stop hearing about it.
   */
  exists: boolean;
  /**
   * The account this installation last recorded, when it has one. With profiles
   * the whole point is that each holds a different account, so which one is the
   * question being asked — and a store with none has not been signed into yet,
   * which is why fostering into it refuses.
   */
  accountUuid?: string;
}

/** Just the read: this takes the ledger's events, not the object holding them. */
export function knownStores(
  events: LedgerEvent[],
  env: NodeJS.ProcessEnv = process.env,
  list: ProcessLister = readProcesses,
): KnownStore[] {
  const seen = new Map<string, KnownStore>();
  const stores: KnownStore[] = [];

  const offer = (root: string, hint: KnownStore['hint'], name?: string): void => {
    const store = layoutFor(root);
    // The filesystem decides what is the same store and what still exists. A
    // directory that has gone is dropped rather than offered — a menu entry that
    // fails when picked is worse than one that was never there — and a profile
    // with no sessions yet is kept, because that is exactly a store you would be
    // sending sessions to.
    const key = directoryKey(store.root);

    if (key === undefined) {
      // Every other hint means the directory was just seen to exist — installed
      // app, a running process, a copy fostered into before — so gone here means
      // stale and it is dropped. A registered name is the one hint that survives
      // its target vanishing on purpose: that is what lets `resolveStoreArg` say
      // *which* profile went missing instead of just failing to find one.
      if (hint === 'registered' && name !== undefined) {
        stores.push({ root: store.root, name, hint, running: false, exists: false });
      }
      return;
    }

    const known = seen.get(key);
    if (known) {
      // Already offered through another route. A registered name attaches to
      // that row rather than adding a second, redundant one for the same
      // directory — the installed app or a running profile keeps its own hint,
      // it just also has a name now.
      if (name !== undefined) known.name ??= name;
      return;
    }

    const accountUuid = readConfig(store).lastKnownAccountUuid;
    const found: KnownStore = {
      root: store.root,
      hint,
      running: lockfileHeld(store),
      exists: true,
      ...(name !== undefined ? { name } : {}),
      ...(accountUuid ? { accountUuid } : {}),
    };
    seen.set(key, found);
    stores.push(found);
  };

  for (const dir of candidateStoreRoots(env)) offer(dir, 'installed app');
  for (const dir of runningStores(list)) offer(dir, 'profile');
  for (const event of events) {
    if (event.kind === 'fostered') offer(storeRootOfCopy(event.copyPath), 'used before');
  }
  // Registered names go last, so one landing on a root already offered above
  // attaches to that row instead of duplicating it — see `offer`.
  for (const [name, root] of project(events).profiles) offer(root, 'registered', name);

  return stores;
}

/**
 * The account half of `resolveStoreArg`: a label, an e-mail, or a uuid prefix,
 * matched against the accounts `knownStores` actually holds — not every account
 * the ledger has ever heard of, which would happily resolve a name to a store
 * that was retired years ago. `undefined` means none of the three named this
 * account at all, which is not the same as naming it ambiguously; the caller
 * moves on to the substring pass for the first and throws for the second.
 */
function resolveByAccount(
  arg: string,
  stores: KnownStore[],
  state: LedgerState,
): StoreLayout | undefined {
  const uuids = [
    ...new Set(
      stores.map((store) => store.accountUuid).filter((u): u is string => u !== undefined),
    ),
  ];
  const wanted = arg.toLowerCase();

  const byLabel = uuids.filter((uuid) => state.labels.get(uuid)?.toLowerCase() === wanted);
  const byEmail = byLabel.length
    ? []
    : uuids.filter((uuid) => state.identities.get(uuid)?.email?.toLowerCase() === wanted);

  let matched: string[];
  if (byLabel.length) matched = byLabel;
  else if (byEmail.length) matched = byEmail;
  else {
    const prefix = uniquePrefix(uuids, arg, (uuid) => uuid);
    if (prefix.kind === 'none') return undefined;
    matched = prefix.kind === 'one' ? [prefix.id] : prefix.ids;
  }

  // A label or an e-mail names an account, not an installation, and the same
  // account can sit in more than one store — the case `--store` cannot guess
  // through, same as an ambiguous path piece below.
  const matchingStores = stores.filter(
    (store) => store.accountUuid !== undefined && matched.includes(store.accountUuid),
  );
  if (matchingStores.length === 1) return layoutFor(matchingStores[0]!.root);

  const lines = matchingStores.map((store) => `  ${store.root}`).join('\n');
  throw new Error(
    `--store "${arg}" names an account last seen by ${matchingStores.length} installations:\n${lines}`,
  );
}

/**
 * What `--store` names: a directory, a registered profile name, an account, or
 * a distinctive piece of a path.
 *
 * In that order. A path that exists is always taken as a path, so this can only
 * add meanings, never change one. A registered name — `foster profile register
 * <path> --name work` — is exact and deliberate, so it is tried next and wins
 * over a path piece that happens to match too; matching it against a profile
 * that has since gone still resolves the name, just to a refusal that says so,
 * because a name is the one thing `knownStores` remembers on purpose past the
 * directory disappearing. Then an account — a label, an e-mail, or a unique
 * uuid prefix, the same three `foster clients` already prints — because
 * `--store work@example.com` and `--store llm03` are both things a person
 * reaches for before they reach for a path. Last, the paths are long and a
 * profile's is the sort of thing nobody remembers exactly — `--store work` for
 * `D:\Claude-Work` is the same abbreviation the identifier flags already allow.
 *
 * An abbreviation matching two installations is reported rather than guessed at,
 * for the same reason `--from` refuses an ambiguous prefix: with `--store` the
 * guess decides which installation gets written to.
 */
export function resolveStoreArg(
  arg: string | undefined,
  // A thunk, not the events: the two answers that need no ledger at all are the
  // two every ordinary run takes, and reading it for them would be work done to
  // be thrown away.
  readEvents: () => LedgerEvent[],
  env: NodeJS.ProcessEnv = process.env,
  list: ProcessLister = readProcesses,
): StoreLayout {
  if (arg === undefined) return resolveStore(undefined, env);
  if (existsSync(arg)) return layoutFor(arg);

  const events = readEvents();
  const stores = knownStores(events, env, list);
  const wanted = arg.toLowerCase();

  const named = stores.find((store) => store.name?.toLowerCase() === wanted);
  if (named) {
    if (!named.exists) {
      throw new Error(
        `profile "${named.name}" is registered at ${named.root}, which is gone. ` +
          `foster profile forget ${named.name}, or foster profile register <path> --name ${named.name}`,
      );
    }
    return layoutFor(named.root);
  }

  const byAccount = resolveByAccount(arg, stores, project(events));
  if (byAccount) return byAccount;

  // A registered name already had its chance above; a gone profile matching
  // here by path piece would resolve to a directory that is not there, so it
  // is excluded the same way `knownStores` excludes every other gone entry.
  const matches = stores.filter(
    (store) => store.exists && store.root.toLowerCase().includes(wanted),
  );

  if (matches.length === 1) return layoutFor(matches[0]!.root);
  if (matches.length > 1) {
    const lines = matches.map((store) => `  ${store.root}`).join('\n');
    throw new Error(`--store "${arg}" matches ${matches.length} installations:\n${lines}`);
  }

  // Nothing on disk and nothing known — by name, by account, or by path piece:
  // a typo, most likely, and continuing would quietly report an empty store
  // rather than say so.
  const known = stores
    .map(
      (store) =>
        `  ${store.name ? `${store.name} — ` : ''}${store.root}${store.exists ? '' : ' (gone)'}`,
    )
    .join('\n');
  throw new Error(
    `--store "${arg}" is not a directory, a registered profile name, a known account, or a piece ` +
      `of a known path.` +
      (known ? `\nKnown installations:\n${known}` : ''),
  );
}
