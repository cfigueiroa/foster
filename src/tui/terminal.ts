import readline from 'node:readline';
import { keyFromReadline, type Key } from './input.js';

/**
 * The only thing the TUI asks of a screen. A real TTY implements this with
 * alt-screen and raw mode; tests push keys and read frames.
 */
export interface Terminal {
  readonly cols: number;
  readonly rows: number;
  write(text: string): void;
  readKey(): Promise<Key | null>;
  onResize(handler: () => void): () => void;
  enter(): void;
  leave(): void;
  canRun(): boolean;
}

export class NodeTerminal implements Terminal {
  private keys: Key[] = [];
  private waiters: Array<(key: Key | null) => void> = [];
  private resizeHandler: (() => void) | undefined;
  private onResizeEvent = () => this.resizeHandler?.();
  private restored = true;

  get cols(): number {
    return process.stdout.columns || 80;
  }

  get rows(): number {
    return process.stdout.rows || 24;
  }

  canRun(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  enter(): void {
    if (!this.canRun()) return;
    // readline already knows Windows scan-code arrows. A UTF-8 `data`
    // listener does not — 0xE0 is not a character, so the key vanishes.
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.onKeypress);
    process.stdout.on('resize', this.onResizeEvent);
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    this.restored = false;
    process.on('exit', this.leave);
    process.on('SIGINT', this.sigint);
    process.on('SIGTERM', this.sigint);
  }

  leave = (): void => {
    if (this.restored) return;
    this.restored = true;
    process.stdin.off('keypress', this.onKeypress);
    process.stdout.off('resize', this.onResizeEvent);
    process.off('exit', this.leave);
    process.off('SIGINT', this.sigint);
    process.off('SIGTERM', this.sigint);
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      // Already torn down — still emit the restore sequences.
    }
    process.stdout.write('\x1b[?25h\x1b[?1049l\x1b]112\x07');
  };

  private sigint = (): void => {
    this.leave();
    const waiter = this.waiters.shift();
    if (waiter) waiter(null);
  };

  private onKeypress = (str: string | undefined, key: readline.Key): void => {
    const mapped = keyFromReadline(str, key);
    if (!mapped) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(mapped);
    else this.keys.push(mapped);
  };

  onResize(handler: () => void): () => void {
    this.resizeHandler = handler;
    return () => {
      if (this.resizeHandler === handler) this.resizeHandler = undefined;
    };
  }

  readKey(): Promise<Key | null> {
    const next = this.keys.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * In-memory terminal for tests: push keys, collect frames. `write` records
 * everything; a CSI-H clear starts a new frame so assertions can look at the
 * last full paint.
 */
export class MemoryTerminal implements Terminal {
  cols: number;
  rows: number;
  frames: string[] = [];
  current = '';
  private keys: Key[] = [];
  private waiters: Array<(key: Key | null) => void> = [];
  entered = false;
  left = false;

  constructor(size: { cols?: number; rows?: number } = {}) {
    this.cols = size.cols ?? 80;
    this.rows = size.rows ?? 24;
  }

  canRun(): boolean {
    return true;
  }

  write(text: string): void {
    if (text.includes('\x1b[H') || text.includes('\x1b[2J')) {
      if (this.current) this.frames.push(this.current);
      this.current = text;
      return;
    }
    this.current += text;
  }

  lastFrame(): string {
    return this.current || (this.frames[this.frames.length - 1] ?? '');
  }

  push(key: Key | Key[]): void {
    const list = Array.isArray(key) ? key : [key];
    for (const item of list) {
      const waiter = this.waiters.shift();
      if (waiter) waiter(item);
      else this.keys.push(item);
    }
  }

  end(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(null);
    else this.keys.push({ type: 'ctrl', value: 'c' });
  }

  readKey(): Promise<Key | null> {
    const next = this.keys.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  onResize(): () => void {
    return () => {};
  }

  enter(): void {
    this.entered = true;
  }

  leave(): void {
    this.left = true;
    if (this.current) this.frames.push(this.current);
  }
}
