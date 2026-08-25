import type { ThemeName } from './theme.js';

/**
 * What a flow asks of the screen.
 *
 * The TUI implements this with overlays and a dashboard. Tests implement it
 * with a scripted queue, the same currency the old clack mock used — so a
 * foster/return assertion does not have to speak in arrow keys.
 */

export const CANCEL = Symbol('cancel');

export function isCancel(value: unknown): value is typeof CANCEL {
  return value === CANCEL;
}

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export interface DashboardAccount {
  accountUuid: string;
  shortId: string;
  label?: string;
  isCurrent: boolean;
  plan?: string;
  subscription?: string;
  /** Set when the subscription is remembered, not read fresh: the date it was seen. */
  subscriptionAsOf?: string;
  sessions: number;
  copies: number;
  paymentNeedsAuth?: boolean;
}

export interface DashboardFostered {
  title: string;
  date: string;
  elsewhere?: string;
}

export interface Dashboard {
  version: string;
  store: string;
  signedIn: string;
  appRunning: boolean;
  accounts: DashboardAccount[];
  fostered: DashboardFostered[];
  update?: string;
}

export interface HomeRequest {
  message: string;
  options: Choice[];
  dashboard: Dashboard;
}

export interface Ui {
  start(): void;
  stop(): void;
  setTheme(name: ThemeName): void;
  theme(): ThemeName;
  clearPanel(): void;
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  cancel(message?: string): void;
  home(request: HomeRequest): Promise<string | typeof CANCEL>;
  select(opts: {
    message: string;
    options: Choice[];
    initialValue?: string;
    preview?: (value: string) => void;
  }): Promise<string | typeof CANCEL>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean | typeof CANCEL>;
  text(opts: {
    message: string;
    initialValue?: string;
    placeholder?: string;
  }): Promise<string | undefined | typeof CANCEL>;
  multiselect(opts: {
    message: string;
    options: Choice[];
    required?: boolean;
  }): Promise<string[] | typeof CANCEL>;
  spinner(): { start(message: string): void; stop(message?: string): void };
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    success(message: string): void;
    message(message: string): void;
  };
}
