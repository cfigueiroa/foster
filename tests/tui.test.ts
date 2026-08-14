import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyFromReadline, parseKey } from '../src/tui/input.js';
import { filterChoices, filterCommands, fuzzyScore } from '../src/tui/slash.js';
import { MemoryTerminal } from '../src/tui/terminal.js';
import { TuiHost } from '../src/tui/host.js';
import { detectColorLevel, to256 } from '../src/tui/theme.js';
import { loadPrefs, prefsPath, savePrefs } from '../src/tui/prefs.js';
import { meter } from '../src/tui/widgets.js';
import { FOSTER_NIGHT } from '../src/tui/theme.js';
import type { Dashboard } from '../src/tui/ui.js';

describe('parseKey', () => {
  it('reads arrows, enter, ctrl and unicode as one key each', () => {
    expect(parseKey('\x1b[A')?.key).toEqual({ type: 'up' });
    expect(parseKey('\x1b[B')?.key).toEqual({ type: 'down' });
    expect(parseKey('\r\n')?.key).toEqual({ type: 'enter' });
    expect(parseKey('\x03')?.key).toEqual({ type: 'ctrl', value: 'c' });
    expect(parseKey('\x11')?.key).toEqual({ type: 'ctrl', value: 'q' });
    expect(parseKey('/')?.key).toEqual({ type: 'char', value: '/' });
    expect(parseKey('\x1b[Z')?.key).toEqual({ type: 'tab', shift: true });
  });

  it('reads the Windows scan-code arrows a UTF-8 listener would drop', () => {
    expect(parseKey(Buffer.from([0xe0, 0x48]))?.key).toEqual({ type: 'up' });
    expect(parseKey(Buffer.from([0xe0, 0x50]))?.key).toEqual({ type: 'down' });
    expect(parseKey(Buffer.from([0x00, 0x4b]))?.key).toEqual({ type: 'left' });
    expect(parseKey(Buffer.from([0x00, 0x4d]))?.key).toEqual({ type: 'right' });
    expect(parseKey(Buffer.from([0xe0]))).toBeNull();
  });

  it('waits on a lone ESC rather than inventing a key', () => {
    expect(parseKey('\x1b')).toBeNull();
    expect(parseKey('\x1b[')).toBeNull();
  });
});

describe('keyFromReadline', () => {
  it('maps what Node reports for arrows on Windows', () => {
    expect(keyFromReadline(undefined, { name: 'up' })).toEqual({ type: 'up' });
    expect(keyFromReadline(undefined, { name: 'down' })).toEqual({ type: 'down' });
    expect(keyFromReadline('\r', { name: 'return' })).toEqual({ type: 'enter' });
    expect(keyFromReadline('c', { name: 'c', ctrl: true })).toEqual({ type: 'ctrl', value: 'c' });
  });
});

describe('slash fuzzy', () => {
  it('ranks a prefix above a subsequence', () => {
    expect(fuzzyScore('foster', 'fos')).toBeGreaterThan(fuzzyScore('foster', 'ftr'));
    const hits = filterCommands('fos').map((command) => command.value);
    expect(hits[0]).toBe('foster');
  });

  it('resolves aliases', () => {
    expect(filterCommands('exit').some((command) => command.value === 'quit')).toBe(true);
    expect(filterCommands('cost').some((command) => command.value === 'usage')).toBe(true);
  });

  it('filters a picker the same way, and shows nothing when nothing matches', () => {
    const options = [
      { value: 'foster', label: 'Bring sessions here' },
      { value: 'return', label: 'Send them back' },
    ];
    expect(filterChoices(options, 'fos').map((choice) => choice.value)).toEqual(['foster']);
    expect(filterChoices(options, 'zzzz')).toEqual([]);
  });
});

describe('theme', () => {
  it('goes silent under NO_COLOR', () => {
    expect(detectColorLevel({ NO_COLOR: '1' })).toBe('none');
    expect(detectColorLevel({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectColorLevel({ WT_SESSION: '1' })).toBe('truecolor');
  });

  it('quantizes rgb onto the 256 cube', () => {
    expect(to256(0, 0, 0)).toBe(16);
    expect(to256(255, 255, 255)).toBe(231);
  });

  it('persists the chosen theme under ~/.foster, not in the ledger', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'foster-ui-'));
    savePrefs({ theme: 'day' }, home);
    expect(loadPrefs(home).theme).toBe('day');
    expect(readFileSync(prefsPath(home), 'utf8')).toContain('"day"');
  });
});

describe('meter', () => {
  it('fills by percent and uses the critical colour at the limit', () => {
    const bar = meter(100, 10, 'exceeded_limit', FOSTER_NIGHT, 'none');
    expect(bar).toBe('██████████');
    expect(meter(0, 10, 'normal', FOSTER_NIGHT, 'none')).toBe('░░░░░░░░░░');
  });
});

describe('TuiHost', () => {
  it('paints a dashboard and quits from the slash menu', async () => {
    const term = new MemoryTerminal({ cols: 80, rows: 24 });
    const host = new TuiHost(term);
    host.start();

    const dashboard: Dashboard = {
      version: '0.27.0',
      store: 'C:\\Claude',
      signedIn: 'work',
      appRunning: true,
      accounts: [
        {
          accountUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          shortId: 'aaaaaaaa',
          label: 'work',
          isCurrent: true,
          plan: 'Max',
          sessions: 12,
          copies: 2,
        },
      ],
      fostered: [{ title: 'Refactor parser', date: '2026-08-01' }],
    };

    const done = host.home({
      message: 'What would you like to do?',
      options: [
        { value: 'foster', label: 'Bring sessions here' },
        { value: 'quit', label: 'Quit' },
      ],
      dashboard,
    });

    term.push([{ type: 'char', value: '/' }, { type: 'char', value: 'q' }, { type: 'enter' }]);

    await expect(done).resolves.toBe('quit');
    host.stop();
    expect(term.entered).toBe(true);
    expect(term.left).toBe(true);
    expect(term.lastFrame()).toMatch(/foster/i);
    expect(term.lastFrame()).toMatch(/work/);
    expect(term.lastFrame()).toMatch(/\/quit|Quit/i);
  });

  it('opens the command list when an arrow is pressed on an empty prompt', async () => {
    const term = new MemoryTerminal();
    const host = new TuiHost(term);
    const done = host.home({
      message: 'What would you like to do?',
      options: [
        { value: 'foster', label: 'Bring sessions here' },
        { value: 'quit', label: 'Quit' },
      ],
      dashboard: {
        version: '0.0.0',
        store: 'x',
        signedIn: 'me',
        appRunning: false,
        accounts: [],
        fostered: [],
      },
    });
    term.push([{ type: 'down' }, { type: 'enter' }]);
    await expect(done).resolves.toBe('foster');
  });

  it('runs a hotkey on an empty prompt', async () => {
    const term = new MemoryTerminal();
    const host = new TuiHost(term);
    const done = host.home({
      message: 'What would you like to do?',
      options: [
        { value: 'foster', label: 'Bring sessions here' },
        { value: 'quit', label: 'Quit' },
      ],
      dashboard: {
        version: '0.0.0',
        store: 'x',
        signedIn: 'me',
        appRunning: false,
        accounts: [],
        fostered: [],
      },
    });
    term.push({ type: 'char', value: 'f' });
    await expect(done).resolves.toBe('foster');
  });
});
