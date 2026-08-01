import pc from 'picocolors';
import { bareSessionId } from '../domain/naming.js';
import type { Outcome, OutcomeStatus } from '../engine/executor.js';
import type { DiscoveredSession } from '../domain/types.js';

export function formatDate(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

export function shortId(id: string): string {
  return bareSessionId(id).slice(0, 8);
}

export function sessionLine(session: DiscoveredSession): string {
  const date = formatDate(session.data.lastActivityAt ?? session.data.createdAt);
  const title = session.data.title ?? '(untitled)';
  const note = session.reasons.length > 0 ? pc.yellow(` [${session.reasons.join(', ')}]`) : '';
  return `  ${pc.dim(date)}  ${title}${note}`;
}

export function outcomeLine(outcome: Outcome): string {
  const marks: Record<OutcomeStatus, string> = {
    fostered: pc.green('+'),
    returned: pc.green('-'),
    skipped: pc.dim('·'),
    failed: pc.red('x'),
  };
  const detail = outcome.detail ? pc.dim(` (${outcome.detail})`) : '';
  return `  ${marks[outcome.status]} ${outcome.title}${detail}`;
}

/** Reminds the user that the sidebar is only rebuilt when the app starts. */
export function restartNotice(): string {
  return pc.dim('Restart Claude Desktop to see the change — the sidebar is built at startup.');
}
