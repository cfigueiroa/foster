import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyArchiveSync, planArchiveSync } from '../src/engine/archiveSync.js';
import { planArchiveMarksBack } from '../src/engine/marksBack.js';
import { Ledger } from '../src/ledger/log.js';
import { layoutFor, sessionPath } from '../src/domain/paths.js';
import type {
  AccountRef,
  CodeSessionData,
  DiscoveredSession,
  StoreLayout,
} from '../src/domain/types.js';

/**
 * `foster sweep`'s archive pass: a conversation's archived flag in the target
 * account should follow whichever account was most recently active on it,
 * unless the user changed it here by hand or the row is a mark this same run
 * (or an earlier one) already decided about.
 */

const TARGET: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000a',
  organizationUuid: '00000000-0000-4000-8000-0000000000a0',
};
const OTHER_A: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000b',
  organizationUuid: '00000000-0000-4000-8000-0000000000b0',
};
const OTHER_B: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000c',
  organizationUuid: '00000000-0000-4000-8000-0000000000c0',
};

const CLI_ID = '00000000-0000-4000-8000-00000000001a';

function makeStore(): StoreLayout {
  const root = mkdtempSync(path.join(tmpdir(), 'foster-archivesync-'));
  return layoutFor(root);
}

function card(sessionId: string, overrides: Partial<CodeSessionData> = {}): CodeSessionData {
  return { sessionId, cliSessionId: CLI_ID, title: 'Some work', ...overrides };
}

function writeCard(store: StoreLayout, account: AccountRef, data: CodeSessionData): string {
  const p = sessionPath(store, account, data.sessionId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data));
  return p;
}

function ds(filePath: string, account: AccountRef, data: CodeSessionData): DiscoveredSession {
  return { path: filePath, account, data, isCopy: false, isStranded: false, reasons: [] };
}

function readCard(filePath: string): CodeSessionData {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

describe('planArchiveSync / applyArchiveSync', () => {
  it('a copy follows its source into being archived', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const originPath = writeCard(
      store,
      OTHER_A,
      card('local_origin', { isArchived: true, lastActivityAt: 2_000 }),
    );
    const copyPath = writeCard(
      store,
      TARGET,
      card('local_copy', { isArchived: false, lastActivityAt: 1_000 }),
    );
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_origin',
      origin: OTHER_A,
      target: TARGET,
      copySessionId: 'local_copy',
      copyPath,
      prefix: '',
      cliSessionId: CLI_ID,
    });

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [ds(copyPath, TARGET, card('local_copy', { isArchived: false }))],
      otherCards: [
        ds(originPath, OTHER_A, card('local_origin', { isArchived: true, lastActivityAt: 2_000 })),
      ],
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ from: false, to: true, native: false });

    const outcomes = applyArchiveSync(plan.items, { ledger });
    expect(outcomes[0]!.status).toBe('written');
    expect(readCard(copyPath).isArchived).toBe(true);

    const event = ledger.read().find((e) => e.kind === 'archive_synced');
    expect(event).toMatchObject({
      kind: 'archive_synced',
      sessionId: 'local_copy',
      from: false,
      to: true,
      native: false,
    });
  });

  it('a copy follows its source back into being unarchived, once foster already owns the flag', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const originPath = writeCard(
      store,
      OTHER_A,
      card('local_origin', { isArchived: false, lastActivityAt: 3_000 }),
    );
    const copyPath = writeCard(
      store,
      TARGET,
      card('local_copy', { isArchived: true, lastActivityAt: 1_000 }),
    );
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_origin',
      origin: OTHER_A,
      target: TARGET,
      copySessionId: 'local_copy',
      copyPath,
      prefix: '',
      cliSessionId: CLI_ID,
    });
    // Foster already brought this card to `true` once — this is the
    // "established" path, not the untouched-since heuristic.
    ledger.append({
      kind: 'archive_synced',
      sessionId: 'local_copy',
      target: TARGET,
      path: copyPath,
      from: false,
      to: true,
      native: false,
    });

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [ds(copyPath, TARGET, card('local_copy', { isArchived: true }))],
      otherCards: [
        ds(originPath, OTHER_A, card('local_origin', { isArchived: false, lastActivityAt: 3_000 })),
      ],
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ from: true, to: false, because: 'copy-follows-source' });
  });

  it('leaves a card alone once its flag disagrees with the value foster itself last set — a person changed it', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const originPath = writeCard(
      store,
      OTHER_A,
      card('local_origin', { isArchived: true, lastActivityAt: 3_000 }),
    );
    const copyPath = writeCard(
      store,
      TARGET,
      // The user unarchived this by hand, disagreeing with foster's own last
      // write (`to: true` below).
      card('local_copy', { isArchived: false, lastActivityAt: 1_000 }),
    );
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_origin',
      origin: OTHER_A,
      target: TARGET,
      copySessionId: 'local_copy',
      copyPath,
      prefix: '',
      cliSessionId: CLI_ID,
    });
    ledger.append({
      kind: 'archive_synced',
      sessionId: 'local_copy',
      target: TARGET,
      path: copyPath,
      from: false,
      to: true,
      native: false,
    });

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [ds(copyPath, TARGET, card('local_copy', { isArchived: false }))],
      otherCards: [
        ds(originPath, OTHER_A, card('local_origin', { isArchived: true, lastActivityAt: 3_000 })),
      ],
    });

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ sessionId: 'local_copy', reason: 'changed-by-hand' });
  });

  it('never touches a row wearing a mark from the branch or second-file pass', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const originPath = writeCard(
      store,
      OTHER_A,
      card('local_origin', { isArchived: true, lastActivityAt: 3_000 }),
    );
    const copyPath = writeCard(
      store,
      TARGET,
      card('local_copy', { isArchived: false, lastActivityAt: 1_000 }),
    );
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_origin',
      origin: OTHER_A,
      target: TARGET,
      copySessionId: 'local_copy',
      copyPath,
      prefix: '',
      cliSessionId: CLI_ID,
    });

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [ds(copyPath, TARGET, card('local_copy', { isArchived: false }))],
      otherCards: [
        ds(originPath, OTHER_A, card('local_origin', { isArchived: true, lastActivityAt: 3_000 })),
      ],
      markedThisRound: new Set(['local_copy']),
    });

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ sessionId: 'local_copy', reason: 'marked' });
  });

  it('brings a native card into step only when it is older than the account that moved on', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const sourcePath = writeCard(
      store,
      OTHER_A,
      card('local_source', { isArchived: true, lastActivityAt: 5_000 }),
    );

    // Case A: the native card here is older than the source that archived it
    // — following is safe, nothing of this account's own was overwritten.
    const olderPath = writeCard(
      store,
      TARGET,
      card('local_native_older', { isArchived: false, lastActivityAt: 1_000 }),
    );
    const olderPlan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [
        ds(
          olderPath,
          TARGET,
          card('local_native_older', { isArchived: false, lastActivityAt: 1_000 }),
        ),
      ],
      otherCards: [
        ds(sourcePath, OTHER_A, card('local_source', { isArchived: true, lastActivityAt: 5_000 })),
      ],
    });
    expect(olderPlan.items).toHaveLength(1);
    expect(olderPlan.items[0]).toMatchObject({
      from: false,
      to: true,
      native: true,
      because: 'native-follows-newer-source',
    });

    // Case B: same conversation, different id sharing the cliSessionId, but
    // this native card is itself the more recent one — never touched, since
    // touching it could overwrite the user's own newer work.
    const newerPath = writeCard(
      store,
      TARGET,
      card('local_native_newer', { isArchived: false, lastActivityAt: 9_000 }),
    );
    const newerPlan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [
        ds(
          newerPath,
          TARGET,
          card('local_native_newer', { isArchived: false, lastActivityAt: 9_000 }),
        ),
      ],
      otherCards: [
        ds(sourcePath, OTHER_A, card('local_source', { isArchived: true, lastActivityAt: 5_000 })),
      ],
    });
    expect(newerPlan.items).toHaveLength(0);
    expect(newerPlan.skipped).toContainEqual({
      sessionId: 'local_native_newer',
      reason: 'native-left-alone',
    });
  });

  it('picks the most recently active source among several other accounts', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const olderPath = writeCard(
      store,
      OTHER_A,
      card('local_a', { isArchived: true, lastActivityAt: 1_000 }),
    );
    const newerPath = writeCard(
      store,
      OTHER_B,
      card('local_b', { isArchived: false, lastActivityAt: 9_000 }),
    );
    const targetPath = writeCard(
      store,
      TARGET,
      card('local_native', { isArchived: true, lastActivityAt: 500 }),
    );

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [
        ds(targetPath, TARGET, card('local_native', { isArchived: true, lastActivityAt: 500 })),
      ],
      otherCards: [
        ds(olderPath, OTHER_A, card('local_a', { isArchived: true, lastActivityAt: 1_000 })),
        ds(newerPath, OTHER_B, card('local_b', { isArchived: false, lastActivityAt: 9_000 })),
      ],
    });

    // The newer, unarchived account wins over the older, archived one.
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ from: true, to: false, sourceSessionId: 'local_b' });
  });
});

describe('planArchiveMarksBack', () => {
  it('writes an archive_synced write again once the running app has saved the card back over it', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const cardPath = writeCard(store, TARGET, card('local_copy', { isArchived: false }));
    ledger.append({
      kind: 'archive_synced',
      sessionId: 'local_copy',
      target: TARGET,
      path: cardPath,
      from: false,
      to: true,
      native: false,
    });
    // The app saved the card back over foster's write — back to `from`.
    writeFileSync(cardPath, JSON.stringify(card('local_copy', { isArchived: false })));

    const items = planArchiveMarksBack(ledger.read(), TARGET, store);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: 'local_copy', from: false, to: true });

    const outcomes = applyArchiveSync(items, { ledger });
    expect(outcomes[0]!.status).toBe('written');
    expect(readCard(cardPath).isArchived).toBe(true);
  });

  it('does nothing once the card already shows the write it made', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const cardPath = writeCard(store, TARGET, card('local_copy', { isArchived: true }));
    ledger.append({
      kind: 'archive_synced',
      sessionId: 'local_copy',
      target: TARGET,
      path: cardPath,
      from: false,
      to: true,
      native: false,
    });

    const items = planArchiveMarksBack(ledger.read(), TARGET, store);
    expect(items).toHaveLength(0);
  });
});
