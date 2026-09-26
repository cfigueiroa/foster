import { describe, expect, it } from 'vitest';
import type { Outcome } from '../src/engine/executor.js';
import type { RetitleOutcome } from '../src/engine/retitle.js';
import { mergeRounds, type Round } from '../src/ops/sweep.js';

/**
 * A sweep that finds work its own writes made takes another round in the same
 * run, and reports both as one. Every pass lists what it left alone as well as
 * what it did, so a naive join would print each candidate twice.
 */

function outcome(originSessionId: string, status: Outcome['status']): Outcome {
  return { originSessionId, title: originSessionId, status } as Outcome;
}

function retitled(path: string, status: RetitleOutcome['status']): RetitleOutcome {
  return { path, sessionId: path, from: 'a', to: 'b', status, as: 'other-file' };
}

function round(parts: {
  fostered?: Outcome[];
  forks?: Round['passes']['branches']['forks'];
  plans?: Round['files']['plans'];
  fileRetitled?: RetitleOutcome[];
}): Round {
  return {
    passes: {
      fostered: parts.fostered ?? [],
      branches: { forks: parts.forks ?? [], outcomes: [], retitled: [], archived: 0 },
      restored: [],
    },
    files: { plans: parts.plans ?? [], retitled: parts.fileRetitled ?? [], archived: 0 },
    worktreeClaims: { items: [], outcomes: [], counts: { released: 0, skipped: 0, failed: 0 } },
    archiveSync: {
      items: [],
      skipped: [],
      outcomes: [],
      counts: { written: 0, skipped: 0, failed: 0 },
    },
  };
}

describe('mergeRounds', () => {
  it('lists a candidate once: skipped in both rounds, or brought by the later one', () => {
    const merged = mergeRounds(
      round({
        fostered: [outcome('a', 'fostered'), outcome('b', 'skipped'), outcome('c', 'skipped')],
      }),
      round({
        fostered: [outcome('a', 'skipped'), outcome('b', 'fostered'), outcome('c', 'skipped')],
      }),
    );
    expect(merged.passes.fostered.map((o) => `${o.originSessionId}:${o.status}`)).toEqual([
      'a:fostered',
      'c:skipped',
      'b:fostered',
    ]);
  });

  it('counts a candidate that failed in every round once', () => {
    const merged = mergeRounds(
      round({ fostered: [outcome('a', 'failed')] }),
      round({ fostered: [outcome('a', 'failed')] }),
    );
    expect(merged.passes.fostered.map((o) => `${o.originSessionId}:${o.status}`)).toEqual([
      'a:failed',
    ]);
  });

  it('keeps one entry per fork, with both rounds’ writes and the later reading of it', () => {
    const fork = (retitle: RetitleOutcome[], tipCard?: { sessionId: string; title: string }) => ({
      root: 'root-1',
      tip: 'tip',
      rows: [],
      brought: [],
      retitled: retitle,
      skipped: [],
      ...(tipCard ? { tipCard } : {}),
    });
    const merged = mergeRounds(
      round({ forks: [fork([retitled('x', 'retitled')], { sessionId: 's', title: 'T' })] }),
      round({ forks: [fork([retitled('x', 'skipped'), retitled('y', 'retitled')])] }),
    );
    expect(merged.passes.branches.forks).toHaveLength(1);
    expect(merged.passes.branches.forks[0]!.retitled.map((o) => o.path)).toEqual(['x', 'y']);
    expect(merged.passes.branches.forks[0]!.tipCard).toEqual({ sessionId: 's', title: 'T' });
  });

  it('keeps one plan per twice-shown conversation, naming every row either round marked', () => {
    const plan = (paths: string[]) => ({
      cliSessionId: 'conv',
      working: { sessionId: 'w', title: 'W' },
      rows: [],
      retitle: paths.map((path) => ({
        path,
        target: { accountUuid: 'a', organizationUuid: 'o' },
        native: true,
        title: 't',
        as: 'other-file' as const,
      })),
      skipped: [],
    });
    const merged = mergeRounds(
      round({ plans: [plan(['p1'])], fileRetitled: [retitled('p1', 'retitled')] }),
      round({ plans: [plan(['p2'])], fileRetitled: [retitled('p2', 'retitled')] }),
    );
    expect(merged.files.plans).toHaveLength(1);
    expect(merged.files.plans[0]!.retitle.map((r) => r.path)).toEqual(['p1', 'p2']);
    expect(merged.files.retitled.map((o) => o.path)).toEqual(['p1', 'p2']);
  });
});
