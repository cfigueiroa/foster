import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskReport } from '../src/engine/diskUsage.js';
import { scanStore, SESSION_FILE_MAX_BYTES } from '../src/store/scanner.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * `foster disk` — report-only measurement. Every scenario here checks that the
 * numbers come out right; none of them checks that anything was deleted,
 * because nothing here ever deletes anything.
 */

function configEnv(): { configDir: string; env: NodeJS.ProcessEnv } {
  const configDir = mkdtempSync(path.join(tmpdir(), 'foster-disk-cfg-'));
  return { configDir, env: { CLAUDE_CONFIG_DIR: configDir } };
}

/** Writes a transcript directly, the way `purge.test.ts` does. */
function transcript(configDir: string, cliSessionId: string, project: string, body = 'x'): string {
  const dir = path.join(configDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cliSessionId}.jsonl`);
  writeFileSync(file, body, 'utf8');
  return file;
}

const A = '00000000-0000-4000-8000-0000000001a1';
const B = '00000000-0000-4000-8000-0000000001a2';
const C = '00000000-0000-4000-8000-0000000001a3';

describe('diskReport', () => {
  it('measures card bytes per account and per project', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: A, cwd: '/work/one' }));
    writeSession(store, NEW_ACCOUNT, session({ sessionId: B, cwd: '/work/two' }));
    const { env } = configEnv();

    const sessions = scanStore(store);
    const report = diskReport(store, sessions, env);

    expect(report.totals.cardCount).toBe(2);
    expect(report.accounts).toHaveLength(2);
    const old = report.accounts.find((row) => row.account.accountUuid === OLD_ACCOUNT.accountUuid);
    expect(old?.cardCount).toBe(1);
    expect(old?.cardBytes).toBeGreaterThan(0);

    const projects = report.projects.map((row) => row.project);
    expect(projects).toContain('-work-one');
    expect(projects).toContain('-work-two');
  });

  it('measures how much of a card is BULKY_CARD_FIELDS, by field', () => {
    const store = makeStore();
    const bulky = 'x'.repeat(1000);
    writeSession(store, OLD_ACCOUNT, session({ sessionId: A, remoteMcpServersConfig: bulky }));
    const { env } = configEnv();

    const report = diskReport(store, scanStore(store), env);

    const field = report.bulkyFields.find((row) => row.field === 'remoteMcpServersConfig');
    // The field's own JSON size (quotes included) is 1002 bytes; the card
    // around it carries the rest.
    expect(field?.bytes).toBe(1002);
    expect(field?.cardCount).toBe(1);
    expect(report.totals.bulkyCardBytes).toBe(1002);
    expect(report.totals.bulkyCardBytes).toBeLessThan(report.totals.cardBytes);
  });

  it("flags a card over the app's 10 MB load limit", () => {
    const store = makeStore();
    const huge = 'x'.repeat(SESSION_FILE_MAX_BYTES + 1000);
    writeSession(store, OLD_ACCOUNT, session({ sessionId: A, remoteMcpServersConfig: huge }));
    writeSession(store, OLD_ACCOUNT, session({ sessionId: B }));
    const { env } = configEnv();

    const report = diskReport(store, scanStore(store), env);

    expect(report.oversizedCards).toHaveLength(1);
    expect(report.oversizedCards[0]!.bytes).toBeGreaterThan(SESSION_FILE_MAX_BYTES);
  });

  it('finds a transcript no card in any account points at, as an orphan', () => {
    const store = makeStore();
    writeSession(store, OLD_ACCOUNT, session({ sessionId: A, cliSessionId: A }));
    const { configDir, env } = configEnv();
    transcript(configDir, A, 'proj-a'); // referenced
    transcript(configDir, B, 'proj-b', 'orphaned body'); // nothing points at this one

    const report = diskReport(store, scanStore(store), env);

    expect(report.orphanTranscripts).toHaveLength(1);
    expect(report.orphanTranscripts[0]!.cliSessionId).toBe(B);
    expect(report.orphanTranscripts[0]!.bytes).toBe('orphaned body'.length);
  });

  it('does not count a transcript referenced only by a copy as an orphan', () => {
    const store = makeStore();
    // A copy still proves the conversation is reachable somewhere, even with
    // no native card left.
    writeSession(
      store,
      NEW_ACCOUNT,
      session({
        sessionId: A,
        cliSessionId: A,
        _foster: {
          originAccountUuid: OLD_ACCOUNT.accountUuid,
          originOrganizationUuid: OLD_ACCOUNT.organizationUuid,
          originSessionId: `local_${A}`,
          fosteredAt: 1_700_000_000_000,
          toolVersion: '0.0.0',
        },
      }),
    );
    const { configDir, env } = configEnv();
    transcript(configDir, A, 'proj-a');

    const report = diskReport(store, scanStore(store), env);

    expect(report.orphanTranscripts).toHaveLength(0);
  });

  it('groups byte-identical transcripts, and leaves same-size-but-different ones apart', () => {
    const store = makeStore();
    const { configDir, env } = configEnv();
    transcript(configDir, A, 'proj-a', 'identical-body');
    transcript(configDir, B, 'proj-b', 'identical-body');
    // Same length as the pair above, different content — must not be grouped with it.
    transcript(configDir, C, 'proj-c', 'different-bod!');

    const report = diskReport(store, scanStore(store), env);

    expect(report.duplicateTranscripts).toHaveLength(1);
    const group = report.duplicateTranscripts[0]!;
    expect(group.files).toHaveLength(2);
    expect(group.bytes).toBe('identical-body'.length);
  });

  it('reports totals of zero rather than throwing on an empty store', () => {
    const store = makeStore();
    const { env } = configEnv();

    const report = diskReport(store, scanStore(store), env);

    expect(report.totals).toEqual({
      cardBytes: 0,
      cardCount: 0,
      bulkyCardBytes: 0,
      transcriptBytes: 0,
      transcriptCount: 0,
    });
    expect(report.orphanTranscripts).toEqual([]);
    expect(report.duplicateTranscripts).toEqual([]);
    expect(report.oversizedCards).toEqual([]);
  });
});
