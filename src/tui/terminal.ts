import { isEscPrefix, parseKey, type Key } from './input.js';

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

const ESC_WAIT_MS = 50;

export class NodeTerminal implements Terminal {
  private buffer = '';
  private waiters: Array<(chunk: string | null) => void> = [];
  private onData = (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const waiter = this.waiters.shift();
    if (waiter) waiter(text);
    else this.buffer += text;
  };
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
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', this.onData);
    process.stdout.on('resize', this.onResizeEvent);
    // Alt-screen, hide cursor, clear. OSC 12 tints the cursor with the theme
    // accent so an active foster session is visible the way Grok's is.
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    this.restored = false;
    process.on('exit', this.leave);
    process.on('SIGINT', this.sigint);
    process.on('SIGTERM', this.sigint);
  }

  leave = (): void => {
    if (this.restored) return;
    this.restored = true;
    process.stdin.off('data', this.onData);
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

  onResize(handler: () => void): () => void {
    this.resizeHandler = handler;
    return () => {
      if (this.resizeHandler === handler) this.resizeHandler = undefined;
    };
  }

  async readKey(): Promise<Key | null> {
    for (;;) {
      const parsed = parseKey(this.buffer);
      if (parsed) {
        this.buffer = parsed.rest;
        return parsed.key;
      }
      if (isEscPrefix(this.buffer)) {
        const more = await this.waitChunk(ESC_WAIT_MS);
        if (more === null && this.buffer.startsWith('\x1b')) {
          this.buffer = this.buffer.slice(1);
          return { type: 'esc' };
        }
        if (more) this.buffer += more;
        continue;
      }
      const chunk = await this.waitChunk();
      if (chunk === null)
        return this.buffer.length ? (parseKey(this.buffer + '\x1b')?.key ?? null) : null;
      this.buffer += chunk;
    }
  }

  private waitChunk(timeoutMs?: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.buffer.length > 0 && timeoutMs === undefined) {
        // Data already arrived while we were painting.
        resolve('');
        return;
      }
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const i = this.waiters.indexOf(onChunk);
              if (i >= 0) this.waiters.splice(i, 1);
              resolve(null);
            }, timeoutMs);
      const onChunk = (chunk: string | null) => {
        if (timer) clearTimeout(timer);
        resolve(chunk);
      };
      this.waiters.push(onChunk);
    });
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
