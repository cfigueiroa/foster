import { resolveLabelArgs } from '../engine/account.js';
import type { Ledger } from '../ledger/log.js';

/**
 * Record a name against the account the arguments name.
 *
 * Resolves a unique prefix the same way `--from` does, so `foster label abcd
 * "work"` and the agent's `label_account` cannot file the name under the
 * prefix itself.
 */
export function applyLabel(
  ledger: Ledger,
  first: string | undefined,
  second: string | undefined,
  accountUuids: string[],
  currentAccountUuid: string | undefined,
): { accountUuid: string; label: string } {
  const resolved = resolveLabelArgs(first, second, accountUuids, currentAccountUuid);
  if (!resolved.label.trim()) {
    throw new Error('The label must not be empty.');
  }
  const label = resolved.label.trim();
  ledger.append({ kind: 'account_labelled', accountUuid: resolved.accountUuid, label });
  return { accountUuid: resolved.accountUuid, label };
}
