import { readFileSync } from 'node:fs';

/**
 * `foster export`: one conversation, rendered from every file it occupies.
 *
 * AGENTS.md's "One conversation can be two files" is the reason this reads
 * more than the single path a caller might hand it: continuing one
 * conversation from a repository and from a worktree cut out of it leaves two
 * transcripts under one `cliSessionId`, each holding what was written while
 * its own card was the one in use, and a render of only one of them is
 * missing whatever the other side wrote. Records are deduplicated by `uuid`
 * — a record written to two files by construction is the same record — and
 * ordered by `timestamp`, falling back to the order they were read in for the
 * handful that carry none (the app's own bookkeeping, which never gets a
 * heading here regardless).
 */

export interface ExportRecord {
  uuid: string;
  parentUuid: string | null;
  /** `user`, `assistant`, or one of the app's own bookkeeping kinds. */
  type: string;
  /** Epoch ms, when the record carries a readable ISO timestamp. */
  timestamp?: number;
  /** The record exactly as the transcript wrote it — what `jsonl` passes through. */
  raw: Record<string, unknown>;
}

/**
 * Every record of a conversation, across every file it occupies, deduplicated
 * and in timeline order.
 *
 * Whole-file reads rather than the chunked latin1 scan `grep.ts` and
 * `idsMentionedIn` use: those exist because a corpus-wide search cannot afford
 * to parse everything, while this reads one conversation, whose files are
 * bounded by what one transcript ever grows to, and rendering wants the real,
 * correctly-decoded text — which is what asking for `utf8` and parsing every
 * line, rather than only the ones a coarse pass flagged, buys here.
 */
export function readConversationRecords(files: readonly string[]): ExportRecord[] {
  const byUuid = new Map<string, ExportRecord>();
  const orderOf = new Map<string, number>();
  let order = 0;

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      // ENOENT alone is "vanished since the index named it" — what the other
      // files hold is still the best answer available, so skip it and carry
      // on. Anything else (a file past V8's string-length ceiling, EACCES,
      // ...) must not silently render a partial export as if it were
      // complete: this is a rendering the user may act on, not a scan whose
      // job is to degrade gracefully.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`could not read ${file}: ${(error as Error).message}`, { cause: error });
    }

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const uuid = typeof record.uuid === 'string' ? record.uuid : undefined;
      // The app's own bookkeeping — `custom-title`, `mode`, `queue-operation` —
      // carries no uuid at all and is rewritten on every save; see
      // `conversationRoot`. It has no place in a rendered conversation.
      if (uuid === undefined || uuid === '') continue;
      // Seen in an earlier file already: the two copies of a shared record
      // agree by construction, so the first one read stands.
      if (byUuid.has(uuid)) continue;

      const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      byUuid.set(uuid, {
        uuid,
        parentUuid: typeof record.parentUuid === 'string' ? record.parentUuid : null,
        type: typeof record.type === 'string' ? record.type : 'unknown',
        ...(Number.isFinite(timestamp) ? { timestamp } : {}),
        raw: record,
      });
      orderOf.set(uuid, order++);
    }
  }

  return [...byUuid.values()].sort((a, b) => {
    const at = a.timestamp ?? Number.POSITIVE_INFINITY;
    const bt = b.timestamp ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return (orderOf.get(a.uuid) ?? 0) - (orderOf.get(b.uuid) ?? 0);
  });
}

interface ContentPart {
  kind: 'text' | 'tool_use' | 'tool_result' | 'other';
  text?: string;
  name?: string;
}

/** A message's content, normalised to the parts a render cares about. */
function partsOf(record: ExportRecord): ContentPart[] {
  const message = record.raw.message;
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content.trim() === '' ? [] : [{ kind: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const parts: ContentPart[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim() !== '') parts.push({ kind: 'text', text });
    } else if (type === 'tool_use') {
      const name = (block as { name?: unknown }).name;
      parts.push({ kind: 'tool_use', name: typeof name === 'string' ? name : 'tool' });
    } else if (type === 'tool_result') {
      parts.push({ kind: 'tool_result' });
    }
    // Anything else — thinking blocks, images — is passed over: `jsonl` still
    // carries it in `raw`, and this render is about the turns of a
    // conversation, not a byte-for-byte replay.
  }
  return parts;
}

export interface ExportMeta {
  cliSessionId: string;
  title?: string;
  cwd?: string;
}

/** Every part, on the fewest lines a reader needs: one for text, one per tool call. */
function linesOf(parts: readonly ContentPart[]): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.kind === 'text') lines.push(part.text ?? '');
    else if (part.kind === 'tool_use') lines.push(`> tool: ${part.name}`);
    else if (part.kind === 'tool_result') lines.push('> tool result');
  }
  return lines;
}

/**
 * User/assistant turns as Markdown headings, tool calls collapsed to the one
 * line `linesOf` gives them. Records of any other `type` — and a turn whose
 * only content is something `partsOf` passes over — are left out rather than
 * shown empty.
 */
export function renderMarkdown(records: readonly ExportRecord[], meta: ExportMeta): string {
  const out: string[] = [
    `# ${meta.title ?? '(untitled conversation)'}`,
    '',
    `- id: ${meta.cliSessionId}`,
    ...(meta.cwd !== undefined ? [`- cwd: ${meta.cwd}`] : []),
    '',
  ];

  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const lines = linesOf(partsOf(record));
    if (lines.length === 0) continue;
    const who = record.type === 'user' ? 'User' : 'Assistant';
    const when = record.timestamp !== undefined ? new Date(record.timestamp).toISOString() : '';
    out.push(`### ${who}${when ? ` — ${when}` : ''}`, '', ...lines, '');
  }

  return out.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Self-contained: no external stylesheet or script, so the file opens on its own. */
export function renderHtml(records: readonly ExportRecord[], meta: ExportMeta): string {
  const turns: string[] = [];
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const body = linesOf(partsOf(record))
      .map((line) =>
        line.startsWith('> ')
          ? `<p class="tool">${escapeHtml(line.slice(2))}</p>`
          : `<p>${escapeHtml(line).replace(/\n/g, '<br>')}</p>`,
      )
      .join('\n');
    if (body === '') continue;
    const when = record.timestamp !== undefined ? new Date(record.timestamp).toISOString() : '';
    turns.push(
      `<section class="turn ${record.type}"><header>${record.type === 'user' ? 'User' : 'Assistant'}` +
        `${when ? ` — ${escapeHtml(when)}` : ''}</header>\n${body}\n</section>`,
    );
  }

  const title = meta.title ?? '(untitled conversation)';
  return (
    '<!doctype html>\n' +
    '<html><head><meta charset="utf-8">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    '<style>\n' +
    'body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;' +
    'line-height:1.5;color:#1a1a1a}\n' +
    'section.turn{margin:1.5rem 0;padding:1rem;border-radius:8px}\n' +
    'section.user{background:#eef2ff}\n' +
    'section.assistant{background:#f4f4f5}\n' +
    'header{font-weight:600;font-size:0.85rem;color:#555;margin-bottom:0.5rem}\n' +
    'p{margin:0.5rem 0}\n' +
    'p.tool{font-family:ui-monospace,Consolas,monospace;font-size:0.85rem;color:#555;' +
    'background:#e4e4e7;padding:0.25rem 0.5rem;border-radius:4px;display:inline-block}\n' +
    '</style></head>\n' +
    '<body>\n' +
    `<h1>${escapeHtml(title)}</h1>\n` +
    `<p><small>${escapeHtml(meta.cliSessionId)}${meta.cwd ? ` — ${escapeHtml(meta.cwd)}` : ''}</small></p>\n` +
    `${turns.join('\n')}\n` +
    '</body></html>\n'
  );
}

/** The raw records, deduplicated and in timeline order — what `readConversationRecords` built. */
export function renderJsonl(records: readonly ExportRecord[]): string {
  return (
    records.map((record) => JSON.stringify(record.raw)).join('\n') + (records.length ? '\n' : '')
  );
}

export type ExportFormat = 'md' | 'html' | 'jsonl';

export function renderConversation(
  records: readonly ExportRecord[],
  meta: ExportMeta,
  format: ExportFormat,
): string {
  if (format === 'html') return renderHtml(records, meta);
  if (format === 'jsonl') return renderJsonl(records);
  return renderMarkdown(records, meta);
}
