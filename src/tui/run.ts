import { NodeTerminal, type Terminal } from './terminal.js';
import { TuiHost } from './host.js';
import type { Ui } from './ui.js';

export function createLiveUi(term?: Terminal): Ui {
  return new TuiHost(term ?? new NodeTerminal());
}

export { TuiHost } from './host.js';
export { MemoryTerminal } from './terminal.js';
