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

  it('never follows a source row a sweep marked and filed away in another account', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    // In OTHER_A the second-file pass marked and archived one row of the
    // conversation; it was clicked later, so it is the most recently active.
    const markedPath = writeCard(
      store,
      OTHER_A,
      card('local_marked', {
        title: '(other file, stopped 01/09 10:00) Some work',
        isArchived: true,
        lastActivityAt: 3_000,
      }),
    );
    const cleanPath = writeCard(
      store,
      TARGET,
      card('local_clean', { isArchived: false, lastActivityAt: 1_000 }),
    );

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [ds(cleanPath, TARGET, card('local_clean', { lastActivityAt: 1_000 }))],
      otherCards: [
        ds(
          markedPath,
          OTHER_A,
          card('local_marked', {
            title: '(other file, stopped 01/09 10:00) Some work',
            isArchived: true,
            lastActivityAt: 3_000,
          }),
        ),
      ],
    });

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'local_clean', reason: 'no-source' }]);
  });

  it('never unarchives a row with a pull request while the app re-archives those on its own', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));
    const pr = [{ prNumber: 1, repo: 'acme/widgets', url: 'https://example.invalid/pr/1' }];
    const hereData = card('local_copy', {
      isArchived: true,
      lastActivityAt: 1_000,
      prs: pr,
    } as never);
    const copyPath = writeCard(store, TARGET, hereData);
    const sourceData = card('local_origin', { isArchived: false, lastActivityAt: 3_000 });
    const originPath = writeCard(store, OTHER_A, sourceData);

    const options = {
      target: TARGET,
      targetCards: [ds(copyPath, TARGET, hereData)],
      otherCards: [ds(originPath, OTHER_A, sourceData)],
    };
    expect(planArchiveSync(ledger, { ...options, appArchivesOnPrClose: true }).skipped).toEqual([
      { sessionId: 'local_copy', reason: 'app-archives' },
    ]);
    // With the app's rule off, the row follows its source as before.
    expect(planArchiveSync(ledger, options).items).toHaveLength(1);
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
      reason: 'used-here-last',
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

  // The house's own archive ritual archives a session in the account it ran
  // in — which gives that account the higher activity — and leaves every
  // other account's card on the same conversation unarchived and, because
  // nothing has touched it since, older. A recency-blind "does foster own
  // this flag" check would still let that older, untouched card undo the
  // archive the moment a sweep next ran into the account holding it.
  it('never undoes an on-purpose archive with an older, untouched, unarchived card elsewhere', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    // The account the ritual archived it in: higher activity, unarchived here
    // (the source in this test — this pass is asked from the OTHER side).
    const sourcePath = writeCard(
      store,
      OTHER_A,
      card('local_source', { isArchived: false, lastActivityAt: 1_000 }),
    );
    // The target: archived on purpose, and more recently active than the
    // untouched source — following the source here would undo the archive.
    const targetPath = writeCard(
      store,
      TARGET,
      card('local_copy', { isArchived: true, lastActivityAt: 9_000 }),
    );
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_source',
      origin: OTHER_A,
      target: TARGET,
      copySessionId: 'local_copy',
      copyPath: targetPath,
      prefix: '',
      cliSessionId: CLI_ID,
    });

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [
        ds(targetPath, TARGET, card('local_copy', { isArchived: true, lastActivityAt: 9_000 })),
      ],
      otherCards: [
        ds(sourcePath, OTHER_A, card('local_source', { isArchived: false, lastActivityAt: 1_000 })),
      ],
    });

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ sessionId: 'local_copy', reason: 'used-here-last' });
  });

  // The positive twin of the case above: once the source really has moved on
  // — more recently active than the row here, and now archived — following
  // it is exactly right, whether or not any ledger record exists yet.
  it('still follows a source that is genuinely more recently active and now archived', () => {
    const store = makeStore();
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));

    const sourcePath = writeCard(
      store,
      OTHER_A,
      card('local_source', { isArchived: true, lastActivityAt: 9_000 }),
    );
    const targetPath = writeCard(
      store,
      TARGET,
      card('local_copy', { isArchived: false, lastActivityAt: 1_000 }),
    );
    ledger.append({
      kind: 'fostered',
      originSessionId: 'local_source',
      origin: OTHER_A,
      target: TARGET,
      copySessionId: 'local_copy',
      copyPath: targetPath,
      prefix: '',
      cliSessionId: CLI_ID,
    });

    const plan = planArchiveSync(ledger, {
      target: TARGET,
      targetCards: [
        ds(targetPath, TARGET, card('local_copy', { isArchived: false, lastActivityAt: 1_000 })),
      ],
      otherCards: [
        ds(sourcePath, OTHER_A, card('local_source', { isArchived: true, lastActivityAt: 9_000 })),
      ],
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      from: false,
      to: true,
      because: 'copy-follows-source',
    });
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

  it('leaves alone a flip back made long after the write: somebody changed it by hand', () => {
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
    const writtenAt = ledger.read().at(-1)!.ts;
    // Unarchived by hand two hours after foster archived it.
    const handFlip = writtenAt + 2 * 60 * 60 * 1000;

    const items = planArchiveMarksBack(ledger.read(), TARGET, store, undefined, () => handFlip);
    expect(items).toHaveLength(0);
  });

  it('does not repeat an unarchive the app takes back for a row with a pull request', () => {
    const store = makeStore();
    writeFileSync(
      store.desktopConfigFile,
      JSON.stringify({ preferences: { ccAutoArchiveOnPrClose: true } }),
    );
    const ledger = new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-al-')), 'l.jsonl'));
    const pr = [{ prNumber: 1, repo: 'acme/widgets', url: 'https://example.invalid/pr/1' }];
    const cardPath = writeCard(
      store,
      TARGET,
      card('local_copy', { isArchived: true, prs: pr } as never),
    );
    ledger.append({
      kind: 'archive_synced',
      sessionId: 'local_copy',
      target: TARGET,
      path: cardPath,
      from: true,
      to: false,
      native: false,
    });

    expect(planArchiveMarksBack(ledger.read(), TARGET, store)).toHaveLength(0);
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
