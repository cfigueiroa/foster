import pc from 'picocolors';
import { listAccountDirs, storeIdentity } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import {
  DesktopControlError,
  inspectDesktopFor,
  quitDesktop,
  startDesktop,
  type DesktopState,
} from '../engine/desktop.js';
import { inspectApp } from '../engine/safety.js';
import { isCancel, type Ui } from '../tui/ui.js';
import { aborted, selectOrBack } from './prompts.js';
import { formatAge } from './render.js';

export async function desktopFlow(ui: Ui, store: StoreLayout, target: AccountRef): Promise<void> {
  for (;;) {
    // The instance running *this* store: with a second profile up, the global
    // question would describe — and offer to close — the wrong app.
    const state = inspectDesktopFor(storeIdentity(store.root));
    ui.note(describeDesktop(state), 'Claude Desktop');

    const choice = await selectOrBack(ui, 'What about it?', [
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
        await restartFlow(ui, store, state);
        break;
      case 'quit':
        await quitFlow(ui, store, state);
        break;
      case 'start':
        await startFlow(ui, store);
        break;
      case 'why':
        explainRefresh(ui, store, target);
        break;
      case 'switch':
        explainAccountSwitch(ui);
        break;
      default:
        return;
    }
  }
}

function describeDesktop(state: DesktopState): string {
  if (!state.running) return 'not running';
  const parts = [`running (pid ${state.mainPid})`];
  if (state.codeSessions > 0) parts.push(`hosting ${state.codeSessions} Code session(s)`);
  if (state.startedAt) parts.push(`started ${formatAge(state.startedAt)}`);
  return parts.join(' · ');
}

/**
 * Confirms a shutdown, in the terms that matter: the work it interrupts.
 *
 * Returns false when foster must not do it at all — which is the case whenever
 * foster is itself running inside the app.
 */
async function confirmShutdown(
  ui: Ui,
  state: DesktopState,
  verb: 'quit' | 'restart',
): Promise<boolean> {
  if (state.selfHosted) {
    ui.log.error(
      `foster is running inside Claude Desktop, so it cannot ${verb} it — that would kill this session.`,
    );
    ui.log.message(pc.dim('Run foster from a terminal outside the app, or use the app menu.'));
    return false;
  }

  if (state.codeSessions > 0) {
    ui.log.warn(
      `${state.codeSessions} Claude Code session(s) are running in the app. Closing it interrupts them.`,
    );
  }

  // Capitalised only here: the verb reads mid-sentence in the refusal above.
  const prompt = verb[0]!.toUpperCase() + verb.slice(1);
  const go = await ui.confirm({ message: `${prompt} Claude Desktop?`, initialValue: false });
  return !isCancel(go) && go;
}

async function quitFlow(ui: Ui, store: StoreLayout, state: DesktopState): Promise<boolean> {
  if (!(await confirmShutdown(ui, state, 'quit'))) return false;
  return closeDesktop(ui, store);
}

/** The quit half, shared by quit and restart. */
async function closeDesktop(ui: Ui, store: StoreLayout): Promise<boolean> {
  try {
    const result = await quitDesktop(store);
    if (result.outcome === 'quit' || result.outcome === 'not-running') {
      ui.log.success('Claude Desktop is closed.');
      return true;
    }

    if (result.outcome === 'needs-terminate' && !(await consentToTerminate(ui))) return false;

    const second = await quitDesktop(store, { terminate: true });
    if (second.outcome !== 'quit' && second.outcome !== 'not-running') {
      ui.log.error('Could not close it. Quit it from the tray icon and try again.');
      return false;
    }
    ui.log.success('Claude Desktop is closed.');
    return true;
  } catch (error) {
    if (error instanceof DesktopControlError) {
      ui.log.error(error.message);
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
async function consentToTerminate(ui: Ui): Promise<boolean> {
  ui.note(
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

  const go = await ui.confirm({
    message: 'End the Claude Desktop process?',
    initialValue: false,
  });
  return !isCancel(go) && go;
}

async function startFlow(ui: Ui, store: StoreLayout): Promise<boolean> {
  ui.log.message('Starting Claude Desktop…');
  try {
    const started = await startDesktop(store);
    if (started) ui.log.success('Claude Desktop is up. The sidebar has been rebuilt.');
    else ui.log.warn('Started it, but it has not taken the store yet. Give it a moment.');
    return started;
  } catch (error) {
    if (error instanceof DesktopControlError) {
      ui.log.error(error.message);
      return false;
    }
    throw error;
  }
}

async function restartFlow(ui: Ui, store: StoreLayout, state: DesktopState): Promise<void> {
  if (state.running) {
    if (!(await confirmShutdown(ui, state, 'restart'))) return;
    if (!(await closeDesktop(ui, store))) return;
  }
  await startFlow(ui, store);
}

/**
 * Offered after a write, where the change exists on disk but not yet on screen.
 *
 * The old code printed a note telling the user to restart the app themselves,
 * which is a strange thing for a program that can do it.
 */
export async function offerRestart(ui: Ui, store: StoreLayout, why: string): Promise<void> {
  const running = inspectApp(store).running;
  ui.note(why, 'Not visible yet');

  const choice = await ui.select({
    message: running ? 'Restart Claude Desktop now?' : 'Start Claude Desktop now?',
    options: [
      { value: 'go', label: running ? 'Restart it' : 'Start it' },
      { value: 'later', label: 'Not now' },
    ],
    initialValue: 'go',
  });
  if (isCancel(choice) || choice === 'later') return;

  if (!running) {
    await startFlow(ui, store);
    return;
  }
  await restartFlow(ui, store, inspectDesktopFor(storeIdentity(store.root)));
}

function explainRefresh(ui: Ui, store: StoreLayout, target: AccountRef): void {
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

  ui.note(lines.join('\n'), 'Why a restart');
}

function explainAccountSwitch(ui: Ui): void {
  ui.note(
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
