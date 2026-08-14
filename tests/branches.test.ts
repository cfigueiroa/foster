import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forksOf, weighBranches } from '../src/engine/branches.js';
import { lineageAt } from '../src/engine/lineage.js';

/**
 * Which half of a fork carried on.
 *
 * The measure is records a branch holds that no sibling holds. These are the
 * tests for the two measures it replaced, both of which looked right and were
 * not: the file's `mtime`, which the app moves by rewriting bookkeeping whenever
 * a card is opened, and the ordered common prefix, which assumes the app writes
 * a branch in the original's order.
 */

const ROOT = '00000000-0000-4000-8000-0000000000a0';
const TRUNK = '00000000-0000-4000-8000-0000000000a1';
const TIP = '00000000-0000-4000-8000-0000000000a2';
const ALONE = '00000000-0000-4000-8000-0000000000a3';

let next = 0;
function uuid(): string {
  next += 1;
  return `00000000-0000-4000-8000-0000000${String(next).padStart(5, '0')}`;
}

function record(id: string, at = '2026-08-06T05:12:01.370Z'): string {
  return JSON.stringify({ uuid: id, type: 'user', timestamp: at });
}

/** The app's own bookkeeping: no uuid, rewritten on every save. */
const META = JSON.stringify({ type: 'custom-title', customTitle: 'Work' });

function transcripts(files: Record<string, string[]>): string[] {
  const config = mkdtempSync(path.join(tmpdir(), 'foster-br-'));
  const dir = path.join(config, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  for (const [id, lines] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }
  return [path.join(config, 'projects')];
}

function fileOf(dirs: string[], id: string): string {
  return path.join(dirs[0]!, '-workspace-project', `${id}.jsonl`);
}

describe('weighBranches', () => {
  it('counts the records a branch holds that its sibling does not', () => {
    const shared = [record(ROOT), record(uuid()), record(uuid())];
    const dirs = transcripts({
      [TRUNK]: [META, ...shared, record(uuid())],
      [TIP]: [META, ...shared, record(uuid()), record(uuid()), record(uuid())],
    });

    const [tip, trunk] = weighBranches([TRUNK, TIP], lineageAt(dirs));

    expect(tip!.cliSessionId).toBe(TIP);
    expect(tip!.only).toBe(3);
    expect(tip!.shared).toBe(3);
    expect(tip!.total).toBe(6);
    expect(trunk!.only).toBe(1);
  });

  it('is not moved by the file that was written last', () => {
    const shared = [record(ROOT), record(uuid())];
    const dirs = transcripts({
      [TRUNK]: [META, ...shared, record(uuid())],
      [TIP]: [META, ...shared, record(uuid()), record(uuid()), record(uuid())],
    });

    // Opening a card makes the app rewrite its bookkeeping into the transcript,
    // so the half nobody has added a word to can carry the newer timestamp. A
    // ranking that reads mtime can be flipped by looking at the wrong row.
    const later = new Date(Date.now() + 120_000);
    utimesSync(fileOf(dirs, TRUNK), later, later);

    expect(weighBranches([TRUNK, TIP], lineageAt(dirs))[0]!.cliSessionId).toBe(TIP);
  });

  it('does not assume the shared history is a prefix', () => {
    // The app does not write a branch in the original's order. Walking both files
    // in step until they differ answers on the first line and calls almost
    // everything exclusive; membership does not care about order.
    const a = record(uuid());
    const b = record(uuid());
    const dirs = transcripts({
      [TRUNK]: [META, record(ROOT), a, b],
      [TIP]: [META, record(ROOT), b, a, record(uuid())],
    });

    const [tip, trunk] = weighBranches([TRUNK, TIP], lineageAt(dirs));
    expect(tip!.cliSessionId).toBe(TIP);
    expect(tip!.only).toBe(1);
    expect(trunk!.only).toBe(0);
    expect(trunk!.shared).toBe(3);
  });

  it('breaks a tie on the last thing said, not the last write', () => {
    const shared = [record(ROOT), record(uuid())];
    const dirs = transcripts({
      [TRUNK]: [META, ...shared, record(uuid(), '2026-08-06T05:12:01.370Z')],
      [TIP]: [META, ...shared, record(uuid(), '2026-08-08T19:30:00.000Z')],
    });

    const later = new Date(Date.now() + 120_000);
    utimesSync(fileOf(dirs, TRUNK), later, later);

    expect(weighBranches([TRUNK, TIP], lineageAt(dirs))[0]!.cliSessionId).toBe(TIP);
  });

  it('leaves out a branch with no transcript rather than ranking it last', () => {
    const dirs = transcripts({ [TRUNK]: [META, record(ROOT), record(uuid())] });
    const weights = weighBranches([TRUNK, TIP], lineageAt(dirs));

    // Ranking an unreadable branch at zero would quietly promote whichever
    // sibling happens to be on disk, which is a different claim entirely.
    expect(weights).toHaveLength(1);
    expect(weights[0]!.cliSessionId).toBe(TRUNK);
  });

  it('ignores bookkeeping records, which carry no uuid', () => {
    const dirs = transcripts({
      [TRUNK]: [META, META, record(ROOT)],
      [TIP]: [META, record(ROOT), record(uuid())],
    });

    expect(weighBranches([TRUNK], lineageAt(dirs))[0]!.total).toBe(1);
  });
});

describe('forksOf', () => {
  it('groups the halves of one fork and leaves everything else out', () => {
    const dirs = transcripts({
      [TRUNK]: [META, record(ROOT), record(uuid())],
      [TIP]: [META, record(ROOT), record(uuid()), record(uuid())],
      [ALONE]: [META, record(uuid())],
    });

    const forks = forksOf([TRUNK, TIP, ALONE], lineageAt(dirs));

    expect(forks.all()).toHaveLength(1);
    const fork = forks.of(TRUNK);
    expect(fork?.root).toBe(ROOT);
    expect(fork?.branches[0]!.cliSessionId).toBe(TIP);
    // Both halves answer with the same fork: the question is about the work, and
    // the work is what the two files have in common.
    expect(forks.of(TIP)).toBe(fork);
    expect(forks.of(ALONE)).toBeUndefined();
  });

  it('reports what a single row would hide', () => {
    const shared = [record(ROOT)];
    const dirs = transcripts({
      [TRUNK]: [META, ...shared, record(uuid()), record(uuid())],
      [TIP]: [META, ...shared, record(uuid()), record(uuid()), record(uuid())],
    });

    // The number the decision turns on: keeping the tip stops the sidebar showing
    // the two records the trunk holds alone. Said out loud, or the command is
    // advertising rather than reporting.
    expect(forksOf([TRUNK, TIP], lineageAt(dirs)).of(TIP)?.lost).toBe(2);
  });

  it('is not a fork when only one branch is on disk', () => {
    const dirs = transcripts({ [TRUNK]: [META, record(ROOT), record(uuid())] });
    expect(forksOf([TRUNK, TIP], lineageAt(dirs)).all()).toHaveLength(0);
  });
});
