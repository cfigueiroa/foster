import { cancel, confirm, intro, isCancel, log, note, outro, select } from '@clack/prompts';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import {
  storeIdentity,
  listAccountDirs,
  listAgentAccountDirs,
  pickActiveOrganization,
  samePath,
  storeRootOfCopy,
} from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import {
  DesktopControlError,
  inspectDesktopFor,
  quitDesktop,
  startDesktop,
  type DesktopState,
} from '../engine/desktop.js';
import {
  continuedNote,
  continuedSince,
  TWO_SIDEBARS,
  twoLiveSidebars,
} from '../engine/continued.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { findDuplicates } from '../engine/duplicates.js';
import { knownStores, resolveStoreArg } from '../engine/stores.js';
import { AppRunningError, inspectApp } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';
import { copySessionIds, listActive, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { readConfig } from '../store/config.js';
import { findRestorable } from '../store/restore.js';
import { scanAccount, summariseAccount } from '../store/scanner.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { applyFilter, byRecency, parseSince } from './filters.js';
import {
  aborted,
  askText,
  BACK,
  type Choice,
  type Maybe,
  pickMany,
  selectOrBack,
} from './prompts.js';
import {
  abbreviate,
  accountTree,
  formatAge,
  formatDate,
  groupByAccount,
  outcomeLine,
  shortId,
} from './render.js';

/**
 * Abbreviations for every identifier in the store, computed once per run.
 *
 * Held here rather than threaded through a dozen signatures: it is derived from
 * the store, which does not change under a single invocation, and every screen
 * has to agree — an account that reads `9866b1e8` on one screen and `9866b1e8c4`
 * on the next is the sort of detail that makes people doubt they are looking at
 * the same thing.
 */
let names = new Map<string, string>();

function short(id: string): string {
  return names.get(id) ?? shortId(id);
}

function nameEverything(store: StoreLayout): void {
  const refs = [...listAccountDirs(store), ...listAgentAccountDirs(store)];
  // Accounts and organizations abbreviate independently: they are never compared
  // with each other, so a collision across the two kinds should not lengthen both.
  names = new Map([
    ...abbreviate(refs.map((ref) => ref.accountUuid)),
    ...abbreviate(refs.map((ref) => ref.organizationUuid)),
  ]);
}

export async function runInteractive(initialStore: StoreLayout, ledger: Ledger): Promise<void> {
  // Mutable because the menu can be pointed at a different installation without
  // relaunching; every screen below reads whichever one is current.
  let store = initialStore;
  intro(`${pc.bgCyan(pc.black(' foster '))} ${pc.dim(VERSION)}`);

  // Started before the store work and awaited only when it is about to be shown,
  // so a slow or unreachable network never delays the menu.
  const update = checkForUpdate();

  nameEverything(store);

  let target = resolveTarget(store);
  if (!target) {
    log.error('Could not determine which account is signed in. Open Claude Desktop once first.');
    outro('Nothing to do.');
    return;
  }

  showEnvironment(store, ledger, target);

  const status = await update;
  if (status?.outdated) {
    log.warn(`foster ${status.latest} is available (you have ${status.current}).`);
    log.message(pc.dim(status.command));
  }

  // The menu loops rather than exiting after one action: fostering is normally a
  // look, decide, act, verify cycle, and quitting between each step means
  // re-scanning and re-orienting every time.
  for (;;) {
    const choice = await select({
      message: 'What would you like to do?',
      options: [
        {
          value: 'foster',
          label: 'Bring sessions here',
          hint: "copy another account's sessions into this one",
        },
        {
          value: 'return',
          label: 'Send them back',
          hint: 'remove the copies, restoring the previous state',
        },
        {
          value: 'restore',
          label: 'Undo a deletion',
          hint: 'bring back a session deleted in the app',
        },
        { value: 'status', label: 'What foster has done', hint: 'copies currently in place' },
        {
          value: 'browse',
          label: 'What is on disk',
          hint: 'accounts, organizations and session counts',
        },
        { value: 'label', label: 'Name an account', hint: 'so you stop reading UUIDs' },
        {
          value: 'installation',
          label: 'Work on another installation',
          hint: 'point everything at a second profile',
        },
        {
          value: 'app',
          label: 'Claude Desktop',
          hint: 'restart it — and why that is what makes changes show up',
        },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (isCancel(choice) || choice === 'quit') {
      outro('Bye.');
      return;
    }

    switch (choice) {
      case 'foster':
        await fosterFlow(store, ledger, target);
        break;
      case 'return':
        await returnFlow(store, ledger);
        break;
      case 'restore':
        await restoreFlow(store, ledger, target);
        break;
      case 'status':
        showStatus(ledger, store);
        break;
      case 'browse':
        showAccounts(store, ledger, target);
        break;
      case 'label':
        await labelFlow(store, ledger, target);
        break;
      case 'installation': {
        const next = await switchInstallation(store, ledger);
        if (!aborted(next)) {
          store = next.store;
          target = next.target;
          nameEverything(store);
          showEnvironment(store, ledger, target);
        }
        break;
      }
      case 'app':
        await desktopFlow(store, target);
        break;
      default:
        // Every known answer is handled above, so anything else means the prompt
        // returned something this code does not understand. Looping on it would
        // spin forever; leaving is the one safe response.
        outro('Bye.');
        return;
    }
  }
}

/**
 * The account and organization directory the sidebar is currently reading.
 *
 * The config records the account but not the organization. When foster is
 * running inside a Code session the app spawned, the app has already put the
 * answer in the environment; otherwise it falls back to the heuristic in
 * pickActiveOrganization.
 */
function resolveTarget(
  store: StoreLayout,
  env: NodeJS.ProcessEnv = process.env,
): AccountRef | undefined {
  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) return undefined;

  const candidates = listAccountDirs(store).filter((a) => a.accountUuid === accountUuid);

  // The app sets this from the organization it is actually using, so it beats
  // guessing — but only for a directory that exists, so a stale value cannot
  // point the copies at nothing.
  const fromEnv = env.CLAUDE_CODE_ORGANIZATION_UUID;
  const declared = fromEnv && candidates.find((a) => a.organizationUuid === fromEnv);
  if (declared) return declared;

  return (
    pickActiveOrganization(candidates, store) ??
    listAgentAccountDirs(store).find((a) => a.accountUuid === accountUuid)
  );
}

function labelsOf(ledger: Ledger): Map<string, string> {
  return project(ledger.read()).labels;
}

/** Account and organization, using a human label for the account when one exists. */
function describeRef(labels: Map<string, string>, ref: AccountRef): string {
  return `${labels.get(ref.accountUuid) ?? short(ref.accountUuid)} ${pc.dim('/ org')} ${short(
    ref.organizationUuid,
  )}`;
}

function showEnvironment(store: StoreLayout, ledger: Ledger, target: AccountRef): void {
  const app = inspectApp(store);
  const active = listActive(project(ledger.read())).length;
  note(
    [
      `store       ${store.root}`,
      `signed in   ${describeRef(labelsOf(ledger), target)}`,
      `app         ${app.running ? pc.yellow('running') : pc.dim('not running')}`,
      `fostered    ${active === 0 ? pc.dim('nothing yet') : `${active} session(s)`}`,
    ].join('\n'),
    'Where you are',
  );
}

function showStatus(ledger: Ledger, store: StoreLayout): void {
  const active = listActive(project(ledger.read()));
  if (active.length === 0) {
    log.info('Nothing is fostered.');
    return;
  }

  // Where a copy lives is said whenever it is not here. On the ordinary
  // single-profile setup that is never, so nothing is added; the earlier rule
  // asked whether the copies were *spread* across installations, which stayed
  // silent in the one case that misleads — every copy in the other profile,
  // reading exactly like copies in this one.
  // A conversation that carried on since it was fostered is worth marking: the
  // row in the original account still shows the date it had that day, and left
  // unsaid the difference only surfaces as a scare after a return.
  const continued = new Set(continuedSince(store, active).map((c) => c.fostering.copySessionId));

  const duplicates = findDuplicates(store, active);
  if (duplicates.copies.length > 0) {
    log.warn(
      `${duplicates.copies.length} of these duplicate a conversation this account already had. ` +
        '"Send them back" offers to remove just those.',
    );
  }
  if (duplicates.appMade > 0) {
    log.info(
      pc.dim(
        `${duplicates.appMade} conversation(s) here have more than one card the app itself made. ` +
          'foster did not write those and will not remove them.',
      ),
    );
  }

  note(
    active
      .map((f) => {
        const root = storeRootOfCopy(f.copyPath);
        const where = samePath(root, store.root) ? '' : pc.dim(`  → ${root}`);
        const carried = continued.has(f.copySessionId) ? pc.dim('  (continued since)') : '';
        return `${pc.dim(formatDate(f.fosteredAt))}  ${f.originalTitle || shortId(f.originSessionId)}${carried}${where}`;
      })
      .join('\n'),
    `${active.length} fostered`,
  );
}

function showAccounts(store: StoreLayout, ledger: Ledger, target: AccountRef): void {
  const copies = copySessionIds(ledger.read());
  const rows = listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account, copies), target.accountUuid),
  );
  note(accountTree(groupByAccount(rows), labelsOf(ledger)), 'Accounts and their organizations');
}

/**
 * Give an account a name.
 *
 * The command existed from the start and nobody found it: the one screen where
 * the UUIDs are unreadable is the one that never mentioned there was a way to
 * fix that. It is a menu entry now.
 */
async function labelFlow(store: StoreLayout, ledger: Ledger, target: AccountRef): Promise<void> {
  const labels = labelsOf(ledger);
  const accounts = [...new Set(listAccountDirs(store).map((ref) => ref.accountUuid))];

  const picked = await selectOrBack(
    'Which account?',
    accounts.map((accountUuid) => ({
      value: accountUuid,
      label: short(accountUuid) + (accountUuid === target.accountUuid ? pc.green(' (in use)') : ''),
      hint: labels.get(accountUuid) ? `currently "${labels.get(accountUuid)}"` : 'unnamed',
    })),
  );
  if (aborted(picked)) return;

  const name = await askText('Call it', {
    ...(labels.get(picked) === undefined ? {} : { initialValue: labels.get(picked)! }),
    placeholder: 'work',
  });
  if (aborted(name) || !name.trim()) {
    log.info('Left as it was.');
    return;
  }

  ledger.append({ kind: 'account_labelled', accountUuid: picked, label: name.trim() });
  log.success(`${short(picked)} is now "${name.trim()}".`);
}

interface SourceOption {
  refs: AccountRef[];
  label: string;
  hint: string;
}

/** What a directory of sessions offers, as the picker needs to describe it. */
function summariseSource(store: StoreLayout, ref: AccountRef) {
  const sessions = scanAccount(store, ref);
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

  const picked = await selectOrBack(message, [
    ...options,
    { value: TYPE_A_PATH, label: 'Type a path…', hint: 'an installation not listed here' },
  ]);
  if (aborted(picked)) return BACK;

  let root = picked;
  if (picked === TYPE_A_PATH) {
    const answer = await askText('Path to the userData directory', {
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
    log.error(error instanceof Error ? error.message : String(error));
    return BACK;
  }
}

async function chooseOtherStore(
  current: StoreLayout,
  ledger: Ledger,
  labels: Map<string, string>,
): Promise<Maybe<SourcePick>> {
  const store = await pickStore(current, ledger, 'Which installation?');
  if (aborted(store)) return BACK;

  if (accountsIn(store).length === 0) {
    log.info('That installation has no session directories yet — nothing to bring from it.');
    return BACK;
  }

  // Same picker as the local one, so both screens read alike and offer the same
  // granularity: a profile with two accounts is no less worth narrowing.
  const refs = await chooseAccounts(store, labels, {
    message: 'Which account in that installation?',
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
async function switchInstallation(
  current: StoreLayout,
  ledger: Ledger,
): Promise<Maybe<{ store: StoreLayout; target: AccountRef }>> {
  const store = await pickStore(current, ledger, 'Work on which installation?');
  if (aborted(store)) return BACK;

  const target = resolveTarget(store);
  if (!target) {
    log.error(
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
 */
async function chooseAccounts(
  store: StoreLayout,
  labels: Map<string, string>,
  options: { exclude?: AccountRef; currentAccountUuid?: string; message: string; extra?: Choice[] },
): Promise<Maybe<AccountRef[] | typeof OTHER_STORE>> {
  // Callers check for emptiness before asking. Conflating "nothing to offer"
  // with BACK sent someone who pressed Back into the other-profile picker.
  const sources = accountsIn(store, options.exclude);
  const byAccount = new Map<string, AccountRef[]>();
  for (const ref of sources) {
    byAccount.set(ref.accountUuid, [...(byAccount.get(ref.accountUuid) ?? []), ref]);
  }

  const stats = new Map(sources.map((ref) => [refKey(ref), summariseSource(store, ref)]));
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

  const picked = await selectOrBack(options.message, [
    ...choices.map((choice, index) => ({
      value: String(index),
      label: choice.label,
      hint: choice.hint,
    })),
    ...(options.extra ?? []),
  ]);

  if (aborted(picked)) return BACK;
  if (picked === OTHER_STORE) return OTHER_STORE;
  return choices[Number(picked)]?.refs ?? BACK;
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
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
): Promise<Maybe<SourcePick>> {
  const labels = labelsOf(ledger);

  // An installation with nothing else in it is not a dead end: another profile
  // is still reachable from here.
  if (accountsIn(store, target).length === 0) {
    log.info('No other account in this installation.');
    return chooseOtherStore(store, ledger, labels);
  }

  // Only the exact directory the sidebar reads is excluded, not the whole
  // account. Another organization of the *same* account is just as invisible as
  // another account's, so it is just as fosterable — a session filed under a
  // second organization would otherwise be unreachable.
  const picked = await chooseAccounts(store, labels, {
    exclude: target,
    currentAccountUuid: target.accountUuid,
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
  if (picked === OTHER_STORE) return chooseOtherStore(store, ledger, labels);
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
    log.info('There is nowhere else to send them: every other directory is a source.');
    return BACK;
  }

  const picked = await selectOrBack('Where should the copies go?', [
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
  sessions: DiscoveredSession[],
): Promise<Maybe<{ sessions: DiscoveredSession[]; explicit: boolean }>> {
  const how = await selectOrBack(`${sessions.length} session(s) available. Which ones?`, [
    { value: 'all', label: 'All of them' },
    { value: 'pick', label: 'Pick them from a list', hint: 'tick the ones you want' },
    { value: 'since', label: 'Only recent ones', hint: 'e.g. the last 30 days' },
    { value: 'title', label: 'Matching a title' },
    { value: 'cwd', label: 'Matching a working directory' },
  ]);
  if (aborted(how)) return BACK;
  if (how === 'all') return { sessions, explicit: false };
  if (how === 'pick') {
    const picked = await pickSessions(sessions);
    return aborted(picked) ? BACK : { sessions: picked, explicit: true };
  }

  const prompts = {
    since: { message: 'How far back?', placeholder: '30d' },
    title: { message: 'Title contains', placeholder: 'refactor' },
    cwd: { message: 'Working directory contains', placeholder: 'my-project' },
  } as const;

  const prompt = prompts[how as keyof typeof prompts];
  const answer = await askText(prompt.message, { placeholder: prompt.placeholder });
  if (aborted(answer)) return BACK;

  const value = answer.trim();
  if (!value) return { sessions, explicit: false };

  if (how === 'since') {
    const since = parseSince(value);
    if (since === undefined) {
      log.error(`Could not read "${value}". Try 30d, 12h or 2w.`);
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
async function pickSessions(sessions: DiscoveredSession[]): Promise<Maybe<DiscoveredSession[]>> {
  const shown = sessions.slice(0, PICK_LIMIT);
  if (sessions.length > shown.length) {
    log.warn(
      `Showing the ${PICK_LIMIT} most recently used of ${sessions.length}. ` +
        'Narrow by title, directory or age to reach the rest.',
    );
  }

  const picked = await pickMany(
    'Space to tick, enter to accept',
    shown.map((session, index) => ({
      value: String(index),
      label: session.data.title ?? '(untitled)',
      hint: `${formatAge(session.data.lastActivityAt)}${session.data.cwd ? ` · ${session.data.cwd}` : ''}`,
    })),
  );
  if (aborted(picked)) return BACK;
  if (picked.length === 0) {
    log.info('Nothing ticked.');
    return BACK;
  }
  return picked.map((index) => shown[Number(index)]!);
}

/** Says what was left out and why, rather than quietly showing a smaller number. */
function reportHidden(all: DiscoveredSession[], offered: DiscoveredSession[]): void {
  const hidden = all.length - offered.length;
  if (hidden <= 0) return;

  const reasons = new Map<string, number>();
  for (const session of all) {
    if (session.reasons.length === 0 && !session.isCopy) continue;
    const reason = session.isCopy ? 'already a copy' : session.reasons.join(', ');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const detail = [...reasons].map(([reason, count]) => `${count} ${reason}`).join(', ');
  log.info(pc.dim(`${hidden} not shown (${detail}) — they could never appear in the sidebar.`));
}

async function fosterFlow(store: StoreLayout, ledger: Ledger, current: AccountRef): Promise<void> {
  const source = await chooseSource(store, ledger, current);
  if (aborted(source)) return;

  const all = source.refs.flatMap((account) => scanAccount(source.store, account));
  const available = byRecency(applyFilter(all, {}));
  reportHidden(all, available);

  if (available.length === 0) {
    log.info('Nothing there can be fostered.');
    return;
  }

  if (!samePath(source.store.root, store.root)) {
    note(source.store.root, 'Reading from another installation');
  }

  const choice = await chooseSessions(available);
  if (aborted(choice)) return;
  const { sessions: selected, explicit } = choice;
  if (selected.length === 0) {
    log.info('Nothing matches that.');
    return;
  }

  // Preview before writing, capped: a few hundred titles would scroll the
  // decision off the screen.
  const preview = selected.slice(0, 10);
  note(
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

  await confirmAndWrite(store, ledger, current, source, selected, { explicit });
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
    const decision = await select({
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
      log.info('Nothing written.');
      return;
    }
    if (decision === 'go') break;

    if (decision === 'prefix') {
      const answer = await askText('Title prefix for the copies', {
        initialValue: prefix,
        placeholder: DEFAULT_PREFIX,
      });
      if (!aborted(answer)) prefix = answer;
      continue;
    }

    // Only directories in the destination store can be excluded as "already a
    // source"; a source in another store shares nothing with it.
    const taken = samePath(source.store.root, store.root) ? source.refs : [];
    const chosen = await chooseTarget(store, ledger, current, taken);
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
    });
    const counts = summariseOutcomes(outcomes);
    for (const outcome of outcomes.slice(0, 10)) log.message(outcomeLine(outcome));
    if (outcomes.length > 10) log.message(pc.dim(`… and ${outcomes.length - 10} more`));

    log.success(`${counts.fostered} written, ${counts.skipped} skipped, ${counts.failed} failed.`);
    if (counts.fostered === 0) return;
    if (twoLiveSidebars(source.store, store)) log.warn(TWO_SIDEBARS);

    if (refKey(target) !== refKey(current)) {
      note(
        `These went to ${describeRef(labelsOf(ledger), target)}, which is not the account in use.\n` +
          'They appear once you sign into that account.',
        'One more step',
      );
      return;
    }
    await offerRestart(
      store,
      'The sidebar is built when the app starts, so it has not changed yet.',
    );
  } catch (error) {
    if (error instanceof AppRunningError) log.error(error.message);
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
async function restoreFlow(store: StoreLayout, ledger: Ledger, current: AccountRef): Promise<void> {
  const restorable = findRestorable(store);
  if (restorable.length === 0) {
    log.info('Nothing to undo: no deleted session still has its conversation on disk.');
    return;
  }

  const picked = await pickMany(
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
    log.info('Nothing restored.');
    return;
  }

  const selected = picked.map((index) => restorable[Number(index)]!.session);
  note(
    'These are rebuilt from the conversation on disk. Titles and dates come from\n' +
      'the transcript; the model and permission settings the session had are gone.',
    'What comes back',
  );

  await confirmAndWrite(store, ledger, current, { store, refs: [] }, selected, { verb: 'Restore' });
}

async function returnFlow(store: StoreLayout, ledger: Ledger): Promise<void> {
  const everything = listActive(project(ledger.read()));

  // The ledger spans every installation foster has written into. Undoing here
  // should not reach into another profile's store without being asked, so the
  // rest are counted rather than silently included.
  const active = everything.filter((f) => samePath(storeRootOfCopy(f.copyPath), store.root));
  const elsewhere = everything.length - active.length;

  if (active.length === 0) {
    log.info(
      elsewhere > 0
        ? `Nothing is fostered here. ${elsewhere} cop${elsewhere === 1 ? 'y is' : 'ies are'} in another installation — switch to it to undo them.`
        : 'Nothing is fostered.',
    );
    return;
  }
  if (elsewhere > 0) {
    log.info(pc.dim(`${elsewhere} more in another installation; switch to it to undo those.`));
  }

  // Offered only when there is something to offer, and named by what it fixes
  // rather than by how it works: this is the screen someone reaches after seeing
  // the same conversation twice in the sidebar.
  const duplicates = findDuplicates(store, active).copies;

  const scope = await selectOrBack(`${active.length} fostered session(s). Send back which?`, [
    { value: 'all', label: 'All of them' },
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

  const chosen = await narrowFosterings(active, scope, duplicates);
  if (aborted(chosen)) return;
  if (chosen.length === 0) {
    log.info('Nothing matches.');
    return;
  }

  const go = await confirm({
    message: `Remove ${chosen.length} fostered cop${chosen.length === 1 ? 'y' : 'ies'}?`,
    initialValue: true,
  });
  if (isCancel(go) || !go) {
    log.info('Nothing removed.');
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
    log.success(`${counts.returned} returned, ${counts.failed} failed.`);
    if (continued.length > 0) log.info(continuedNote(continued.length));
    await offerRestart(store, 'They are still in the sidebar until the app starts again.');
  } catch (error) {
    // The gate refuses only for copies the running app may be holding in memory,
    // where deleting the file would simply make the app write it back.
    if (error instanceof AppRunningError) {
      log.error(error.message);
      await offerRestart(store, 'Closing the app first is what makes this work.');
    } else throw error;
  }
}

async function narrowFosterings(
  active: ActiveFostering[],
  scope: string,
  duplicates: ActiveFostering[] = [],
): Promise<Maybe<ActiveFostering[]>> {
  if (scope === 'all') return active;
  if (scope === 'duplicates') return duplicates;

  if (scope === 'pick') {
    const picked = await pickMany(
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

  const needle = await askText('Original title contains');
  if (aborted(needle)) return BACK;
  const value = needle.trim().toLowerCase();
  return active.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(value));
}

/* ------------------------------------------------------------------ *
 * Claude Desktop
 * ------------------------------------------------------------------ */

function describeDesktop(state: DesktopState): string {
  if (!state.running) return 'not running';
  const parts = [`running (pid ${state.mainPid})`];
  if (state.codeSessions > 0) parts.push(`hosting ${state.codeSessions} Code session(s)`);
  if (state.startedAt) parts.push(`started ${formatAge(state.startedAt)}`);
  return parts.join(' · ');
}

async function desktopFlow(store: StoreLayout, target: AccountRef): Promise<void> {
  for (;;) {
    // The instance running *this* store: with a second profile up, the global
    // question would describe — and offer to close — the wrong app.
    const state = inspectDesktopFor(storeIdentity(store.root));
    note(describeDesktop(state), 'Claude Desktop');

    const choice = await selectOrBack('What about it?', [
      state.running
        ? { value: 'restart', label: 'Restart it', hint: 'quit, then start again' }
        : { value: 'start', label: 'Start it' },
      ...(state.running ? [{ value: 'quit', label: 'Quit it' }] : []),
      {
        value: 'why',
        label: 'Why do changes need a restart?',
        hint: 'and the one way around it',
      },
      { value: 'switch', label: 'Switching accounts', hint: 'what foster can and cannot do' },
    ]);
    if (aborted(choice)) return;

    switch (choice) {
      case 'restart':
        await restartFlow(store, state);
        break;
      case 'quit':
        await quitFlow(store, state);
        break;
      case 'start':
        await startFlow(store);
        break;
      case 'why':
        explainRefresh(store, target);
        break;
      case 'switch':
        explainAccountSwitch();
        break;
      default:
        return;
    }
  }
}

/**
 * Confirms a shutdown, in the terms that matter: the work it interrupts.
 *
 * Returns false when foster must not do it at all — which is the case whenever
 * foster is itself running inside the app.
 */
async function confirmShutdown(state: DesktopState, verb: 'quit' | 'restart'): Promise<boolean> {
  if (state.selfHosted) {
    log.error(
      `foster is running inside Claude Desktop, so it cannot ${verb} it — that would kill this session.`,
    );
    log.message(pc.dim('Run foster from a terminal outside the app, or use the app menu.'));
    return false;
  }

  if (state.codeSessions > 0) {
    log.warn(
      `${state.codeSessions} Claude Code session(s) are running in the app. Closing it interrupts them.`,
    );
  }

  // Capitalised only here: the verb reads mid-sentence in the refusal above.
  const prompt = verb[0]!.toUpperCase() + verb.slice(1);
  const go = await confirm({ message: `${prompt} Claude Desktop?`, initialValue: false });
  return !isCancel(go) && go;
}

async function quitFlow(store: StoreLayout, state: DesktopState): Promise<boolean> {
  if (!(await confirmShutdown(state, 'quit'))) return false;
  return closeDesktop(store);
}

/** The quit half, shared by quit and restart. */
async function closeDesktop(store: StoreLayout): Promise<boolean> {
  try {
    const result = await quitDesktop(store);
    if (result.outcome === 'quit' || result.outcome === 'not-running') {
      log.success('Claude Desktop is closed.');
      return true;
    }

    if (result.outcome === 'needs-terminate' && !(await consentToTerminate())) return false;

    const second = await quitDesktop(store, { terminate: true });
    if (second.outcome !== 'quit' && second.outcome !== 'not-running') {
      log.error('Could not close it. Quit it from the tray icon and try again.');
      return false;
    }
    log.success('Claude Desktop is closed.');
    return true;
  } catch (error) {
    if (error instanceof DesktopControlError) {
      log.error(error.message);
      return false;
    }
    throw error;
  }
}

/**
 * The one thing foster cannot do politely, said plainly.
 *
 * With its tray icon on — the default — Claude Desktop treats a close request as
 * "hide the window" and keeps running. There is no outside handle on its Quit,
 * so ending the process is the only route, and it skips the shutdown the app
 * would otherwise run. That is a real cost and gets an explicit yes.
 */
async function consentToTerminate(): Promise<boolean> {
  note(
    [
      'Claude Desktop keeps running in the tray, so asking its window to close',
      'would only hide it. foster can end the process instead.',
      '',
      'Session files are written through a temporary and renamed, so ending it',
      'cannot corrupt one. What it does skip is the app’s own shutdown: a title or',
      'timestamp changed in the last few seconds may not be saved, and Cowork',
      'sandboxes will not be stopped cleanly.',
      '',
      'Quitting from the tray icon yourself avoids all of that.',
    ].join('\n'),
    'No polite way to ask',
  );

  const go = await confirm({
    message: 'End the Claude Desktop process?',
    initialValue: false,
  });
  return !isCancel(go) && go;
}

async function startFlow(store: StoreLayout): Promise<boolean> {
  log.message('Starting Claude Desktop…');
  try {
    const started = await startDesktop(store);
    if (started) log.success('Claude Desktop is up. The sidebar has been rebuilt.');
    else log.warn('Started it, but it has not taken the store yet. Give it a moment.');
    return started;
  } catch (error) {
    if (error instanceof DesktopControlError) {
      log.error(error.message);
      return false;
    }
    throw error;
  }
}

async function restartFlow(store: StoreLayout, state: DesktopState): Promise<void> {
  if (state.running) {
    if (!(await confirmShutdown(state, 'restart'))) return;
    if (!(await closeDesktop(store))) return;
  }
  await startFlow(store);
}

/**
 * Offered after a write, where the change exists on disk but not yet on screen.
 *
 * The old code printed a note telling the user to restart the app themselves,
 * which is a strange thing for a program that can do it.
 */
async function offerRestart(store: StoreLayout, why: string): Promise<void> {
  const running = inspectApp(store).running;
  note(why, 'Not visible yet');

  const choice = await select({
    message: running ? 'Restart Claude Desktop now?' : 'Start Claude Desktop now?',
    options: [
      { value: 'go', label: running ? 'Restart it' : 'Start it' },
      { value: 'later', label: 'Not now' },
    ],
    initialValue: 'go',
  });
  if (isCancel(choice) || choice === 'later') return;

  if (!running) {
    await startFlow(store);
    return;
  }
  await restartFlow(store, inspectDesktopFor(storeIdentity(store.root)));
}

function explainRefresh(store: StoreLayout, target: AccountRef): void {
  const organizations = listAccountDirs(store).filter(
    (ref) => ref.accountUuid === target.accountUuid,
  ).length;

  const lines = [
    'Claude Desktop reads its session directory once, while it starts, and keeps',
    'what it found in memory. Nothing watches the directory afterwards, so a file',
    'that appears later is invisible until the app initialises again.',
    '',
    'Reloading the window (F5) does not help: the list it redraws comes from the',
    'app itself, not from disk.',
  ];

  if (organizations > 1) {
    lines.push(
      '',
      `This account has ${organizations} organizations, which gives you one way round it:`,
      'switching organization makes the app re-read the directory, and switching back',
      'reads it again. No restart needed — but it does end any session that is running.',
    );
  }

  note(lines.join('\n'), 'Why a restart');
}

function explainAccountSwitch(): void {
  note(
    [
      'foster cannot switch accounts, and will not try.',
      '',
      'Which account the app uses comes from the session you are signed into, not',
      'from anything on disk — the account id in its config is only a cached copy of',
      'the answer. Changing it changes nothing. Doing it properly would mean',
      'handling credentials, which foster never touches.',
      '',
      'To switch: sign out and back in from the app. Copies foster wrote into that',
      'account are waiting when you arrive — pick it as the destination under "Send',
      'them somewhere else" to stage them before you go.',
    ].join('\n'),
    'Switching accounts',
  );
}

export function abortInteractive(message = 'Cancelled.'): void {
  cancel(message);
}
