import type { ColorLevel, Theme } from './theme.js';
import type { Dashboard } from './ui.js';
import { bold, fillLine, paintFg, rule, splitLeftRight, truncateVisible } from './widgets.js';

export function renderHome(
  dashboard: Dashboard,
  feed: string[],
  theme: Theme,
  level: ColorLevel,
  cols: number,
  rows: number,
): string[] {
  const lines: string[] = [];
  const push = (text: string) => {
    lines.push(fillLine(level, theme, text, cols, theme.bg));
  };
  const heading = (label: string) => {
    push('');
    push(paintFg(level, theme.accent, bold(label)));
  };

  heading('ACCOUNTS');
  if (dashboard.accounts.length === 0) {
    push(paintFg(level, theme.fgDim, '  no accounts in this installation yet'));
  }
  for (const account of dashboard.accounts) {
    const name = account.label ?? account.shortId;
    const marker = account.isCurrent
      ? paintFg(level, theme.accent, '●')
      : account.paymentNeedsAuth
        ? paintFg(level, theme.warning, '!')
        : paintFg(level, theme.fgDim, '○');
    const caret = account.isCurrent ? paintFg(level, theme.accent, '▌') : ' ';
    const plan = [account.plan, account.subscription].filter(Boolean).join(' · ') || 'unnamed';
    const counts =
      `${account.sessions} session(s)` + (account.copies ? ` · ${account.copies} copy` : '');
    const left = `${caret}${marker} ${bold(name)}  ${paintFg(level, theme.fgDim, plan)}`;
    push(splitLeftRight(left, paintFg(level, theme.fgDim, counts), cols));
  }

  heading('FOSTERED');
  if (dashboard.fostered.length === 0) {
    push(paintFg(level, theme.fgDim, '  nothing fostered yet — /foster to bring sessions here'));
  } else {
    for (const item of dashboard.fostered.slice(0, 8)) {
      const note = item.elsewhere ? `→ ${truncateVisible(item.elsewhere, 24)}` : undefined;
      const left = `  ${paintFg(level, theme.accent, '↪')} ${item.title}`;
      const right = paintFg(level, theme.fgDim, note ? `${note} · ${item.date}` : item.date);
      push(splitLeftRight(left, right, cols));
    }
    if (dashboard.fostered.length > 8) {
      push(
        paintFg(level, theme.fgDim, `  … and ${dashboard.fostered.length - 8} more  ·  /status`),
      );
    }
  }

  if (feed.length > 0) {
    heading('ACTIVITY');
    for (const line of feed.slice(-4)) {
      push(paintFg(level, theme.fgDim, `  ${truncateVisible(line, cols - 2)}`));
    }
  }

  while (lines.length < rows) push('');
  return lines.slice(0, rows);
}

export function renderHeader(
  dashboard: Dashboard,
  theme: Theme,
  level: ColorLevel,
  cols: number,
): string[] {
  const left = `${paintFg(level, theme.accent, bold(' foster '))} ${paintFg(level, theme.fgDim, dashboard.version)}`;
  const fostered =
    dashboard.fostered.length === 0 ? 'nothing fostered' : `${dashboard.fostered.length} fostered`;
  const right = paintFg(
    level,
    theme.fg,
    `${dashboard.signedIn} · ${dashboard.appRunning ? 'app running' : 'app idle'} · ${fostered}`,
  );
  const store = paintFg(level, theme.fgDim, truncateVisible(dashboard.store, cols));
  const update = dashboard.update ? paintFg(level, theme.warning, dashboard.update) : store;
  return [
    fillLine(level, theme, splitLeftRight(left, right, cols), cols),
    fillLine(level, theme, dashboard.update ? splitLeftRight(store, update, cols) : store, cols),
    fillLine(level, theme, rule(cols, theme, level), cols),
  ];
}

export function renderPanel(
  title: string,
  body: string,
  theme: Theme,
  level: ColorLevel,
  cols: number,
  rows: number,
): string[] {
  const lines = [fillLine(level, theme, paintFg(level, theme.accent, bold(` ${title}`)), cols)];
  lines.push(fillLine(level, theme, rule(cols, theme, level), cols));
  for (const raw of body.split('\n')) {
    lines.push(fillLine(level, theme, ` ${raw}`, cols));
  }
  while (lines.length < rows) lines.push(fillLine(level, theme, '', cols));
  return lines.slice(0, rows);
}
