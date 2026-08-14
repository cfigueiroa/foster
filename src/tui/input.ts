/**
 * Bytes from a raw TTY, turned into the keys the TUI actually handles.
 *
 * Windows is the reason this is not "just CSI". In raw mode the console
 * often delivers arrows as a scan-code prefix (0xE0 or 0x00) plus a
 * second byte, not as ESC [ A. Decoding stdin as UTF-8 turns 0xE0 into a
 * replacement character and the arrow never arrives.
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
  rest: Buffer;
}

/** Node's `readline` keypress payload — the live TTY path uses this. */
export interface ReadlineKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/**
 * Pull one key off the front of a byte buffer. Returns null when the buffer
 * is empty, or when it is a prefix that might still grow.
 */
export function parseKey(input: string | Buffer | Uint8Array): ParseResult | null {
  const buffer = toBuffer(input);
  if (buffer.length === 0) return null;

  const first = buffer[0]!;

  // Windows scan-code arrows. A lone prefix waits for the second byte.
  if (first === 0xe0 || first === 0x00) {
    if (buffer.length < 2) return null;
    const mapped = windowsScan(buffer[1]!);
    if (mapped) return { key: mapped, rest: buffer.subarray(2) };
    return { key: { type: 'esc' }, rest: buffer.subarray(2) };
  }

  if (first === 0x1b) {
    if (buffer.length === 1) return null;
    return parseEsc(buffer);
  }

  if (first === 0x0d || first === 0x0a) {
    const rest = first === 0x0d && buffer[1] === 0x0a ? buffer.subarray(2) : buffer.subarray(1);
    return { key: { type: 'enter' }, rest };
  }
  if (first === 0x09) return { key: { type: 'tab' }, rest: buffer.subarray(1) };
  if (first === 0x7f || first === 0x08)
    return { key: { type: 'backspace' }, rest: buffer.subarray(1) };
  if (first === 0x20) return { key: { type: 'space' }, rest: buffer.subarray(1) };

  if (first < 32) {
    return {
      key: { type: 'ctrl', value: String.fromCharCode(first + 96) },
      rest: buffer.subarray(1),
    };
  }

  const utf8 = takeUtf8(buffer);
  if (!utf8) return null;
  return { key: { type: 'char', value: utf8.value }, rest: utf8.rest };
}

/**
 * Map a `readline` keypress. That is what Node already decodes on Windows,
 * including the scan-code arrows that a UTF-8 `data` listener never sees.
 */
export function keyFromReadline(str: string | undefined, key: ReadlineKey): Key | null {
  if (key.ctrl && key.name) {
    if (key.name === 'c' || key.name === 'd' || key.name === 'q' || key.name === 'p') {
      return { type: 'ctrl', value: key.name };
    }
    return { type: 'ctrl', value: key.name };
  }

  switch (key.name) {
    case 'up':
      return { type: 'up' };
    case 'down':
      return { type: 'down' };
    case 'left':
      return { type: 'left' };
    case 'right':
      return { type: 'right' };
    case 'return':
      return { type: 'enter' };
    case 'escape':
      return { type: 'esc' };
    case 'backspace':
      return { type: 'backspace' };
    case 'tab':
      return { type: 'tab', shift: key.shift };
    case 'space':
      return { type: 'space' };
    default:
      break;
  }

  if (str === ' ') return { type: 'space' };
  if (str && str.length > 0 && !key.ctrl) return { type: 'char', value: str };
  return null;
}

function parseEsc(buffer: Buffer): ParseResult | null {
  const second = buffer[1];

  if (second === 0x5b) {
    const text = buffer.toString('latin1');
    // ESC is a control character; the sequence is what terminals send for arrows.
    // eslint-disable-next-line no-control-regex -- CSI starts with ESC
    const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(text);
    if (!csi) return buffer.length > 12 ? { key: { type: 'esc' }, rest: buffer.subarray(1) } : null;
    const params = csi[1] ?? '';
    const cmd = csi[2]!;
    return { key: csiKey(params, cmd), rest: buffer.subarray(csi[0].length) };
  }

  if (second === 0x4f) {
    if (buffer.length < 3) return null;
    return { key: ss3Key(String.fromCharCode(buffer[2]!)), rest: buffer.subarray(3) };
  }

  if (second !== undefined) {
    const inner = parseKey(buffer.subarray(1));
    return inner ?? { key: { type: 'esc' }, rest: buffer.subarray(1) };
  }

  return { key: { type: 'esc' }, rest: buffer.subarray(1) };
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

function windowsScan(code: number): Key | undefined {
  if (code === 0x48) return { type: 'up' };
  if (code === 0x50) return { type: 'down' };
  if (code === 0x4b) return { type: 'left' };
  if (code === 0x4d) return { type: 'right' };
  if (code === 0x53) return { type: 'backspace' };
  return undefined;
}

export function isEscPrefix(input: string | Buffer | Uint8Array): boolean {
  const buffer = toBuffer(input);
  if (buffer.length === 1 && (buffer[0] === 0x1b || buffer[0] === 0xe0 || buffer[0] === 0x00)) {
    return true;
  }
  if (buffer.length === 2 && buffer[0] === 0x1b && (buffer[1] === 0x5b || buffer[1] === 0x4f)) {
    return true;
  }
  return false;
}

function toBuffer(input: string | Buffer | Uint8Array): Buffer {
  if (typeof input === 'string') return Buffer.from(input, 'latin1');
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function takeUtf8(buffer: Buffer): { value: string; rest: Buffer } | null {
  const first = buffer[0]!;
  const needed = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf8 ? 4 : 1;
  if (buffer.length < needed) return null;
  const slice = buffer.subarray(0, needed);
  const value = slice.toString('utf8');
  if (value === '\uFFFD' && first >= 0x80) {
    return { value: String.fromCharCode(first), rest: buffer.subarray(1) };
  }
  return { value, rest: buffer.subarray(needed) };
}
