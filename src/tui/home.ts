import { REVERSE, type ColorLevel, type Theme } from './theme.js';
import type { Dashboard } from './ui.js';
import {
  bold,
  fillLine,
  padStartVisible,
  paintFg,
  rule,
  splitLeftRight,
  truncateMiddle,
  truncateVisible,
  visibleWidth,
} from './widgets.js';

export function renderHome(
  dashboard: Dashboard,
  feed: string[],
  theme: Theme,
  level: ColorLevel,
  cols: number,
  rows: number,
  selectedAccount = -1,
): string[] {
  const lines: string[] = [];
  const push = (text: string, bg: string = theme.bg) => {
    lines.push(fillLine(level, theme, text, cols, bg));
  };
  const dim = (text: string) => paintFg(level, theme.fgDim, text);
  const accent = (text: string) => paintFg(level, theme.accent, text);
  const heading = (label: string, meta?: string) => {
    push('');
    const title = ` ${accent(bold(label))}${meta ? dim(` · ${meta}`) : ''} `;
    const tail = Math.max(0, cols - visibleWidth(title));
    push(title + paintFg(level, theme.border, '─'.repeat(tail)));
  };
  // `1 session` under `12 sessions`: digits right-aligned into a shared column,
  // the singular padded to the plural so the separators line up too.
  const counted = (n: number, digits: number, singular: string, plural: string) =>
    paintFg(level, theme.fg, padStartVisible(String(n), digits)) +
    ' ' +
    dim((n === 1 ? singular : plural).padEnd(plural.length));

  heading('ACCOUNTS', dashboard.accounts.length ? String(dashboard.accounts.length) : undefined);
  if (dashboard.accounts.length === 0) {
    push(dim('  no accounts in this installation yet'));
  }
  const sessionDigits = Math.max(
    1,
    ...dashboard.accounts.map((account) => String(account.sessions).length),
  );
  const copyDigits = Math.max(
    1,
    ...dashboard.accounts.map((account) => String(account.copies).length),
  );
  // The cursor must never walk off the drawn region: when the list is longer
  // than the space, a window slides with the selection and names what it hides.
  const maxVisible = Math.max(1, rows - 4);
  const start =
    dashboard.accounts.length <= maxVisible
      ? 0
      : Math.min(
          Math.max(0, selectedAccount - maxVisible + 1),
          dashboard.accounts.length - maxVisible,
        );
  if (start > 0) push(dim(`    … ${start} more above`));
  for (const [offset, account] of dashboard.accounts.slice(start, start + maxVisible).entries()) {
    const index = start + offset;
    const selected = index === selectedAccount;
    const name = account.label ?? account.shortId;
    const marker = account.isCurrent
      ? accent('●')
      : account.paymentNeedsAuth
        ? paintFg(level, theme.warning, '!')
        : dim('○');
    // The cursor takes the gutter; the current-account bar yields to it for
    // the moment — the ● marker keeps saying which account is signed in.
    const caret = selected ? accent('▸') : account.isCurrent ? accent('▌') : ' ';
    // A remembered "active" is what the subscription was on the day foster
    // last saw the account — dated and dimmed rather than confidence-green.
    const subscriptionColour = account.subscription
      ? account.subscription !== 'active'
        ? theme.warning
        : account.subscriptionAsOf
          ? theme.fgDim
          : theme.success
      : theme.fgDim;
    const meta = [
      account.plan ? dim(account.plan) : undefined,
      account.subscription
        ? paintFg(level, subscriptionColour, account.subscription) +
          (account.subscriptionAsOf ? dim(` as of ${account.subscriptionAsOf}`) : '')
        : undefined,
      account.paymentNeedsAuth ? paintFg(level, theme.warning, 'payment needs auth') : undefined,
    ].filter((part): part is string => part !== undefined);
    const left = `${caret} ${marker} ${bold(name)}${meta.length ? `  ${meta.join(dim(' · '))}` : ''}`;
    const right =
      counted(account.sessions, sessionDigits, 'session', 'sessions') +
      dim(' · ') +
      counted(account.copies, copyDigits, 'copy', 'copies') +
      ' ';
    push(splitLeftRight(left, right, cols), selected ? theme.bgHighlight : theme.bg);
  }
  const below = dashboard.accounts.length - start - maxVisible;
  if (below > 0) push(dim(`    … ${below} more below`));

  heading('FOSTERED', dashboard.fostered.length ? String(dashboard.fostered.length) : undefined);
  if (dashboard.fostered.length === 0) {
    push(dim('  nothing fostered yet — ') + accent('/foster') + dim(' to bring sessions here'));
  } else {
    for (const item of dashboard.fostered.slice(0, 8)) {
      const note = item.elsewhere ? `→ ${truncateMiddle(item.elsewhere, 24)}` : undefined;
      const left = `  ${accent('↪')} ${item.title}`;
      const right = dim(note ? `${note} · ${item.date}` : item.date) + ' ';
      push(splitLeftRight(left, right, cols));
    }
    if (dashboard.fostered.length > 8) {
      push(`    ${dim(`… and ${dashboard.fostered.length - 8} more · `)}${accent('/status')}`);
    }
  }

  if (feed.length > 0) {
    heading('ACTIVITY');
    for (const line of feed.slice(-4)) {
      push(`  ${dim('·')} ${dim(truncateVisible(line, Math.max(0, cols - 4)))}`);
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
  const dim = (text: string) => paintFg(level, theme.fgDim, text);
  // Reverse video, not an explicit background: accent-on-dark wherever the
  // terminal honours it, plain bold where colour is off — never dark-on-dark.
  const badge =
    level === 'none'
      ? bold(' foster ')
      : paintFg(level, theme.accent, `${REVERSE}${bold(' foster ')}`);
  const left = ` ${badge} ${dim(dashboard.version)}`;
  // Everything here is painted an explicit foreground: the line sits on the
  // theme's forced background, so the terminal's own default fg is not safe.
  const fg = (text: string) => paintFg(level, theme.fg, text);
  const app = dashboard.appRunning
    ? `${paintFg(level, theme.success, '●')}${fg(' app running')}`
    : `${dim('○')}${fg(' app idle')}`;
  const fostered =
    dashboard.fostered.length === 0 ? 'nothing fostered' : `${dashboard.fostered.length} fostered`;
  const right = `${fg(bold(dashboard.signedIn))}${dim(' · ')}${app}${dim(' · ')}${fg(fostered)} `;
  const store = ` ${dim(truncateMiddle(dashboard.store, Math.max(0, cols - 2)))}`;
  const second = dashboard.update
    ? splitLeftRight(store, `${paintFg(level, theme.warning, dashboard.update)} `, cols)
    : store;
  return [
    fillLine(level, theme, splitLeftRight(left, right, cols), cols),
    fillLine(level, theme, second, cols),
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
  const heading = ` ${paintFg(level, theme.accent, bold(title))} `;
  const tail = Math.max(0, cols - visibleWidth(heading));
  const lines = [
    fillLine(level, theme, heading + paintFg(level, theme.border, '─'.repeat(tail)), cols),
    fillLine(level, theme, '', cols),
  ];
  for (const raw of body.split('\n')) {
    lines.push(fillLine(level, theme, ` ${raw}`, cols));
  }
  while (lines.length < rows) lines.push(fillLine(level, theme, '', cols));
  return lines.slice(0, rows);
}
