import type { Choice } from './ui.js';

/**
 * The command menu. Values match the old clack menu so the flows and the
 * scripted tests keep the same vocabulary.
 */
export interface Command extends Choice {
  slash: string;
  /** Empty-prompt hotkey on the home screen. */
  hotkey?: string;
}

export const COMMANDS: Command[] = [
  {
    value: 'foster',
    slash: 'foster',
    hotkey: 'f',
    label: 'Bring sessions here',
    hint: "copy another account's sessions into this one",
  },
  {
    value: 'sweep',
    slash: 'sweep',
    hotkey: 'e',
    label: 'Bring everything here',
    hint: 'archived and deleted included, then check nothing is left',
  },
  {
    value: 'return',
    slash: 'return',
    hotkey: 'r',
    label: 'Send them back',
    hint: 'remove the copies, restoring the previous state',
  },
  {
    value: 'restore',
    slash: 'restore',
    label: 'Undo a deletion',
    hint: 'bring back a session deleted in the app',
  },
  {
    value: 'status',
    slash: 'status',
    hotkey: 's',
    label: 'What foster has done',
    hint: 'copies currently in place',
  },
  {
    value: 'browse',
    slash: 'browse',
    hotkey: 'b',
    label: 'What is on disk',
    hint: 'accounts, organizations and session counts',
  },
  {
    value: 'accounts',
    slash: 'accounts',
    hotkey: 'a',
    label: 'Who each account is',
    hint: 'plan, subscription and who is behind every account here',
  },
  {
    value: 'usage',
    slash: 'usage',
    hotkey: 'u',
    label: 'Usage right now',
    hint: 'live 5-hour and weekly limits, read from the API',
  },
  {
    value: 'renewals',
    slash: 'renewals',
    label: 'When things renew',
    hint: 'usage resets and billing dates across every account',
  },
  {
    value: 'label',
    slash: 'label',
    hotkey: 'l',
    label: 'Name an account',
    hint: 'so you stop reading UUIDs',
  },
  {
    value: 'installation',
    slash: 'install',
    label: 'Work on another installation',
    hint: 'point everything at a second profile',
  },
  {
    value: 'app',
    slash: 'app',
    label: 'Claude Desktop',
    hint: 'restart it — and why that is what makes changes show up',
  },
  {
    value: 'theme',
    slash: 'theme',
    label: 'Switch the colour theme',
    hint: 'FosterNight or FosterDay',
  },
  {
    value: 'home',
    slash: 'home',
    label: 'Back to the dashboard',
    hint: 'clear the current panel',
  },
  { value: 'quit', slash: 'quit', label: 'Quit', hint: 'leave foster' },
];

/**
 * What Enter offers for the account under the cursor. The signed-in account is
 * the destination, so "bring its sessions here" would be a no-op there; it gets
 * the read screens instead.
 */
export function accountActions(account: {
  isCurrent: boolean;
  label?: string;
  shortId: string;
  sessions: number;
}): Choice[] {
  const name = account.label ?? account.shortId;
  const label: Choice = {
    value: 'label',
    label: account.label ? `Rename "${name}"` : 'Name it',
    hint: 'so you stop reading UUIDs',
  };
  const details: Choice = {
    value: 'details',
    label: 'Who is this?',
    hint: 'plan, subscription and sessions — everything foster knows',
  };
  if (account.isCurrent) {
    return [
      details,
      { value: 'usage', label: 'Usage right now', hint: 'live limits, read from the API' },
      label,
    ];
  }
  return [
    // Only offered when there is something to bring: a Cowork-only or empty
    // account would turn this entry into a promise that can only fail.
    ...(account.sessions > 0
      ? [
          {
            value: 'foster-from',
            label: 'Bring its sessions here',
            hint: `copy ${name}'s sessions into this account`,
          },
        ]
      : []),
    details,
    label,
  ];
}

export const COMMAND_ALIASES: Record<string, string> = {
  exit: 'quit',
  q: 'quit',
  t: 'theme',
  store: 'installation',
  cost: 'usage',
  everything: 'sweep',
  all: 'sweep',
  welcome: 'home',
};

/** Case-insensitive subsequence / prefix score. 0 means no match. */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/^\//, '');
  if (!q) return 1;
  if (t === q) return 200;
  if (t.startsWith(q)) return 120;
  if (t.includes(q)) return 80;

  let i = 0;
  let score = 20;
  let last = -2;
  for (let n = 0; n < t.length && i < q.length; n += 1) {
    if (t[n] !== q[i]) continue;
    score += n === last + 1 ? 4 : 1;
    last = n;
    i += 1;
  }
  return i === q.length ? score : 0;
}

export function filterCommands(query: string, commands: Command[] = COMMANDS): Command[] {
  const raw = query.replace(/^\//, '').trim();
  if (!raw) return commands;
  const alias = COMMAND_ALIASES[raw.toLowerCase()];
  const scored = commands
    .map((command) => {
      const score = Math.max(
        fuzzyScore(command.slash, raw),
        fuzzyScore(command.value, raw),
        fuzzyScore(command.label, raw),
        alias === command.value ? 150 : 0,
      );
      return { command, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.command.slash.localeCompare(b.command.slash));
  return scored.map((row) => row.command);
}

export function commandBySlash(query: string): Command | undefined {
  const raw = query.replace(/^\//, '').trim().toLowerCase();
  const value = COMMAND_ALIASES[raw] ?? raw;
  return COMMANDS.find((command) => command.slash === value || command.value === value);
}

export function asChoices(commands: Command[] = COMMANDS): Choice[] {
  return commands.map(({ value, label, hint }) => ({ value, label, hint }));
}

/** Same score as the slash menu, so a typed overlay filter ranks like `/`. */
export function filterChoices(all: Choice[], query: string): Choice[] {
  const q = query.trim();
  if (!q) return all;
  return all
    .map((choice) => ({
      choice,
      score: Math.max(
        fuzzyScore(choice.label, q),
        fuzzyScore(choice.value, q),
        choice.hint ? fuzzyScore(choice.hint, q) : 0,
      ),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.choice.label.localeCompare(b.choice.label))
    .map((row) => row.choice);
}
