/**
 * Bytes from a raw TTY, turned into the keys the TUI actually handles.
 *
 * Windows Terminal and the VS Code family send xterm CSI. A lone ESC is only
 * an Escape after a short wait — otherwise it is the start of an arrow.
 */

export type Key =
  | { type: 'char'; value: string }
  | { type: 'space' }
  | { type: 'enter' }
  | { type: 'esc' }
  | { type: 'backspace' }
  | { type: 'tab'; shift?: boolean }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'ctrl'; value: string };

export interface ParseResult {
  key: Key;
  rest: string;
}

/**
 * Pull one key off the front of a buffer. Returns null when the buffer is
 * empty, or when it is a prefix that might still grow (ESC, incomplete CSI).
 */
export function parseKey(buffer: string): ParseResult | null {
  if (buffer.length === 0) return null;

  const first = buffer[0]!;

  if (first === '\x1b') {
    if (buffer.length === 1) return null;
    return parseEsc(buffer);
  }

  if (first === '\r' || first === '\n') {
    // Swallow a following LF after CR so Windows Enter is one key.
    const rest = first === '\r' && buffer[1] === '\n' ? buffer.slice(2) : buffer.slice(1);
    return { key: { type: 'enter' }, rest };
  }
  if (first === '\t') return { key: { type: 'tab' }, rest: buffer.slice(1) };
  if (first === '\x7f' || first === '\b')
    return { key: { type: 'backspace' }, rest: buffer.slice(1) };
  if (first === ' ') return { key: { type: 'space' }, rest: buffer.slice(1) };

  const code = first.charCodeAt(0);
  if (code < 32) {
    if (code === 0) return { key: { type: 'ctrl', value: 'space' }, rest: buffer.slice(1) };
    return { key: { type: 'ctrl', value: String.fromCharCode(code + 96) }, rest: buffer.slice(1) };
  }

  // UTF-8 already decoded by the stream; take one Unicode scalar.
  return { key: { type: 'char', value: first }, rest: buffer.slice(1) };
}

function parseEsc(buffer: string): ParseResult | null {
  const second = buffer[1];

  if (second === '[') {
    // ESC is a control character; the sequence is what terminals send for arrows.
    // eslint-disable-next-line no-control-regex
    const csi = /^(\x1b\[)([0-9;]*)([A-Za-z~])/.exec(buffer);
    if (!csi) {
      // Incomplete CSI — wait for more, unless it has gone on too long to be one.
      return buffer.length > 12 ? { key: { type: 'esc' }, rest: buffer.slice(1) } : null;
    }
    const params = csi[2] ?? '';
    const cmd = csi[3]!;
    const rest = buffer.slice(csi[0].length);
    const key = csiKey(params, cmd);
    return { key, rest };
  }

  // SS3 (application cursor keys): ESC O A
  if (second === 'O' && buffer.length >= 3) {
    const key = ss3Key(buffer[2]!);
    return { key, rest: buffer.slice(3) };
  }
  if (second === 'O') return null;

  // Alt+key arrives as ESC then the key. Treat it as the key; we do not bind Alt.
  if (second !== undefined) {
    const inner = parseKey(buffer.slice(1));
    return inner ?? { key: { type: 'esc' }, rest: buffer.slice(1) };
  }

  return { key: { type: 'esc' }, rest: buffer.slice(1) };
}

function csiKey(params: string, cmd: string): Key {
  if (cmd === 'A') return { type: 'up' };
  if (cmd === 'B') return { type: 'down' };
  if (cmd === 'C') return { type: 'right' };
  if (cmd === 'D') return { type: 'left' };
  if (cmd === 'Z') return { type: 'tab', shift: true };
  if (cmd === '~' && params === '3') return { type: 'backspace' };
  return { type: 'esc' };
}

function ss3Key(cmd: string): Key {
  if (cmd === 'A') return { type: 'up' };
  if (cmd === 'B') return { type: 'down' };
  if (cmd === 'C') return { type: 'right' };
  if (cmd === 'D') return { type: 'left' };
  return { type: 'esc' };
}

/** True when the buffer is only an ESC that might still become a sequence. */
export function isEscPrefix(buffer: string): boolean {
  return buffer === '\x1b' || buffer === '\x1b[' || buffer === '\x1bO';
}
