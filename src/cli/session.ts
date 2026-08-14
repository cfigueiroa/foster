import pc from 'picocolors';
import { currentAccount } from '../engine/account.js';
import { inspectApp } from '../engine/safety.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project } from '../ledger/project.js';
import { listAccountDirs } from '../domain/paths.js';
import type { AccountRef, StoreLayout } from '../domain/types.js';
import { checkForUpdate } from '../update.js';
import { VERSION } from '../version.js';
import { createLiveUi } from '../tui/run.js';
import { asChoices, COMMANDS } from '../tui/slash.js';
import { THEMES, type ThemeName } from '../tui/theme.js';
import { isCancel, type Ui } from '../tui/ui.js';
import { buildDashboard } from './dashboard.js';
import { desktopFlow } from './desktopUi.js';
import { fosterFlow, labelFlow, restoreFlow, returnFlow, switchInstallation } from './flows.js';
import { showAccounts, showIdentities, showRenewals, showStatus, showUsage } from './screens.js';
import { BACK_OPTION, aborted } from './prompts.js';
import { describeRef, labelsOf, nameEverything } from './names.js';

type Action = (ctx: Session) => Promise<void>;

interface Session {
  ui: Ui;
  store: StoreLayout;
  ledger: Ledger;
  target: AccountRef;
}

/**
 * The interactive entry: alt-screen TUI, or a scripted Ui in tests.
 *
 * Commands live in one dispatch map so a new slash entry cannot quit the
 * program by falling through a switch default.
 */
export async function runInteractive(
  initialStore: StoreLayout,
  ledger: Ledger,
  injected?: Ui,
): Promise<void> {
  const ui = injected ?? createLiveUi();
  ui.start();
  try {
    await runSession(initialStore, ledger, ui);
  } finally {
    ui.stop();
  }
}

async function runSession(initialStore: StoreLayout, ledger: Ledger, ui: Ui): Promise<void> {
  let store = initialStore;
  ui.intro(`${pc.bgCyan(pc.black(' foster '))} ${pc.dim(VERSION)}`);

  const update = checkForUpdate();
  nameEverything(store);

  const signedIn = currentAccount(store, listAccountDirs(store));
  if (!signedIn) {
    ui.log.error('Could not determine which account is signed in. Open Claude Desktop once first.');
    ui.outro('Nothing to do.');
    return;
  }
  let target = signedIn;

  showEnvironment(ui, store, ledger, target);

  const status = await update;
  if (status?.outdated) {
    ui.log.warn(`foster ${status.latest} is available (you have ${status.current}).`);
    ui.log.message(pc.dim(status.command));
  }

  const actions: Record<string, Action> = {
    foster: (ctx) => fosterFlow(ctx.ui, ctx.store, ctx.ledger, ctx.target),
    return: (ctx) => returnFlow(ctx.ui, ctx.store, ctx.ledger),
    restore: (ctx) => restoreFlow(ctx.ui, ctx.store, ctx.ledger, ctx.target),
    status: (ctx) => {
      showStatus(ctx.ui, ctx.ledger, ctx.store);
      return Promise.resolve();
    },
    browse: (ctx) => {
      showAccounts(ctx.ui, ctx.store, ctx.ledger, ctx.target);
      return Promise.resolve();
    },
    accounts: (ctx) => {
      showIdentities(ctx.ui, ctx.store, ctx.ledger);
      return Promise.resolve();
    },
    usage: (ctx) => showUsage(ctx.ui, ctx.store),
    renewals: (ctx) => showRenewals(ctx.ui, ctx.store, ctx.ledger),
    label: (ctx) => labelFlow(ctx.ui, ctx.store, ctx.ledger, ctx.target),
    installation: async (ctx) => {
      const next = await switchInstallation(ctx.ui, ctx.store, ctx.ledger);
      if (aborted(next)) return;
      store = next.store;
      target = next.target;
      nameEverything(store);
      showEnvironment(ui, store, ledger, target);
    },
    app: (ctx) => desktopFlow(ctx.ui, ctx.store, ctx.target),
    theme: (ctx) => themeFlow(ctx.ui),
    home: (ctx) => {
      ctx.ui.clearPanel();
      return Promise.resolve();
    },
  };

  for (;;) {
    const dashboard = buildDashboard(store, ledger, target);
    if (status?.outdated) dashboard.update = `${status.latest} is available`;

    const choice = await ui.home({
      message: 'What would you like to do?',
      options: asChoices(COMMANDS),
      dashboard,
    });

    if (isCancel(choice) || choice === 'quit') {
      ui.outro('Bye.');
      return;
    }

    const action = actions[choice];
    if (!action) continue;
    await action({ ui, store, ledger, target });
  }
}

async function themeFlow(ui: Ui): Promise<void> {
  const previous = ui.theme();
  const picked = await ui.select({
    message: 'Theme',
    options: [
      ...Object.values(THEMES).map((theme) => ({
        value: theme.name,
        label: theme.label,
        hint: theme.hint,
      })),
      { value: BACK_OPTION, label: 'Back' },
    ],
    initialValue: previous,
    preview: (value) => {
      if (isThemeName(value)) ui.setTheme(value);
    },
  });
  if (isCancel(picked) || picked === BACK_OPTION) {
    ui.setTheme(previous);
    return;
  }
  if (!isThemeName(picked)) return;
  ui.setTheme(picked);
  ui.log.success(`Theme is ${THEMES[picked].label}.`);
}

function isThemeName(value: string): value is ThemeName {
  return value === 'night' || value === 'day';
}

function showEnvironment(ui: Ui, store: StoreLayout, ledger: Ledger, target: AccountRef): void {
  const app = inspectApp(store);
  const active = listActive(project(ledger.read())).length;
  ui.log.info(
    `store ${store.root} · signed in ${describeRef(labelsOf(ledger), target)} · app ${
      app.running ? 'running' : 'not running'
    } · fostered ${active === 0 ? 'nothing yet' : `${active} session(s)`}`,
  );
}
