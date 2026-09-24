import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountDir } from '../src/domain/paths.js';
import type { StoreLayout } from '../src/domain/types.js';
import { Ledger } from '../src/ledger/log.js';
import { openFosterCache, type FosterCache } from '../src/store/cache/index.js';
import { runSweep, type SweepReport } from '../src/ops/sweep.js';
import { makeStore, NEW_ACCOUNT, OLD_ACCOUNT, session, writeSession } from './helpers/store.js';

/**
 * The proof the package exists for: a dry-run sweep must answer exactly the
 * same thing whether it is reading cold, reading a cache it just built itself,
 * or reading one it reloaded from disk. Nothing here writes to the store — a
 * dry run — so the same fixture can be swept three times over and any
 * difference in the report is the cache, not a change on disk.
 */

const ROOT = '00000000-0000-4000-8000-0000000000f0';
const ORIGINAL_CLI = '00000000-0000-4000-8000-0000000000f1';
const BRANCH_CLI = '00000000-0000-4000-8000-0000000000f2';
const ARCHIVED = '00000000-0000-4000-8000-0000000000f3';

let store: StoreLayout;
let ledger: Ledger;
let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  store = makeStore();
  ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-sweepcache-')), 'l.jsonl'));
  configDir = mkdtempSync(path.join(tmpdir(), 'foster-sweepcache-cfg-'));
  env = { CLAUDE_CONFIG_DIR: configDir };
  writeFileSync(
    store.configFile,
    JSON.stringify({ lastKnownAccountUuid: NEW_ACCOUNT.accountUuid }),
    'utf8',
  );
  mkdirSync(accountDir(store, NEW_ACCOUNT), { recursive: true });
  mkdirSync(accountDir(store, OLD_ACCOUNT), { recursive: true });
});

function record(uuid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { uuid, type: 'user', timestamp: '2026-09-24T05:12:01.370Z', ...extra };
}

function transcript(cliSessionId: string, records: Record<string, unknown>[]): void {
  const dir = path.join(configDir, 'projects', '-workspace-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${cliSessionId}.jsonl`),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
}

function buildFixture(): void {
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: ARCHIVED, title: 'Tucked away', isArchived: true }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: ORIGINAL_CLI, title: 'Original', cliSessionId: ORIGINAL_CLI }),
  );
  writeSession(
    store,
    OLD_ACCOUNT,
    session({ sessionId: BRANCH_CLI, title: 'Branch', cliSessionId: BRANCH_CLI }),
  );

  // A fork: both transcripts share ROOT, the original got one more record
  // after the split and the branch got two — the branch carried on.
  transcript(ORIGINAL_CLI, [record(ROOT), record('00000000-0000-4000-8000-0000000000f4')]);
  transcript(BRANCH_CLI, [
    record(ROOT),
    record('00000000-0000-4000-8000-0000000000f5'),
    record('00000000-0000-4000-8000-0000000000f6'),
  ]);
}

/** A fresh cache, rooted at its own temp `FOSTER_HOME`, never the real one. */
function newCache(home: string): FosterCache {
  const cache = openFosterCache({ FOSTER_HOME: home }, false);
  if (!cache) throw new Error('expected a cache');
  return cache;
}

function runDry(cache: FosterCache | undefined): SweepReport {
  return runSweep({
    store,
    ledger,
    target: NEW_ACCOUNT,
    dryRun: true,
    env,
    configDirs: [],
    projectsDirs: [path.join(configDir, 'projects')],
    cache,
  });
}

/**
 * A dry-run sweep mints a fresh random id for every copy it previews, on every
 * call, cache or no cache — the one intentional source of non-determinism in
 * an otherwise repeatable report. This maps each generated `local_<uuid>` to a
 * stable placeholder, in order of first appearance, so two reports that agree
 * on everything but those ids compare equal; a fixture's own, known ids are
 * left untouched, since they are not what varies.
 */
const KNOWN_IDS = new Set([ROOT, ORIGINAL_CLI, BRANCH_CLI, ARCHIVED]);

function canonicalize(report: SweepReport): unknown {
  const seen = new Map<string, string>();
  let counter = 0;
  const text = JSON.stringify(report).replace(
    /local_([0-9a-fA-F-]{36})/g,
    (match: string, uuid: string) => {
      if (KNOWN_IDS.has(uuid)) return match;
      let placeholder = seen.get(uuid);
      if (!placeholder) {
        counter += 1;
        placeholder = `local_GENERATED-${counter}`;
        seen.set(uuid, placeholder);
      }
      return placeholder;
    },
  );
  return JSON.parse(text);
}

describe('persistent cache: identical output cold, warm and disabled', () => {
  it('a dry-run sweep answers the same with no cache, a cold cache and a warm reload', () => {
    buildFixture();

    const withoutCache = runDry(undefined);

    const home = mkdtempSync(path.join(tmpdir(), 'foster-sweepcache-home-'));
    const cold = newCache(home);
    const withCold = runDry(cold);
    cold.save();

    // A second, unrelated instance pointed at the same files: nothing here was
    // kept in memory between the two runs, only what made it to disk.
    const warm = newCache(home);
    const withWarm = runDry(warm);

    expect(canonicalize(withCold)).toEqual(canonicalize(withoutCache));
    expect(canonicalize(withWarm)).toEqual(canonicalize(withoutCache));
  });

  it('reusing the same in-memory cache across two runs still answers identically', () => {
    buildFixture();
    const home = mkdtempSync(path.join(tmpdir(), 'foster-sweepcache-home2-'));
    const cache = newCache(home);

    const first = runDry(cache);
    const second = runDry(cache);
    expect(canonicalize(second)).toEqual(canonicalize(first));
  });
});
