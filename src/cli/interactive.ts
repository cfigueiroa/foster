import { cancel, confirm, intro, isCancel, log, note, outro, select } from '@clack/prompts';
import pc from 'picocolors';
import { DEFAULT_PREFIX } from '../domain/fostering.js';
import { listAccountDirs, listAgentAccountDirs, pickActiveOrganization } from '../domain/paths.js';
import type { AccountRef, DiscoveredSession, StoreLayout } from '../domain/types.js';
import {
  DesktopControlError,
  inspectDesktop,
  quitDesktop,
  startDesktop,
  type DesktopState,
} from '../engine/desktop.js';
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
import { aborted, askText, BACK, type Maybe, pickMany, selectOrBack } from './prompts.js';
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

export async function runInteractive(store: StoreLayout, ledger: Ledger): Promise<void> {
  intro(`${pc.bgCyan(pc.black(' foster '))} ${pc.dim(VERSION)}`);

  // Started before the store work and awaited only when it is about to be shown,
  // so a slow or unreachable network never delays the menu.
  const update = checkForUpdate();

  nameEverything(store);

  const target = resolveTarget(store);
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
        { value: 'status', label: 'What foster has done', hint: 'copies currently in place' },
        {
          value: 'browse',
          label: 'What is on disk',
          hint: 'accounts, organizations and session counts',
        },
        { value: 'label', label: 'Name an account', hint: 'so you stop reading UUIDs' },
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
      case 'status':
        showStatus(ledger);
        break;
      case 'browse':
        showAccounts(store, ledger, target);
        break;
      case 'label':
        await labelFlow(store, ledger, target);
        break;
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
  const rows = listAccountDirs(store).map((account) =>
    summariseAccount(account, scanAccount(store, account), target.accountUuid),
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

async function chooseSource(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
): Promise<Maybe<AccountRef[]>> {
  const labels = labelsOf(ledger);

  // Only the exact directory the sidebar reads is excluded, not the whole
  // account. Another organization of the *same* account is just as invisible as
  // another account's, so it is just as fosterable — a session filed under a
  // second organization would otherwise be unreachable.
  const sources = listAccountDirs(store).filter(
    (ref) =>
      !(ref.accountUuid === target.accountUuid && ref.organizationUuid === target.organizationUuid),
  );
  if (sources.length === 0) {
    log.info('There is nothing to bring here: this is the only account on this machine.');
    return BACK;
  }

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

  // Organizations are offered individually, with a whole-account shortcut when
  // there is more than one: taking everything and taking one part are both
  // reasonable, and only the user knows which they meant.
  const choices: SourceOption[] = [];

  for (const [accountUuid, refs] of byAccount) {
    const name = labels.get(accountUuid) ?? short(accountUuid);
    const suffix = accountUuid === target.accountUuid ? pc.green(' (this account)') : '';

    if (refs.length > 1) {
      const total = totals(refs);
      choices.push({
        refs,
        label: `${pc.bold(name)}${suffix} — everything, all ${refs.length} organizations`,
        hint: describeStat(total),
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

/** Which of the available sessions to take. */
async function chooseSessions(sessions: DiscoveredSession[]): Promise<Maybe<DiscoveredSession[]>> {
  const how = await selectOrBack(`${sessions.length} session(s) available. Which ones?`, [
    { value: 'all', label: 'All of them' },
    { value: 'pick', label: 'Pick them from a list', hint: 'tick the ones you want' },
    { value: 'since', label: 'Only recent ones', hint: 'e.g. the last 30 days' },
    { value: 'title', label: 'Matching a title' },
    { value: 'cwd', label: 'Matching a working directory' },
  ]);
  if (aborted(how)) return BACK;
  if (how === 'all') return sessions;
  if (how === 'pick') return pickSessions(sessions);

  const prompts = {
    since: { message: 'How far back?', placeholder: '30d' },
    title: { message: 'Title contains', placeholder: 'refactor' },
    cwd: { message: 'Working directory contains', placeholder: 'my-project' },
  } as const;

  const prompt = prompts[how as keyof typeof prompts];
  const answer = await askText(prompt.message, { placeholder: prompt.placeholder });
  if (aborted(answer)) return BACK;

  const value = answer.trim();
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
  const sources = await chooseSource(store, ledger, current);
  if (aborted(sources)) return;

  const all = sources.flatMap((account) => scanAccount(store, account));
  const available = byRecency(applyFilter(all, {}));
  reportHidden(all, available);

  if (available.length === 0) {
    log.info('Nothing there can be fostered.');
    return;
  }

  const selected = await chooseSessions(available);
  if (aborted(selected)) return;
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

  await confirmAndWrite(store, ledger, current, sources, selected);
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
  sources: AccountRef[],
  selected: DiscoveredSession[],
): Promise<void> {
  let target = current;
  let prefix = DEFAULT_PREFIX;

  for (;;) {
    const labels = labelsOf(ledger);
    const decision = await select({
      message: `Foster ${selected.length} session(s) into ${describeRef(labels, target)}?`,
      options: [
        { value: 'go', label: 'Yes, foster them' },
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

    const chosen = await chooseTarget(store, ledger, current, sources);
    if (!aborted(chosen)) target = chosen;
  }

  try {
    const outcomes = fosterSessions(selected, { store, ledger, target, prefix });
    const counts = summariseOutcomes(outcomes);
    for (const outcome of outcomes.slice(0, 10)) log.message(outcomeLine(outcome));
    if (outcomes.length > 10) log.message(pc.dim(`… and ${outcomes.length - 10} more`));

    log.success(`${counts.fostered} fostered, ${counts.skipped} skipped, ${counts.failed} failed.`);
    if (counts.fostered === 0) return;

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

async function returnFlow(store: StoreLayout, ledger: Ledger): Promise<void> {
  const active = listActive(project(ledger.read()));
  if (active.length === 0) {
    log.info('Nothing is fostered.');
    return;
  }

  const scope = await selectOrBack(`${active.length} fostered session(s). Send back which?`, [
    { value: 'all', label: 'All of them' },
    { value: 'pick', label: 'Pick them from a list', hint: 'tick the ones you want' },
    { value: 'title', label: 'Only those matching a title' },
  ]);
  if (aborted(scope)) return;

  const chosen = await narrowFosterings(active, scope);
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
    const outcomes = returnFosterings(chosen, { store, ledger });
    const counts = summariseOutcomes(outcomes);
    log.success(`${counts.returned} returned, ${counts.failed} failed.`);
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
): Promise<Maybe<ActiveFostering[]>> {
  if (scope === 'all') return active;

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
    const state = inspectDesktop();
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
  log.message('Asking the app to close…');
  try {
    const result = await quitDesktop(store);
    if (result.outcome !== 'still-running') {
      log.success('Claude Desktop is closed.');
      return true;
    }

    log.warn('It is still running. The app may be asking you to confirm — check its window.');
    const force = await select({
      message: 'What now?',
      options: [
        { value: 'wait', label: 'I answered it — check again' },
        { value: 'force', label: 'Force it to close', hint: 'ends it without its own shutdown' },
        { value: 'stop', label: 'Leave it running' },
      ],
      initialValue: 'wait',
    });
    if (isCancel(force) || force === 'stop') return false;

    const second = await quitDesktop(store, { force: force === 'force' });
    if (second.outcome === 'still-running') {
      log.error('Could not close it. Quit it from the app menu and try again.');
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
  await restartFlow(store, inspectDesktop());
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
