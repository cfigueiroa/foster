import type { ColorLevel, Theme } from './theme.js';
import { BOLD, RESET, bgCode, fgCode } from './theme.js';

// CSI / OSC. Written as controls because that is what a TTY emits.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function padEndVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  if (width === 1) return '…';
  return `${plain.slice(0, width - 1)}…`;
}

export function fitLine(text: string, cols: number): string {
  if (cols <= 0) return '';
  const width = visibleWidth(text);
  if (width === cols) return text;
  if (width < cols) return text + ' '.repeat(cols - width);
  return truncateVisible(text, cols);
}

export function paintFg(level: ColorLevel, hex: string, text: string): string {
  const code = fgCode(hex, level);
  return code ? `${code}${text}${RESET}` : text;
}

export function paintBg(level: ColorLevel, hex: string, text: string): string {
  const code = bgCode(hex, level);
  return code ? `${code}${text}${RESET}` : text;
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function fillLine(
  level: ColorLevel,
  theme: Theme,
  text: string,
  cols: number,
  bg: string = theme.bg,
): string {
  const fitted = fitLine(text, cols);
  const code = bgCode(bg, level);
  return code ? `${code}${fitted}${RESET}` : fitted;
}

/**
 * A usage / quota bar that grows with the terminal, not a fixed ten cells.
 * Colour follows the same severity the app reports.
 */
export function meter(
  percent: number,
  width: number,
  severity: string | undefined,
  theme: Theme,
  level: ColorLevel,
): string {
  const cells = Math.max(4, width);
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  const color =
    severity === 'exceeded_limit' || clamped >= 100
      ? theme.barCrit
      : severity === 'approaching_limit' || clamped >= 80
        ? theme.barWarn
        : theme.barOk;
  const on = paintFg(level, color, '█'.repeat(filled));
  const off = paintFg(level, theme.barEmpty, '░'.repeat(cells - filled));
  return on + off;
}

export function rule(cols: number, theme: Theme, level: ColorLevel): string {
  return paintFg(level, theme.border, '─'.repeat(Math.max(0, cols)));
}

export function splitLeftRight(left: string, right: string, cols: number): string {
  const gap = 2;
  const rightW = visibleWidth(right);
  const leftW = Math.max(0, cols - rightW - gap);
  return padEndVisible(truncateVisible(left, leftW), leftW) + ' '.repeat(gap) + right;
}
