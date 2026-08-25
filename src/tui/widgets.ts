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

export function padStartVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  if (width === 1) return '…';
  return `${plain.slice(0, width - 1)}…`;
}

/**
 * Truncation for paths: the two ends carry the identity (drive, leaf), the
 * middle is the part nobody reads. End-truncation would keep the prefix every
 * store shares and drop the one segment that differs.
 */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return '';
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  if (width === 1) return '…';
  const tail = Math.ceil((width - 1) / 2);
  const head = width - 1 - tail;
  return `${plain.slice(0, head)}…${plain.slice(plain.length - tail)}`;
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

/**
 * Paint a background under a run of already-styled text. Foreground paints end
 * in a full RESET, which would also drop the background for everything after
 * them — the padding of a heading, the gap between a row's two halves. Putting
 * the code back after every inner RESET is what keeps a line one solid slab
 * instead of a patchwork of the terminal's own background.
 */
export function paintSegment(level: ColorLevel, bgHex: string, text: string): string {
  const code = bgCode(bgHex, level);
  if (!code) return text;
  return `${code}${text.replaceAll(RESET, RESET + code)}${RESET}`;
}

export function fillLine(
  level: ColorLevel,
  theme: Theme,
  text: string,
  cols: number,
  bg: string = theme.bg,
): string {
  return paintSegment(level, bg, fitLine(text, cols));
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
