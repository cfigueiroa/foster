import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveredSession } from '../src/domain/types.js';
import { measureNeverOpened } from '../src/ops/foster.js';
import { OLD_ACCOUNT, session } from './helpers/store.js';

/**
 * `never-opened` is decided by a missing focus time and nothing else, and two
 * very different things satisfy it: a record nobody ever opened, and a
 * conversation that ran its whole life outside the app. Reported as one number
 * they are indistinguishable, and the second one is work.
 *
 * This is not hypothetical. On a real store, five sessions were counted under
 * "can never come"; four were empty automation runs and the fifth held a
 * finished piece of work that had no card anywhere. Nothing in the output said
 * which was which.
 */

const WITH_WORK = '00000000-0000-4000-8000-0000000000d1';
const EMPTY = '00000000-0000-4000-8000-0000000000d2';

let configDir: string;
let env: NodeJS.ProcessEnv;

function transcript(cliSessionId: string, lines: number) {
  const dir = path.join(configDir, 'projects', 'C--work-project');
  mkdirSync(dir, { recursive: true });
  const records = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({ type: 'user', message: { content: `turn ${i}` } }),
  );
  writeFileSync(path.join(dir, `${cliSessionId}.jsonl`), records.join('\n'), 'utf8');
}

function neverOpened(cliSessionId: string): DiscoveredSession {
  const data = session({ sessionId: cliSessionId });
  delete data.lastFocusedAt;
  return {
    path: path.join(configDir, `${cliSessionId}.json`),
    account: OLD_ACCOUNT,
    data,
    isCopy: false,
    isStranded: false,
    reasons: ['never-opened'],
  };
}

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-nop-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
});

describe('measuring what is behind a never-opened session', () => {
  it('reports the bytes of a conversation that ran outside the app', () => {
    transcript(WITH_WORK, 40);

    const [measured] = measureNeverOpened([neverOpened(WITH_WORK)], env);
    expect(measured!.transcriptBytes).toBeGreaterThan(0);
  });

  /**
   * Zero, not undefined. "Measured, and there is nothing there" is the answer
   * that lets a caller drop the session without wondering; leaving it unset
   * would be indistinguishable from never having asked.
   */
  it('reports zero for a record with no conversation on disk', () => {
    const [measured] = measureNeverOpened([neverOpened(EMPTY)], env);
    expect(measured!.transcriptBytes).toBe(0);
  });

  it('separates the two, which is the whole point', () => {
    transcript(WITH_WORK, 40);

    const measured = measureNeverOpened([neverOpened(WITH_WORK), neverOpened(EMPTY)], env);
    const bytes = measured.map((s) => s.transcriptBytes);
    expect(bytes[0]).toBeGreaterThan(0);
    expect(bytes[1]).toBe(0);
  });

  /**
   * Answering costs an index of every transcript directory on the machine, so it
   * is asked only of the sessions the question is about.
   */
  it('leaves a session that is not held back unmeasured', () => {
    const ordinary: DiscoveredSession = { ...neverOpened(WITH_WORK), reasons: [] };
    const [measured] = measureNeverOpened([ordinary], env);
    expect(measured!.transcriptBytes).toBeUndefined();
  });

  it('does not index anything when there is nothing to measure', () => {
    const ordinary: DiscoveredSession = { ...neverOpened(WITH_WORK), reasons: ['archived'] };
    const input = [ordinary];
    expect(measureNeverOpened(input, env)).toBe(input);
  });
});
