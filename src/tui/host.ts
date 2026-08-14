import type { Key } from './input.js';
import { renderHeader, renderHome, renderPanel } from './home.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { COMMANDS, filterChoices, filterCommands, type Command } from './slash.js';
import type { Terminal } from './terminal.js';
import {
  THEMES,
  detectColorLevel,
  fgCode,
  hexRgb,
  themeNamed,
  type ColorLevel,
  type Theme,
  type ThemeName,
} from './theme.js';
import { CANCEL, type Choice, type Dashboard, type HomeRequest, type Ui } from './ui.js';
import {
  fillLine,
  fitLine,
  paintFg,
  rule,
  stripAnsi,
  truncateVisible,
  visibleWidth,
} from './widgets.js';

type Overlay =
  | {
      kind: 'select';
      title: string;
      all: Choice[];
      options: Choice[];
      index: number;
      filter: string;
      preview?: (value: string) => void;
    }
  | {
      kind: 'multi';
      title: string;
      options: Choice[];
      index: number;
      ticks: Set<string>;
    }
  | {
      kind: 'text';
      title: string;
      value: string;
      placeholder?: string;
    };

/**
 * Fullscreen host. Paints Grok-shaped chrome and implements {@link Ui}
 * as overlays. The command palette is a select, not a third input mode.
 */
export class TuiHost implements Ui {
  private palette: Theme;
  private readonly level: ColorLevel;
  private dashboard: Dashboard | undefined;
  private feed: string[] = [];
  private panel: { title: string; body: string } | undefined;
  private status: string | undefined;
  private overlay: Overlay | undefined;
  private promptText = '';
  private slashIndex = 0;
  private keyPending: Promise<Key | null> | undefined;

  constructor(private readonly term: Terminal) {
    this.level = detectColorLevel();
    this.palette = themeNamed(loadPrefs().theme);
  }

  start(): void {
    this.term.enter();
    this.term.onResize(() => this.paint());
    this.tintCursor();
    this.paint();
  }

  stop(): void {
    this.term.leave();
  }

  setTheme(name: ThemeName): void {
    this.palette = THEMES[name];
    savePrefs({ theme: name });
    this.tintCursor();
    this.paint();
  }

  theme(): ThemeName {
    return this.palette.name;
  }

  clearPanel(): void {
    this.panel = undefined;
    this.paint();
  }

  intro(): void {}
  outro(): void {}

  cancel(message = 'Cancelled.'): void {
    this.feed.push(message);
  }

  note(message: string, title?: string): void {
    this.panel = { title: title ?? 'Note', body: message };
    this.feed.push(title ? `${title}: ${firstLine(message)}` : firstLine(message));
    this.paint();
  }

  readonly log = {
    info: (message: string) => this.record(message),
    warn: (message: string) => this.record(message),
    error: (message: string) => this.record(message),
    success: (message: string) => this.record(message),
    message: (message: string) => this.record(message),
  };

  spinner(): { start(message: string): void; stop(message?: string): void } {
    return {
      start: (message) => {
        this.status = message;
        this.paint();
      },
      stop: (message) => {
        this.status = undefined;
        if (message) this.feed.push(message);
        this.paint();
      },
    };
  }

  async home(request: HomeRequest): Promise<string | typeof CANCEL> {
    this.dashboard = request.dashboard;
    this.promptText = '';
    this.slashIndex = 0;

    for (;;) {
      this.paint();
      const key = await this.takeKey();
      if (!key) return CANCEL;

      if (this.wantsPalette(key)) {
        const picked = await this.select({
          message: 'Command palette',
          options: request.options,
        });
        if (picked !== CANCEL) return picked;
        continue;
      }

      const result = this.handleHome(key, request.options);
      if (result !== undefined) {
        this.promptText = '';
        return result;
      }
    }
  }

  async select(opts: {
    message: string;
    options: Choice[];
    initialValue?: string;
    preview?: (value: string) => void;
  }): Promise<string | typeof CANCEL> {
    let index = opts.options.findIndex((option) => option.value === opts.initialValue);
    if (index < 0) index = 0;
    const picked = await this.prompt({
      kind: 'select',
      title: opts.message,
      all: opts.options,
      options: opts.options,
      index,
      filter: '',
      preview: opts.preview,
    });
    return typeof picked === 'string' || picked === CANCEL ? picked : CANCEL;
  }

  async confirm(opts: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean | typeof CANCEL> {
    const picked = await this.select({
      message: opts.message,
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
      initialValue: opts.initialValue === false ? 'no' : 'yes',
    });
    if (picked === CANCEL) return CANCEL;
    return picked === 'yes';
  }

  async text(opts: {
    message: string;
    initialValue?: string;
    placeholder?: string;
  }): Promise<string | undefined | typeof CANCEL> {
    const picked = await this.prompt({
      kind: 'text',
      title: opts.message,
      value: opts.initialValue ?? '',
      placeholder: opts.placeholder,
    });
    if (picked === CANCEL) return CANCEL;
    if (typeof picked !== 'string') return undefined;
    return picked === '' ? undefined : picked;
  }

  async multiselect(opts: {
    message: string;
    options: Choice[];
    required?: boolean;
  }): Promise<string[] | typeof CANCEL> {
    const picked = await this.prompt({
      kind: 'multi',
      title: opts.message,
      options: opts.options,
      index: 0,
      ticks: new Set(),
    });
    return Array.isArray(picked) || picked === CANCEL ? picked : CANCEL;
  }

  private async prompt(state: Overlay): Promise<string | string[] | typeof CANCEL> {
    let current = state;
    for (;;) {
      this.overlay = current;
      if (current.kind === 'select') {
        current.preview?.(current.options[current.index]?.value ?? '');
      }
      this.paint();
      const key = await this.takeKey();
      if (!key || isEscape(key)) return this.close(CANCEL);
      const next = applyKey(current, key);
      if (next.done) return this.close(next.value);
      current = next.state;
    }
  }

  private close<T>(value: T): T {
    this.overlay = undefined;
    this.paint();
    return value;
  }

  private wantsPalette(key: Key): boolean {
    if (key.type === 'ctrl' && key.value === 'p') return true;
    return this.promptText.length === 0 && key.type === 'char' && key.value === '?';
  }

  private handleHome(key: Key, options: Choice[]): string | typeof CANCEL | undefined {
    if (key.type === 'ctrl' && (key.value === 'q' || key.value === 'c' || key.value === 'd')) {
      return 'quit';
    }
    if (key.type === 'esc') {
      if (this.promptText) {
        this.promptText = '';
        this.slashIndex = 0;
        return undefined;
      }
      if (this.panel) this.panel = undefined;
      return undefined;
    }

    const empty = this.promptText.length === 0;
    if (empty && key.type === 'char' && key.value !== '/') {
      const hit = COMMANDS.find((command) => command.hotkey === key.value);
      if (hit && options.some((option) => option.value === hit.value)) return hit.value;
    }

    if (key.type === 'char') {
      this.promptText += key.value;
      this.slashIndex = 0;
      return undefined;
    }
    if (key.type === 'space') {
      this.promptText += ' ';
      return undefined;
    }
    if (key.type === 'backspace') {
      this.promptText = this.promptText.slice(0, -1);
      this.slashIndex = 0;
      return undefined;
    }
    if (key.type === 'up' || key.type === 'down') {
      const items = this.slashItems();
      if (items.length === 0) return undefined;
      this.slashIndex =
        key.type === 'down'
          ? Math.min(items.length - 1, this.slashIndex + 1)
          : Math.max(0, this.slashIndex - 1);
      return undefined;
    }
    if (key.type === 'enter' || key.type === 'tab') {
      if (!this.promptText.startsWith('/')) return undefined;
      const items = this.slashItems();
      const hit = items[this.slashIndex] ?? items[0];
      return hit?.value;
    }
    return undefined;
  }

  private slashItems(): Command[] {
    if (!this.promptText.startsWith('/')) return [];
    return filterCommands(this.promptText);
  }

  private takeKey(): Promise<Key | null> {
    if (!this.keyPending) this.keyPending = this.term.readKey();
    const pending = this.keyPending;
    return pending.then((key) => {
      if (this.keyPending === pending) this.keyPending = undefined;
      return key;
    });
  }

  private record(message: string): void {
    this.feed.push(firstLine(message));
    this.status = undefined;
    this.paint();
  }

  private tintCursor(): void {
    if (!fgCode(this.palette.accent, this.level)) return;
    const [r, g, b] = hexRgb(this.palette.accent);
    this.term.write(`\x1b]12;rgb:${to4(r)}/${to4(g)}/${to4(b)}\x07`);
  }

  paint(): void {
    const cols = Math.max(40, this.term.cols);
    const rows = Math.max(12, this.term.rows);
    const theme = this.palette;
    const level = this.level;
    const dash = this.dashboard ?? emptyDashboard();

    const header = renderHeader(dash, theme, level, cols);
    const footerH = 3;
    const bodyRows = Math.max(1, rows - header.length - footerH);
    const body = this.panel
      ? renderPanel(this.panel.title, this.panel.body, theme, level, cols, bodyRows)
      : renderHome(dash, this.feed, theme, level, cols, bodyRows);

    const lines = [
      ...header,
      ...body,
      fillLine(level, theme, rule(cols, theme, level), cols),
      fillLine(level, theme, this.promptLine(cols), cols, theme.bgPanel),
      fillLine(level, theme, this.shortcuts(), cols),
    ];

    const framed = this.composite(lines, cols, rows);
    const cursor = this.cursorOnPrompt()
      ? `\x1b[${rows - 1};${this.promptCursorCol() + 1}H\x1b[?25h`
      : '\x1b[?25l';

    this.term.write('\x1b[H' + framed.map((line) => fitLine(line, cols)).join('\r\n') + cursor);
  }

  private promptLine(cols: number): string {
    const prefix = paintFg(this.level, this.palette.accent, ' ❯ ');
    if (this.status) {
      return prefix + paintFg(this.level, this.palette.warning, this.status);
    }
    const shown =
      this.promptText.length > 0
        ? this.promptText
        : paintFg(this.level, this.palette.fgDim, '/ for commands');
    return truncateVisible(prefix + shown, cols);
  }

  private promptCursorCol(): number {
    return Math.min(this.term.cols - 1, 3 + this.promptText.length);
  }

  private cursorOnPrompt(): boolean {
    return !this.overlay && this.promptText.length > 0;
  }

  private shortcuts(): string {
    const hint =
      this.overlay?.kind === 'multi'
        ? ' ↑/↓ move · Space tick · Enter accept · Esc back'
        : this.overlay?.kind === 'text'
          ? ' Enter submit · Esc back'
          : this.overlay?.kind === 'select'
            ? ' ↑/↓ move · Enter select · type to filter · Esc back'
            : this.promptText.startsWith('/')
              ? ' ↑/↓ move · Enter run · Esc close · Ctrl+P palette · Ctrl+Q quit'
              : ' / commands · f foster · r return · u usage · Ctrl+P palette · Esc panel · Ctrl+Q quit';
    return paintFg(this.level, this.palette.fgDim, hint);
  }

  private composite(lines: string[], cols: number, rows: number): string[] {
    const copy = lines.slice(0, rows);
    while (copy.length < rows) copy.push(fillLine(this.level, this.palette, '', cols));

    if (this.promptText.startsWith('/') && !this.overlay) {
      const items = this.slashItems().slice(0, 8);
      if (items.length > 0) this.drawDropdown(copy, items, cols, rows);
    }
    if (this.overlay) this.drawModal(copy, cols, rows);
    return copy;
  }

  private drawDropdown(lines: string[], items: Command[], cols: number, rows: number): void {
    const width = Math.min(cols - 4, 64);
    const boxLines = this.listBox(
      items.map((item, i) => ({
        label: `/${item.slash.padEnd(12)} ${stripAnsi(item.label)}`,
        hint: item.hint,
        active: i === this.slashIndex,
      })),
      width,
      undefined,
    );
    const top = Math.max(0, rows - 3 - boxLines.length);
    this.blit(lines, boxLines, 2, top, cols);
  }

  private drawModal(lines: string[], cols: number, rows: number): void {
    const overlay = this.overlay!;
    const width = Math.min(cols - 4, 64);
    const rowsInBox = rowsFor(overlay, this.level, this.palette);
    const title =
      overlay.kind === 'select' && overlay.filter
        ? `${overlay.title}  ·  ${overlay.filter}`
        : overlay.title;
    const boxLines = this.listBox(rowsInBox.slice(0, Math.max(3, rows - 8)), width, title);
    const top = Math.max(1, Math.floor((rows - boxLines.length) / 2) - 1);
    const left = Math.max(1, Math.floor((cols - width) / 2));
    this.blit(lines, boxLines, left, top, cols);
  }

  private listBox(
    rows: Array<{ label: string; hint?: string; active: boolean }>,
    width: number,
    title: string | undefined,
  ): string[] {
    const theme = this.palette;
    const level = this.level;
    const inner = width - 2;
    const titleBit = title ? ` ${truncateVisible(title, inner - 2)} ` : '';
    const top =
      paintFg(level, theme.accent, '╭') +
      paintFg(level, theme.accent, titleBit) +
      paintFg(level, theme.border, '─'.repeat(Math.max(0, inner - visibleWidth(titleBit)))) +
      paintFg(level, theme.accent, '╮');
    const bottom =
      paintFg(level, theme.border, '╰') +
      paintFg(level, theme.border, '─'.repeat(inner)) +
      paintFg(level, theme.border, '╯');

    const mid = rows.map((row) => {
      const hint = row.hint ? paintFg(level, theme.fgDim, `  ${row.hint}`) : '';
      const marker = row.active ? paintFg(level, theme.accent, '▸ ') : '  ';
      const padded = truncateVisible(marker + row.label + hint, inner);
      const pad = ' '.repeat(Math.max(0, inner - visibleWidth(padded)));
      const body = row.active ? paintFg(level, theme.fuzzy, padded) + pad : padded + pad;
      return paintFg(level, theme.border, '│') + body + paintFg(level, theme.border, '│');
    });
    if (mid.length === 0) {
      mid.push(
        paintFg(level, theme.border, '│') +
          paintFg(level, theme.fgDim, padCenter('nothing matches', inner)) +
          paintFg(level, theme.border, '│'),
      );
    }
    return [top, ...mid, bottom];
  }

  private blit(dest: string[], src: string[], left: number, top: number, cols: number): void {
    for (let i = 0; i < src.length; i += 1) {
      const y = top + i;
      if (y < 0 || y >= dest.length) continue;
      dest[y] = overlayLine(src[i]!, left, cols, this.palette, this.level);
    }
  }
}

function applyKey(
  state: Overlay,
  key: Key,
): { done: true; value: string | string[] } | { done: false; state: Overlay } {
  if (state.kind === 'text') {
    if (key.type === 'enter') return { done: true, value: state.value };
    if (key.type === 'backspace')
      return { done: false, state: { ...state, value: state.value.slice(0, -1) } };
    if (key.type === 'char')
      return { done: false, state: { ...state, value: state.value + key.value } };
    if (key.type === 'space') return { done: false, state: { ...state, value: state.value + ' ' } };
    return { done: false, state };
  }

  if (key.type === 'up') {
    return { done: false, state: { ...state, index: Math.max(0, state.index - 1) } };
  }
  if (key.type === 'down') {
    return {
      done: false,
      state: { ...state, index: Math.min(state.options.length - 1, state.index + 1) },
    };
  }

  if (state.kind === 'select') {
    if (key.type === 'enter' || key.type === 'tab') {
      const value = state.options[state.index]?.value;
      if (value === undefined) return { done: false, state };
      return { done: true, value };
    }
    const filter =
      key.type === 'backspace'
        ? state.filter.slice(0, -1)
        : key.type === 'char'
          ? state.filter + key.value
          : key.type === 'space'
            ? state.filter + ' '
            : undefined;
    if (filter === undefined) return { done: false, state };
    const options = filterChoices(state.all, filter);
    return {
      done: false,
      state: {
        ...state,
        filter,
        options,
        index: Math.min(state.index, Math.max(0, options.length - 1)),
      },
    };
  }

  if (key.type === 'enter') return { done: true, value: [...state.ticks] };
  if (key.type === 'space') {
    const value = state.options[state.index]?.value;
    if (!value) return { done: false, state };
    const ticks = new Set(state.ticks);
    if (ticks.has(value)) ticks.delete(value);
    else ticks.add(value);
    return { done: false, state: { ...state, ticks } };
  }
  return { done: false, state };
}

function rowsFor(
  overlay: Overlay,
  level: ColorLevel,
  theme: Theme,
): Array<{ label: string; hint?: string; active: boolean }> {
  if (overlay.kind === 'text') {
    const value = overlay.value || paintFg(level, theme.fgDim, overlay.placeholder ?? '');
    return [{ label: value, active: true }];
  }
  return overlay.options.map((option, i) => ({
    label:
      overlay.kind === 'multi'
        ? `${overlay.ticks.has(option.value) ? '[x] ' : '[ ] '}${stripAnsi(option.label)}`
        : stripAnsi(option.label),
    hint: option.hint,
    active: i === overlay.index,
  }));
}

function isEscape(key: Key): boolean {
  return key.type === 'esc' || (key.type === 'ctrl' && key.value === 'c');
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

function padCenter(text: string, width: number): string {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

function to4(n: number): string {
  return Math.round((n / 255) * 0xffff)
    .toString(16)
    .padStart(4, '0');
}

function emptyDashboard(): Dashboard {
  return {
    version: '',
    store: '',
    signedIn: '',
    appRunning: false,
    accounts: [],
    fostered: [],
  };
}

function overlayLine(
  over: string,
  left: number,
  cols: number,
  theme: Theme,
  level: ColorLevel,
): string {
  const pad = ' '.repeat(Math.max(0, left));
  const combined = pad + over;
  const rest = Math.max(0, cols - visibleWidth(combined));
  return fillLine(level, theme, combined + ' '.repeat(rest), cols, theme.bgPanel);
}
