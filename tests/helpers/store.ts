import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { layoutFor } from '../../src/domain/paths.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../../src/domain/types.js';

/**
 * Deliberately fake identifiers. Tests must never contain values that could be
 * mistaken for a real account; CI fails the build on realistic-looking UUIDs.
 */
export const OLD_ACCOUNT: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-000000000001',
  organizationUuid: '00000000-0000-4000-8000-000000000002',
};

export const NEW_ACCOUNT: AccountRef = {
  accountUuid: '11111111-1111-4111-8111-111111111111',
  organizationUuid: '11111111-1111-4111-8111-111111111112',
};

/** Creates an isolated store in a temp dir. Never touches a real Claude install. */
export function makeStore(): StoreLayout {
  const root = mkdtempSync(path.join(tmpdir(), 'foster-test-'));
  const store = layoutFor(root);
  mkdirSync(store.codeSessionsDir, { recursive: true });
  return store;
}

/**
 * Builds a session fixture. `sessionId` may be given bare; the `local_` prefix the
 * app uses is applied here so overrides cannot accidentally produce a filename the
 * scanner ignores.
 */
export function session(overrides: Partial<CodeSessionData> = {}): CodeSessionData {
  const { sessionId, ...rest } = overrides;
  const bare = sessionId ?? '00000000-0000-4000-8000-00000000000a';
  return {
    // Derived from the session id rather than fixed, because two sessions
    // sharing a conversation is a real state with real consequences — the
    // destination refuses a conversation it already shows — and a fixture that
    // gave every session the same conversation made that state the default.
    cliSessionId: bare.replace(/^local_/, ''),
    cwd: '/workspace/project',
    originCwd: '/workspace/project',
    title: 'Sample session',
    titleSource: 'auto',
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_100_000,
    lastFocusedAt: 1_700_000_200_000,
    model: 'claude-sonnet-5',
    isArchived: false,
    completedTurns: 3,
    ...rest,
    sessionId: bare.startsWith('local_') ? bare : `local_${bare}`,
  };
}

export function writeSession(
  store: StoreLayout,
  account: AccountRef,
  data: CodeSessionData,
): string {
  const dir = path.join(store.codeSessionsDir, account.accountUuid, account.organizationUuid);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${data.sessionId}.json`);
  writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}
