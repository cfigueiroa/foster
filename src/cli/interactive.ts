import { cancel, confirm, intro, isCancel, log, note, outro, select, text } from '@clack/prompts';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import { listAccountDirs, listAgentAccountDirs, pickActiveOrganization } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import { fosterSessions, returnFosterings, summariseOutcomes } from '../engine/executor.js';
import { AppRunningError, inspectApp } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import type { ActiveFostering } from '../ledger/types.js';
import { readConfig } from '../store/config.js';
import { scanAccount, summariseAccount } from '../store/scanner.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { applyFilter, byRecency, parseSince } from './filters.js';
import { accountTree, formatDate, groupByAccount, outcomeLine, shortId } from './render.js';

/** Sentinel returned by a step the user backed out of, so callers can return to the menu. */
const BACK = Symbol('back');
type Maybe<T> = T | typeof BACK;

function aborted<T>(value: T | symbol): value is symbol {
  return isCancel(value) || value === BACK;
}

/** The value carried by the "Back" entry; never leaves this module. */
const BACK_OPTION = '__back';

/**
 * A select that always answers in the same currency.
 *
 * Backing out used to be a string in the option list but a symbol in the return
 * type, so every caller had to remember to check for both. One that checked only
 * the symbol passed the literal "__back" downstream, where it was used as a
 * lookup key and crashed. Converting here means callers only ever see BACK.
 */
async function selectOrBack(
  message: string,
  options: { value: string; label: string; hint?: string }[],
): Promise<Maybe<string>> {
  const picked = await select({
    message,
    options: [...options, { value: BACK_OPTION, label: pc.dim('Back') }],
  });
  return isCancel(picked) || picked === BACK_OPTION ? BACK : picked;
}

export async function runInteractive(store: StoreLayout, ledger: Ledger): Promise<void> {
  intro(`${pc.bgCyan(pc.black(' foster '))} ${pc.dim(VERSION)}`);

  // Started before the store work and awaited only when it is about to be shown,
  // so a slow or unreachable network never delays the menu.
  const update = checkForUpdate();

  const target = resolveTarget(store);
  if (!target) {
    log.error('Could not determine which account is signed in. Open Claude Desktop once first.');
    outro('Nothing to do.');
    return;
  }

  showEnvironment(store, target);

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
          label: 'Foster sessions',
          hint: 'bring another account’s sessions here',
        },
        {
          value: 'return',
          label: 'Return fostered sessions',
          hint: 'undo, restoring the previous state',
        },
        { value: 'status', label: 'Status', hint: 'what is currently fostered' },
        { value: 'browse', label: 'Browse accounts', hint: 'what is on disk' },
        {
          value: 'doctor',
          label: 'Check environment',
          hint: 'store, account, whether the app is running',
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
      case 'status':
        showStatus(ledger);
        break;
      case 'browse':
        showAccounts(store, ledger, target);
        break;
      case 'doctor':
        showEnvironment(store, target);
        break;
    }
  }
}

function resolveTarget(store: StoreLayout): AccountRef | undefined {
  const accountUuid = readConfig(store).lastKnownAccountUuid;
  if (!accountUuid) return undefined;
  // An account can own several organizations; only one of them is the directory
  // the sidebar reads, and the config does not say which.
  return (
    pickActiveOrganization(
      listAccountDirs(store).filter((a) => a.accountUuid === accountUuid),
      store,
    ) ?? listAgentAccountDirs(store).find((a) => a.accountUuid === accountUuid)
  );
}

function showEnvironment(store: StoreLayout, target: AccountRef): void {
  const app = inspectApp(store);
  note(
    [
      `store    ${store.root}`,
      `account  ${shortId(target.accountUuid)} ${pc.dim(`org ${shortId(target.organizationUuid)}`)}`,
      `app      ${app.running ? pc.yellow('running — quit it before writing') : pc.green('not running')}`,
    ].join('\n'),
    'Environment',
  );
}

function showStatus(ledger: Ledger): void {
  const active = listActive(project(ledger.read()));
  if (active.length === 0) {
    log.info('Nothing is fostered.');
    return;
  }
  note(
    active
      .map(
        (f) =>
          `${pc.dim(formatDate(f.fosteredAt))}  ${f.originalTitle || shortId(f.originSessionId)}`,
      )
      .join('\n'),
    `${active.length} fostered`,
  );
}

function showAccounts(store: StoreLayout, ledger: Ledger, target: AccountRef): void {
  const labels = project(ledger.read()).labels;
  const rows = listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account), target.accountUuid),
  );
  note(accountTree(groupByAccount(rows), labels), 'Accounts and their organizations');
}

/**
 * Waits for the app to be closed instead of failing.
 *
 * The one-shot commands can only refuse and exit; here the user can quit the app
 * and carry on without losing their selection.
 */
async function waitUntilAppClosed(store: StoreLayout): Promise<boolean> {
  for (;;) {
    const app = inspectApp(store);
    if (!app.running) return true;

    log.warn(`Claude Desktop is running (${app.evidence.join('; ')}).`);
    log.message(pc.dim('Quit it completely — closing the window is not enough; use the app menu.'));

    const again = await confirm({
      message: 'Check again?',
      active: 'I have quit it',
      inactive: 'Cancel',
    });
    if (isCancel(again) || !again) return false;
  }
}

async function chooseSource(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
): Promise<Maybe<AccountRef[]>> {
  const labels = project(ledger.read()).labels;

  // Only the exact directory the sidebar reads is excluded, not the whole
  // account. Another organization of the *same* account is just as invisible as
  // another account's, so it is just as fosterable — a session filed under a
  // second organization would otherwise be unreachable.
  const sources = listAccountDirs(store).filter(
    (ref) =>
      !(ref.accountUuid === target.accountUuid && ref.organizationUuid === target.organizationUuid),
  );
  if (sources.length === 0) return BACK;

  const byAccount = new Map<string, AccountRef[]>();
  for (const ref of sources) {
    byAccount.set(ref.accountUuid, [...(byAccount.get(ref.accountUuid) ?? []), ref]);
  }

  const count = (refs: AccountRef[]) =>
    refs.reduce((total, ref) => total + scanAccount(store, ref).filter((s) => !s.isCopy).length, 0);

  // Organizations are offered individually, with a whole-account shortcut when
  // there is more than one: taking everything and taking one part are both
  // reasonable, and only the user knows which they meant.
  const choices: { label: string; hint: string; refs: AccountRef[] }[] = [];

  for (const [accountUuid, refs] of byAccount) {
    const name = labels.get(accountUuid) ?? shortId(accountUuid);
    const isThisAccount = accountUuid === target.accountUuid;
    const suffix = isThisAccount ? pc.green(' (this account)') : '';

    if (refs.length > 1) {
      choices.push({
        label: `${pc.bold(name)}${suffix} — all ${refs.length} organizations`,
        hint: `${count(refs)} session(s)`,
        refs,
      });
    }
    for (const ref of refs) {
      const prefix = refs.length > 1 ? '   ' : '';
      choices.push({
        label: `${prefix}${pc.bold(name)}${suffix} ${pc.dim('/ org')} ${shortId(ref.organizationUuid)}`,
        hint: `${count([ref])} session(s)`,
        refs: [ref],
      });
    }
  }

  const picked = await selectOrBack(
    'Where should the sessions come from?',
    choices.map((choice, index) => ({
      value: String(index),
      label: choice.label,
      hint: choice.hint,
    })),
  );

  if (aborted(picked)) return BACK;
  return choices[Number(picked)]?.refs ?? BACK;
}

const refKey = (ref: AccountRef) => `${ref.accountUuid}/${ref.organizationUuid}`;

/** Account and organization, using a human label for the account when one exists. */
function describeRef(ledger: Ledger, ref: AccountRef): string {
  const label = project(ledger.read()).labels.get(ref.accountUuid);
  return `${label ?? shortId(ref.accountUuid)} ${pc.dim('/ org')} ${shortId(ref.organizationUuid)}`;
}

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
      label: describeRef(ledger, current),
      hint: 'the account in use — copies show up after a restart',
    },
    ...others.map((ref) => ({
      value: refKey(ref),
      label: describeRef(ledger, ref),
      hint: 'not the account in use — copies appear only once you switch to it',
    })),
  ]);

  if (aborted(picked)) return BACK;
  return [current, ...others].find((ref) => refKey(ref) === picked) ?? BACK;
}

async function chooseFilter(sessions: DiscoveredSession[]): Promise<Maybe<DiscoveredSession[]>> {
  const how = await selectOrBack(`${sessions.length} session(s) available. Narrow them down?`, [
    { value: 'all', label: 'Take all of them' },
    { value: 'since', label: 'Only recent ones', hint: 'e.g. the last 30 days' },
    { value: 'title', label: 'Match a title' },
    { value: 'cwd', label: 'Match a working directory' },
  ]);
  if (aborted(how)) return BACK;
  if (how === 'all') return sessions;

  const prompts = {
    since: { message: 'How far back?', placeholder: '30d' },
    title: { message: 'Title contains', placeholder: 'refactor' },
    cwd: { message: 'Working directory contains', placeholder: 'my-project' },
  } as const;

  const answer = await text(prompts[how as keyof typeof prompts]);
  if (aborted(answer)) return BACK;

  const value = String(answer).trim();
  if (!value) return sessions;

  if (how === 'since') {
    const since = parseSince(value);
    if (since === undefined) {
      log.error(`Could not read "${value}". Try 30d, 12h or 2w.`);
      return BACK;
    }
    return applyFilter(sessions, { since });
  }
  return applyFilter(sessions, how === 'title' ? { title: value } : { cwd: value });
}

async function fosterFlow(store: StoreLayout, ledger: Ledger, current: AccountRef): Promise<void> {
  const sources = await chooseSource(store, ledger, current);
  if (aborted(sources)) return;

  const available = byRecency(
    applyFilter(
      sources.flatMap((a) => scanAccount(store, a)),
      {},
    ),
  );
  if (available.length === 0) {
    log.info('That account has nothing that can be fostered.');
    return;
  }

  const selected = await chooseFilter(available);
  if (aborted(selected)) return;
  if (selected.length === 0) {
    log.info('Nothing matches that filter.');
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
    `${selected.length} session(s) would be fostered`,
  );

  const prefix = await text({
    message: 'Title prefix for the fostered copies',
    initialValue: DEFAULT_PREFIX,
    placeholder: DEFAULT_PREFIX,
  });
  if (aborted(prefix)) return;

  // The destination is offered here rather than as its own step: writing into
  // the account in use is what almost every run wants, and asking about it every
  // time would tax that case to serve the occasional one. Naming it in the
  // confirmation keeps it visible, and changing it is one keystroke away.
  let target = current;
  for (;;) {
    const decision = await select({
      message: `Foster ${selected.length} session(s) into ${describeRef(ledger, target)}?`,
      options: [
        { value: 'go', label: 'Yes, foster them' },
        {
          value: 'elsewhere',
          label: 'Send them somewhere else',
          hint: 'another account or organization',
        },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'cancel',
    });

    if (isCancel(decision) || decision === 'cancel') {
      log.info('Nothing written.');
      return;
    }
    if (decision === 'go') break;

    const chosen = await chooseTarget(store, ledger, current, sources);
    if (aborted(chosen)) continue;
    target = chosen;
  }

  if (!(await waitUntilAppClosed(store))) {
    log.info('Nothing written.');
    return;
  }

  try {
    const outcomes = fosterSessions(selected, {
      store,
      ledger,
      target,
      prefix: String(prefix) || DEFAULT_PREFIX,
    });
    const counts = summariseOutcomes(outcomes);
    for (const outcome of outcomes.slice(0, 10)) log.message(outcomeLine(outcome));
    if (outcomes.length > 10) log.message(pc.dim(`… and ${outcomes.length - 10} more`));

    log.success(`${counts.fostered} fostered, ${counts.skipped} skipped, ${counts.failed} failed.`);
    note(
      refKey(target) === refKey(current)
        ? 'Restart Claude Desktop to see them in the sidebar.'
        : `These went to ${shortId(target.accountUuid)} / org ${shortId(target.organizationUuid)}, which is not the account in use.\n` +
            'They appear once you switch to it and restart Claude Desktop.',
      'One more step',
    );
  } catch (error) {
    // The engine rechecks immediately before writing, so the app can still have
    // been reopened between the confirmation and the write.
    if (error instanceof AppRunningError) log.error(error.message);
    else throw error;
  }
}

async function returnFlow(store: StoreLayout, ledger: Ledger): Promise<void> {
  const active = listActive(project(ledger.read()));
  if (active.length === 0) {
    log.info('Nothing is fostered.');
    return;
  }

  const scope = await select({
    message: `${active.length} fostered session(s). Return which?`,
    options: [
      { value: 'all', label: 'All of them' },
      { value: 'title', label: 'Only those matching a title' },
      { value: '__back', label: pc.dim('Back') },
    ],
  });
  if (aborted(scope)) return;

  let chosen: ActiveFostering[] = active;
  if (scope === 'title') {
    const needle = await text({ message: 'Original title contains' });
    if (aborted(needle)) return;
    const value = String(needle).trim().toLowerCase();
    chosen = active.filter((f) => (f.originalTitle ?? '').toLowerCase().includes(value));
    if (chosen.length === 0) {
      log.info('Nothing matches.');
      return;
    }
  }

  const go = await confirm({
    message: `Remove ${chosen.length} fostered cop${chosen.length === 1 ? 'y' : 'ies'}?`,
    initialValue: false,
  });
  if (isCancel(go) || !go) {
    log.info('Nothing removed.');
    return;
  }

  if (!(await waitUntilAppClosed(store))) {
    log.info('Nothing removed.');
    return;
  }

  try {
    const outcomes = returnFosterings(chosen, { store, ledger });
    const counts = summariseOutcomes(outcomes);
    log.success(`${counts.returned} returned, ${counts.failed} failed.`);
    note('Restart Claude Desktop to see them disappear.', 'One more step');
  } catch (error) {
    if (error instanceof AppRunningError) log.error(error.message);
    else throw error;
  }
}

export function abortInteractive(message = 'Cancelled.'): void {
  cancel(message);
}
