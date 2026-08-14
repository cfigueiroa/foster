import pc from 'picocolors';
import { isCancel, type Ui } from '../tui/ui.js';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import { listAccountDirs, samePath } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import {
  continuedNote,
  continuedSince,
  liveBranchNote,
  TWO_SIDEBARS,
  twoLiveSidebars,
} from '../engine/continued.js';
import { currentAccount } from '../engine/account.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { findDuplicates } from '../engine/duplicates.js';
import { knownStores, resolveStoreArg } from '../engine/stores.js';
import { AppRunningError } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import {
  identityLabel,
  readIdentityFromCache,
  resolveIdentity,
  worthRecording,
} from '../store/identity.js';
import { describeWriters, sessionRegistryRoots } from '../store/liveSessions.js';
import { findRestorable } from '../store/restore.js';
import { scanAccount, type KnownCopies } from '../store/scanner.js';
import { applyFilter, byRecency, parseSince } from '../domain/filter.js';
import { liveConversationIds, scanFosterable } from '../ops/foster.js';
import { partitionByStore } from '../ops/active.js';
import { applyLabel } from '../ops/label.js';
import {
  aborted,
  askText,
  BACK,
  type Choice,
  type Maybe,
  pickMany,
  selectOrBack,
} from './prompts.js';
import { formatAge, formatDate, outcomeLine, shortId } from './render.js';
import { describeRef, labelsOf, short } from './names.js';
import { offerRestart } from './desktopUi.js';

/**
 * Give an account a name.
 *
 * The command existed from the start and nobody found it: the one screen where
 * the UUIDs are unreadable is the one that never mentioned there was a way to
 * fix that. It is a menu entry now.
 */
export async function labelFlow(
  ui: Ui,
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
): Promise<void> {
  const labels = labelsOf(ledger);
  const accounts = [...new Set(listAccountDirs(store).map((ref) => ref.accountUuid))];

  // Said once, here, because this screen is the only place the gap shows: the
  // app knows the account's email and foster does not, since the only copy on
  // disk is inside the OAuth token cache — which foster does not read, on
  // purpose. Pairing the two is the whole job of this screen, and the answer is
  // on screen in the other window.
  ui.log.info(
    pc.dim(
      'Claude Desktop shows the account email under your avatar. foster cannot read it —\n' +
        'it lives in the token cache — so this is where the two get introduced.',
    ),
  );

  const picked = await selectOrBack(
    ui,
    'Which account?',
    accounts.map((accountUuid) => ({
      value: accountUuid,
      label: short(accountUuid) + (accountUuid === target.accountUuid ? pc.green(' (in use)') : ''),
      hint: labels.get(accountUuid) ? `currently "${labels.get(accountUuid)}"` : 'unnamed',
    })),
    // The account in use is the one whose name you can actually look up right
    // now, so it is where the cursor starts.
    target.accountUuid,
  );
  if (aborted(picked)) return;

  // For the signed-in account, the app's cache usually knows the name and email
  // already — offer it as the starting text so the common case is a keystroke.
  // Read at rest, never over the network; absent when the schema has moved.
  // Known for any account foster has ever looked at, not only the one signed in:
  // the ledger remembers what the cache forgets, which is what makes naming an
  // account you are not currently in possible at all.
  const cached = picked === target.accountUuid ? readIdentityFromCache(store, picked) : undefined;
  const remembered = project(ledger.read()).identities.get(picked);

  // Written down the way whoami writes it, and gated the same way. This screen
  // is often the last thing visited before signing out — naming accounts is
  // what people do on their way somewhere else — and a sighting left
  // unrecorded is exactly the one the ledger cannot offer after the switch,
  // when the cache describes the new account and this screen is asked about
  // the old one.
  if (cached && worthRecording(cached, remembered)) {
    ledger.append({
      kind: 'account_identity_seen',
      accountUuid: picked,
      ...(cached.email ? { email: cached.email } : {}),
      ...(cached.name ? { name: cached.name } : {}),
      ...(cached.plan ? { plan: cached.plan } : {}),
      ...(cached.profile ? { profile: cached.profile } : {}),
    });
  }

  const identity = resolveIdentity(cached, remembered);
  const known = identityLabel(identity);
  // A saved label wins the prompt, because it was a deliberate choice. But a
  // known identity that disagrees with it is shown rather than hidden — that is
  // how a label left stale by an early experiment gets noticed.
  const saved = labels.get(picked);
  if (known && saved && saved !== known) {
    ui.log.info(pc.dim(`This account is ${known}.`));
    // Said only for an answer that came out of memory, because that is the one
    // this screen cannot argue with: the cache it was read from has moved on,
    // so nothing here will ever contradict it. A reading taken fresh needs no
    // escape hatch — the next read corrects it by itself.
    if (identity?.remembered) {
      ui.log.info(pc.dim(`If that is not this account: foster label ${picked} --forget`));
    }
  }
  const suggested = saved ?? known;

  const name = await askText(ui, 'Call it', {
    ...(suggested === undefined ? {} : { initialValue: suggested }),
    // Worded as an example: a bare "work" here read as a default that Enter
    // would accept, when accepting it actually submits nothing at all.
    placeholder: 'e.g. work',
  });
  if (aborted(name) || !name.trim()) {
    ui.log.info('Left as it was.');
    return;
  }

  applyLabel(ledger, picked, name.trim(), accounts, target.accountUuid);
  ui.log.success(`${short(picked)} is now "${name.trim()}".`);
}

interface SourceOption {
  refs: AccountRef[];
  label: string;
  hint: string;
}

/** What a directory of sessions offers, as the picker needs to describe it. */
function summariseSource(store: StoreLayout, ref: AccountRef, copies: KnownCopies) {
  const sessions = scanAccount(store, ref, copies);
  // Counted with the same filter the next screen applies, so the number here is
  // the number the user will actually be offered.
  const fosterable = applyFilter(sessions, {});
  const lastActivity = sessions.reduce(
    (latest, s) => Math.max(latest, s.data.lastActivityAt ?? 0),
    0,
  );
  return { fosterable: fosterable.length, lastActivity };
}

/** Which store the sessions come from, and which directories inside it. */
export interface SourcePick {
  store: StoreLayout;
  refs: AccountRef[];
}

/**
 * Which installation, by path.
 *
 * Everything foster already knows about is listed — the installed app, whatever
 * is running, and the profiles the ledger has been used in. Typing one out stays
 * available for a store that is none of those: it announces itself nowhere.
 */
async function pickStore(
  ui: Ui,
  current: StoreLayout,
  ledger: Ledger,
  message: string,
): Promise<Maybe<StoreLayout>> {
  const labels = labelsOf(ledger);
  const options = knownStores(ledger.read())
    .filter((known) => !samePath(known.root, current.root))
    .map((known) => ({
      value: known.root,
      label: known.root,
      // Which account it holds is the reason to pick one profile over another,
      // and a store with none is one that acting in it will refuse.
      hint: [
        known.hint,
        ...(known.running ? ['running'] : []),
        known.accountUuid
          ? (labels.get(known.accountUuid) ?? short(known.accountUuid))
          : 'not signed in',
      ].join(' · '),
    }));

  const picked = await selectOrBack(ui, message, [
    ...options,
    { value: TYPE_A_PATH, label: 'Type a path…', hint: 'an installation not listed here' },
  ]);
  if (aborted(picked)) return BACK;

  let root = picked;
  if (picked === TYPE_A_PATH) {
    const answer = await askText(ui, 'Path to the userData directory', {
      placeholder: '%LOCALAPPDATA%\\Claude-Work',
    });
    if (aborted(answer) || !answer.trim()) return BACK;
    root = answer.trim();
  }

  try {
    // The same resolution the flags use, so a path typed here can be a piece of
    // one — and a typo is reported rather than turning into an empty store.
    return resolveStoreArg(root, () => ledger.read());
  } catch (error) {
    ui.log.error(error instanceof Error ? error.message : String(error));
    return BACK;
  }
}

async function chooseOtherStore(
  ui: Ui,
  current: StoreLayout,
  ledger: Ledger,
  labels: Map<string, string>,
): Promise<Maybe<SourcePick>> {
  const store = await pickStore(ui, current, ledger, 'Which installation?');
  if (aborted(store)) return BACK;

  if (accountsIn(store).length === 0) {
    ui.log.info('That installation has no session directories yet — nothing to bring from it.');
    return BACK;
  }

  // Same picker as the local one, so both screens read alike and offer the same
  // granularity: a profile with two accounts is no less worth narrowing.
  const refs = await chooseAccounts(ui, store, labels, {
    message: 'Which account in that installation?',
    copies: copySessionIds(ledger.read()),
  });
  if (aborted(refs) || refs === OTHER_STORE) return BACK;
  return { store, refs };
}

/**
 * Point the whole menu at a different installation.
 *
 * Reading from another profile was already possible; acting *in* one meant
 * quitting and relaunching with --store, which is a strange thing to ask of a
 * menu that stays open on purpose.
 */
export async function switchInstallation(
  ui: Ui,
  current: StoreLayout,
  ledger: Ledger,
): Promise<Maybe<{ store: StoreLayout; target: AccountRef }>> {
  const store = await pickStore(ui, current, ledger, 'Work on which installation?');
  if (aborted(store)) return BACK;

  const target = currentAccount(store, listAccountDirs(store));
  if (!target) {
    ui.log.error(
      'That installation has no signed-in account yet — open Claude Desktop on it once first.',
    );
    return BACK;
  }
  return { store, target };
}

const TYPE_A_PATH = '__type_a_path';

/**
 * The account/organization picker for one store.
 *
 * Shared by the store you are signed into and by any other profile, so both
 * screens read the same and offer the same granularity. Taking a whole account
 * and taking one of its organizations are both reasonable, and only the user
 * knows which they meant.
 *
 * Ticked rather than chosen: the scan below takes a list of directories and
 * always did, so a single choice was a limit of this screen alone — someone
 * consolidating three accounts had to run the whole flow three times.
 */
async function chooseAccounts(
  ui: Ui,
  store: StoreLayout,
  labels: Map<string, string>,
  options: {
    exclude?: AccountRef;
    currentAccountUuid?: string;
    message: string;
    extra?: Choice[];
    copies?: KnownCopies;
  },
): Promise<Maybe<AccountRef[] | typeof OTHER_STORE>> {
  // Callers check for emptiness before asking. Conflating "nothing to offer"
  // with BACK sent someone who pressed Back into the other-profile picker.
  const sources = accountsIn(store, options.exclude);
  const byAccount = new Map<string, AccountRef[]>();
  for (const ref of sources) {
    byAccount.set(ref.accountUuid, [...(byAccount.get(ref.accountUuid) ?? []), ref]);
  }

  const copies = options.copies ?? new Set<string>();
  const stats = new Map(sources.map((ref) => [refKey(ref), summariseSource(store, ref, copies)]));
  const totals = (refs: AccountRef[]) =>
    refs.reduce(
      (sum, ref) => {
        const stat = stats.get(refKey(ref))!;
        return {
          fosterable: sum.fosterable + stat.fosterable,
          lastActivity: Math.max(sum.lastActivity, stat.lastActivity),
        };
      },
      { fosterable: 0, lastActivity: 0 },
    );

  const choices: SourceOption[] = [];

  // Only when there is more than one account to gather: with a single one its
  // own shortcut already says the same thing, and two rows that mean exactly the
  // same is the sort of list nobody trusts.
  if (byAccount.size > 1) {
    choices.push({
      refs: sources,
      label: `${pc.bold('Everything here')} — all ${byAccount.size} accounts`,
      hint: describeStat(totals(sources)),
    });
  }

  for (const [accountUuid, refs] of byAccount) {
    const name = labels.get(accountUuid) ?? short(accountUuid);
    const suffix = accountUuid === options.currentAccountUuid ? pc.green(' (this account)') : '';

    if (refs.length > 1) {
      choices.push({
        refs,
        label: `${pc.bold(name)}${suffix} — everything, all ${refs.length} organizations`,
        hint: describeStat(totals(refs)),
      });
    }
    for (const ref of refs) {
      const indent = refs.length > 1 ? '   ' : '';
      choices.push({
        refs: [ref],
        label: `${indent}${pc.bold(name)}${suffix} ${pc.dim('/ org')} ${short(ref.organizationUuid)}`,
        hint: describeStat(stats.get(refKey(ref))!),
      });
    }
  }

  const picked = await pickMany(
    ui,
    `${options.message} ${pc.dim('· space to tick, enter to accept')}`,
    [
      ...choices.map((choice, index) => ({
        value: String(index),
        label: choice.label,
        hint: choice.hint,
      })),
      ...(options.extra ?? []),
    ],
  );

  if (aborted(picked)) return BACK;

  // Another installation is a different scan rather than another tick: one run
  // reads one store, so asking for both is said out loud instead of being
  // quietly resolved to whichever the code happened to check first.
  if (picked.includes(OTHER_STORE)) {
    if (picked.length > 1) {
      ui.log.error(
        'One installation at a time — untick either the accounts here or the other one.',
      );
      return BACK;
    }
    return OTHER_STORE;
  }

  // Ticking an account and one of its organizations is not a contradiction, so
  // the rows are merged rather than refused: what the user pointed at is the
  // union, and a directory named twice is still one directory.
  const refs = new Map<string, AccountRef>();
  for (const value of picked) {
    for (const ref of choices[Number(value)]?.refs ?? []) refs.set(refKey(ref), ref);
  }

  if (refs.size === 0) {
    ui.log.info('Nothing ticked.');
    return BACK;
  }
  return [...refs.values()];
}

/** The directories of one store that are eligible as a source. */
function accountsIn(store: StoreLayout, exclude?: AccountRef): AccountRef[] {
  return listAccountDirs(store).filter(
    (ref) =>
      !exclude ||
      !(
        ref.accountUuid === exclude.accountUuid && ref.organizationUuid === exclude.organizationUuid
      ),
  );
}

async function chooseSource(
  ui: Ui,
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
): Promise<Maybe<SourcePick>> {
  const labels = labelsOf(ledger);

  // An installation with nothing else in it is not a dead end: another profile
  // is still reachable from here.
  if (accountsIn(store, target).length === 0) {
    ui.log.info('No other account in this installation.');
    return chooseOtherStore(ui, store, ledger, labels);
  }

  // Only the exact directory the sidebar reads is excluded, not the whole
  // account. Another organization of the *same* account is just as invisible as
  // another account's, so it is just as fosterable — a session filed under a
  // second organization would otherwise be unreachable.
  const picked = await chooseAccounts(ui, store, labels, {
    exclude: target,
    currentAccountUuid: target.accountUuid,
    copies: copySessionIds(ledger.read()),
    message: 'Where should the sessions come from?',
    extra: [
      {
        value: OTHER_STORE,
        label: 'Another installation or profile…',
        hint: 'a second Claude Desktop store',
      },
    ],
  });

  if (aborted(picked)) return BACK;
  if (picked === OTHER_STORE) return chooseOtherStore(ui, store, ledger, labels);
  return { store, refs: picked };
}

const OTHER_STORE = '__other_store';

function describeStat(stat: { fosterable: number; lastActivity: number }): string {
  return `${stat.fosterable} session(s) · last used ${formatAge(stat.lastActivity || undefined)}`;
}

const refKey = (ref: AccountRef) => `${ref.accountUuid}/${ref.organizationUuid}`;

/**
 * Where the copies are written.
 *
 * Defaults to the directory the sidebar reads, which is what almost everyone
 * wants — but any organization is a valid destination. Writing into one the app
 * is not currently on is a legitimate thing to do (staging an account before
 * switching to it); it just will not show anything until you get there, which is
 * why it says so.
 */
async function chooseTarget(
  ui: Ui,
  store: StoreLayout,
  ledger: Ledger,
  current: AccountRef,
  sources: AccountRef[],
): Promise<Maybe<AccountRef>> {
  const labels = labelsOf(ledger);
  const taken = new Set(sources.map(refKey));

  const others = listAccountDirs(store).filter(
    (ref) => !taken.has(refKey(ref)) && refKey(ref) !== refKey(current),
  );
  if (others.length === 0) {
    ui.log.info('There is nowhere else to send them: every other directory is a source.');
    return BACK;
  }

  const picked = await selectOrBack(ui, 'Where should the copies go?', [
    {
      value: refKey(current),
      label: describeRef(labels, current),
      hint: 'the account in use — they show up here after a restart',
    },
    ...others.map((ref) => ({
      value: refKey(ref),
      label: describeRef(labels, ref),
      hint: 'a different account — they appear only once you switch to it',
    })),
  ]);

  if (aborted(picked)) return BACK;
  return [current, ...others].find((ref) => refKey(ref) === picked) ?? BACK;
}

const PICK_LIMIT = 40;

/**
 * Which of the available sessions to take, and whether the user named them one
 * by one. Ticking a session is a decision about that session, which is what lets
 * it come back after being deleted in the app; a sweep is not.
 */
async function chooseSessions(
  ui: Ui,
  sessions: DiscoveredSession[],
): Promise<Maybe<{ sessions: DiscoveredSession[]; explicit: boolean }>> {
  const how = await selectOrBack(ui, `${sessions.length} session(s) available. Which ones?`, [
    { value: 'all', label: 'All of them' },
    { value: 'pick', label: 'Pick them from a list', hint: 'tick the ones you want' },
    { value: 'since', label: 'Only recent ones', hint: 'e.g. the last 30 days' },
    { value: 'title', label: 'Matching a title' },
    { value: 'cwd', label: 'Matching a working directory' },
  ]);
  if (aborted(how)) return BACK;
  if (how === 'all') return { sessions, explicit: false };
  if (how === 'pick') {
    const picked = await pickSessions(ui, sessions);
    return aborted(picked) ? BACK : { sessions: picked, explicit: true };
  }

  const prompts = {
    since: { message: 'How far back?', placeholder: '30d' },
    title: { message: 'Title contains', placeholder: 'refactor' },
    cwd: { message: 'Working directory contains', placeholder: 'my-project' },
  } as const;

  const prompt = prompts[how as keyof typeof prompts];
  const answer = await askText(ui, prompt.message, { placeholder: prompt.placeholder });
  if (aborted(answer)) return BACK;

  const value = answer.trim();
  if (!value) return { sessions, explicit: false };

  if (how === 'since') {
    const since = parseSince(value);
    if (since === undefined) {
      ui.log.error(`Could not read "${value}". Try 30d, 12h or 2w.`);
      return BACK;
    }
    return { sessions: applyFilter(sessions, { since }), explicit: false };
  }
  return {
    sessions: applyFilter(sessions, how === 'title' ? { title: value } : { cwd: value }),
    explicit: false,
  };
}

/**
 * Tick individual sessions.
 *
 * Capped, and honest about the cap: a list of several hundred titles is not
 * something anyone reads, and silently offering only part of it would look like
 * the rest had gone missing.
 */
async function pickSessions(
  ui: Ui,
  sessions: DiscoveredSession[],
): Promise<Maybe<DiscoveredSession[]>> {
  const shown = sessions.slice(0, PICK_LIMIT);
  if (sessions.length > shown.length) {
    ui.log.warn(
      `Showing the ${PICK_LIMIT} most recently used of ${sessions.length}. ` +
        'Narrow by title, directory or age to reach the rest.',
    );
  }

  const picked = await pickMany(
    ui,
    'Space to tick, enter to accept',
    shown.map((session, index) => ({
      value: String(index),
      label: session.data.title ?? '(untitled)',
      hint: `${formatAge(session.data.lastActivityAt)}${session.data.cwd ? ` · ${session.data.cwd}` : ''}`,
    })),
  );
  if (aborted(picked)) return BACK;
  if (picked.length === 0) {
    ui.log.info('Nothing ticked.');
    return BACK;
  }
  return picked.map((index) => shown[Number(index)]!);
}

/** Says what was left out and why, rather than quietly showing a smaller number. */
function reportHidden(ui: Ui, all: DiscoveredSession[], offered: DiscoveredSession[]): void {
  const hidden = all.length - offered.length;
  if (hidden <= 0) return;

  const reasons = new Map<string, number>();
  for (const session of all) {
    const hiddenAsCopy = session.isCopy && !session.isStranded;
    if (session.reasons.length === 0 && !hiddenAsCopy) continue;
    const reason = hiddenAsCopy ? 'already a copy' : session.reasons.join(', ');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const detail = [...reasons].map(([reason, count]) => `${count} ${reason}`).join(', ');
  ui.log.info(pc.dim(`${hidden} not shown (${detail}) — they could never appear in the sidebar.`));
}

export async function fosterFlow(
  ui: Ui,
  store: StoreLayout,
  ledger: Ledger,
  current: AccountRef,
): Promise<void> {
  const source = await chooseSource(ui, store, ledger, current);
  if (aborted(source)) return;

  const all = scanFosterable(source.store, source.refs, ledger);
  const available = byRecency(applyFilter(all, {}));
  reportHidden(ui, all, available);

  if (available.length === 0) {
    ui.log.info('Nothing there can be fostered.');
    return;
  }

  if (!samePath(source.store.root, store.root)) {
    ui.note(source.store.root, 'Reading from another installation');
  }

  const choice = await chooseSessions(ui, available);
  if (aborted(choice)) return;
  const { sessions: selected, explicit } = choice;
  if (selected.length === 0) {
    ui.log.info('Nothing matches that.');
    return;
  }

  // Preview before writing, capped: a few hundred titles would scroll the
  // decision off the screen.
  const preview = selected.slice(0, 10);
  ui.note(
    [
      ...preview.map(
        (s) => `${pc.dim(formatDate(s.data.lastActivityAt))}  ${s.data.title ?? '(untitled)'}`,
      ),
      ...(selected.length > preview.length
        ? [pc.dim(`… and ${selected.length - preview.length} more`)]
        : []),
    ].join('\n'),
    `${selected.length} session(s) selected`,
  );

  await confirmAndWrite(ui, store, ledger, current, source, selected, { explicit });
}

/**
 * The last screen before anything is written.
 *
 * Destination and prefix live here rather than as steps of their own: both have
 * an answer that is right nearly every time, and asking about them separately
 * taxed every run to serve the rare one. Naming them in the confirmation keeps
 * them visible, and changing either is one keystroke away.
 */
async function confirmAndWrite(
  ui: Ui,
  store: StoreLayout,
  ledger: Ledger,
  current: AccountRef,
  source: SourcePick,
  selected: DiscoveredSession[],
  options: { verb?: string; explicit?: boolean } = {},
): Promise<void> {
  const { verb = 'Foster', explicit = false } = options;
  let target = current;
  let prefix = DEFAULT_PREFIX;

  for (;;) {
    const labels = labelsOf(ledger);
    const decision = await ui.select({
      message: `${verb} ${selected.length} session(s) into ${describeRef(labels, target)}?`,
      options: [
        { value: 'go', label: `Yes, ${verb.toLowerCase()} them` },
        {
          value: 'elsewhere',
          label: 'Send them somewhere else',
          hint: `now: ${describeRef(labels, target)}`,
        },
        {
          value: 'prefix',
          label: 'Change the title prefix',
          hint: prefix ? `now: "${prefix}"` : 'now: none',
        },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'go',
    });

    // Anything other than the four known answers is treated as a refusal rather
    // than looped on: writing is the irreversible direction.
    if (isCancel(decision) || !['go', 'elsewhere', 'prefix'].includes(String(decision))) {
      ui.log.info('Nothing written.');
      return;
    }
    if (decision === 'go') break;

    if (decision === 'prefix') {
      const answer = await askText(ui, 'Title prefix for the copies', {
        initialValue: prefix,
        placeholder: DEFAULT_PREFIX,
      });
      if (!aborted(answer)) prefix = answer;
      continue;
    }

    // Only directories in the destination store can be excluded as "already a
    // source"; a source in another store shares nothing with it.
    const taken = samePath(source.store.root, store.root) ? source.refs : [];
    const chosen = await chooseTarget(ui, store, ledger, current, taken);
    if (!aborted(chosen)) target = chosen;
  }

  try {
    const outcomes = fosterSessions(selected, {
      store,
      ledger,
      target,
      sourceStore: source.store.root,
      prefix,
      explicit,
      // The menu is where most people foster, so the branching hazard has to be
      // said here rather than only in the command.
      live: liveConversationIds(),
    });
    const counts = summariseOutcomes(outcomes);
    for (const outcome of outcomes.slice(0, 10)) ui.log.message(outcomeLine(outcome));
    if (outcomes.length > 10) ui.log.message(pc.dim(`… and ${outcomes.length - 10} more`));

    ui.log.success(
      `${counts.fostered} written, ${counts.skipped} skipped, ${counts.failed} failed.`,
    );
    if (counts.fostered === 0) return;
    const writers = describeWriters(
      outcomes.map((outcome) => outcome.live).filter((id): id is string => Boolean(id)),
      sessionRegistryRoots(process.env),
    );
    if (writers.length > 0) ui.log.warn(liveBranchNote(writers));
    if (twoLiveSidebars(source.store, store)) ui.log.warn(TWO_SIDEBARS);

    if (refKey(target) !== refKey(current)) {
      ui.note(
        `These went to ${describeRef(labelsOf(ledger), target)}, which is not the account in use.\n` +
          'They appear once you sign into that account.',
        'One more step',
      );
      return;
    }
    await offerRestart(
      ui,
      store,
      'The sidebar is built when the app starts, so it has not changed yet.',
    );
  } catch (error) {
    if (error instanceof AppRunningError) ui.log.error(error.message);
    else throw error;
  }
}

/**
 * Undo a deletion.
 *
 * A session deleted in the app loses its pointer and keeps its conversation. The
 * app will not offer to bring it back — it records the deletion precisely so its
 * own recovery scan skips it — but writing a fresh pointer at that conversation
 * works, and for an accidental deletion nothing else does.
 */
export async function restoreFlow(
  ui: Ui,
  store: StoreLayout,
  ledger: Ledger,
  current: AccountRef,
): Promise<void> {
  const restorable = findRestorable(store);
  if (restorable.length === 0) {
    ui.log.info('Nothing to undo: no deleted session still has its conversation on disk.');
    return;
  }

  const picked = await pickMany(
    ui,
    `${restorable.length} deleted conversation(s) still on disk. Bring back which?`,
    restorable.slice(0, PICK_LIMIT).map((entry, index) => ({
      value: String(index),
      label: entry.facts.title ?? '(recovered conversation)',
      hint: `deleted ${formatAge(entry.tombstone.deletedAt)}${
        entry.facts.cwd ? ` · ${entry.facts.cwd}` : ''
      }`,
    })),
  );
  if (aborted(picked) || picked.length === 0) {
    ui.log.info('Nothing restored.');
    return;
  }

  const selected = picked.map((index) => restorable[Number(index)]!.session);
  ui.note(
    'These are rebuilt from the conversation on disk. Titles and dates come from\n' +
      'the transcript; the model and permission settings the session had are gone.',
    'What comes back',
  );

  await confirmAndWrite(ui, store, ledger, current, { store, refs: [] }, selected, {
    verb: 'Restore',
  });
}

export async function returnFlow(ui: Ui, store: StoreLayout, ledger: Ledger): Promise<void> {
  const everything = listActive(project(ledger.read()));

  // The ledger spans every installation foster has written into. Undoing here
  // should not reach into another profile's store without being asked, so the
  // rest are counted rather than silently included.
  const { here: active, elsewhere: elsewhereCopies } = partitionByStore(everything, store);
  const elsewhere = elsewhereCopies.length;

  if (active.length === 0) {
    ui.log.info(
      elsewhere > 0
        ? `Nothing is fostered here. ${elsewhere} cop${elsewhere === 1 ? 'y is' : 'ies are'} in another installation — switch to it to undo them.`
        : 'Nothing is fostered.',
    );
    return;
  }
  if (elsewhere > 0) {
    ui.log.info(pc.dim(`${elsewhere} more in another installation; switch to it to undo those.`));
  }

  // Offered only when there is something to offer, and named by what it fixes
  // rather than by how it works: this is the screen someone reaches after seeing
  // the same conversation twice in the sidebar.
  const duplicates = findDuplicates(store, active).copies;

  // Grouped by the account they were written into, because that is how copies
  // pile up: one sweep per account you have signed into. Offered only when
  // there is more than one, so the ordinary case gains no extra question.
  const accounts = groupByTarget(active, ledger);

  const scope = await selectOrBack(ui, `${active.length} fostered session(s). Send back which?`, [
    { value: 'all', label: 'All of them' },
    ...(accounts.length > 1
      ? [
          {
            value: 'account',
            label: 'Only those in one account',
            hint: 'clean up an account you stopped using',
          },
        ]
      : []),
    { value: 'pick', label: 'Pick them from a list', hint: 'tick the ones you want' },
    { value: 'title', label: 'Only those matching a title' },
    ...(duplicates.length > 0
      ? [
          {
            value: 'duplicates',
            label: 'Just the duplicates',
            hint: `${duplicates.length} of a conversation this account already has`,
          },
        ]
      : []),
  ]);
  if (aborted(scope)) return;

  const chosen = await narrowFosterings(ui, active, scope, duplicates, accounts);
  if (aborted(chosen)) return;
  if (chosen.length === 0) {
    ui.log.info('Nothing matches.');
    return;
  }

  const go = await ui.confirm({
    message: `Remove ${chosen.length} fostered cop${chosen.length === 1 ? 'y' : 'ies'}?`,
    initialValue: true,
  });
  if (isCancel(go) || !go) {
    ui.log.info('Nothing removed.');
    return;
  }

  try {
    // Measured before the copies go: for entries written before the ledger kept
    // the conversation id, the copy itself is where that id is read from. This is
    // the screen the fright happens on — the row comes back in the original
    // account wearing the date it had the day it was fostered.
    const continued = continuedSince(store, chosen);
    const outcomes = returnFosterings(chosen, { store, ledger });
    const counts = summariseOutcomes(outcomes);
    ui.log.success(`${counts.returned} returned, ${counts.failed} failed.`);
    if (continued.length > 0) ui.log.info(continuedNote(continued.length));
    await offerRestart(ui, store, 'They are still in the sidebar until the app starts again.');
  } catch (error) {
    // The gate refuses only for copies the running app may be holding in memory,
    // where deleting the file would simply make the app write it back.
    if (error instanceof AppRunningError) {
      ui.log.error(error.message);
      await offerRestart(ui, store, 'Closing the app first is what makes this work.');
    } else throw error;
  }
}

/** The accounts copies were written into, most-populated first, with names when known. */
function groupByTarget(
  active: ActiveFostering[],
  ledger: Ledger,
): { accountUuid: string; count: number; label: string }[] {
  const labels = labelsOf(ledger);
  const counts = new Map<string, number>();
  for (const fostering of active) {
    counts.set(fostering.target.accountUuid, (counts.get(fostering.target.accountUuid) ?? 0) + 1);
  }

  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([accountUuid, count]) => ({
      accountUuid,
      count,
      label: labels.get(accountUuid) ?? shortId(accountUuid),
    }));
}

async function narrowFosterings(
  ui: Ui,
  active: ActiveFostering[],
  scope: string,
  duplicates: ActiveFostering[] = [],
  accounts: { accountUuid: string; count: number; label: string }[] = [],
): Promise<Maybe<ActiveFostering[]>> {
  if (scope === 'all') return active;
  if (scope === 'duplicates') return duplicates;

  if (scope === 'account') {
    const picked = await selectOrBack(
      ui,
      'Copies in which account?',
      accounts.map((account) => ({
        value: account.accountUuid,
        label: account.label,
        hint: `${account.count} cop${account.count === 1 ? 'y' : 'ies'}`,
      })),
    );
    if (aborted(picked)) return BACK;
    return active.filter((f) => f.target.accountUuid === picked);
  }

  if (scope === 'pick') {
    const picked = await pickMany(
      ui,
      'Space to tick, enter to accept',
      active.slice(0, PICK_LIMIT).map((fostering, index) => ({
        value: String(index),
        label: fostering.originalTitle || shortId(fostering.originSessionId),
        hint: `fostered ${formatAge(fostering.fosteredAt)}`,
      })),
    );
    if (aborted(picked)) return BACK;
    if (picked.length === 0) return BACK;
    return picked.map((index) => active[Number(index)]!);
  }

  const needle = await askText(ui, 'Original title contains');
  if (aborted(needle)) return BACK;
  const value = needle.trim().toLowerCase();
  return active.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(value));
}

export function abortInteractive(ui: Ui, message = 'Cancelled.'): void {
  ui.cancel(message);
}
