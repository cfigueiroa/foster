import { forLedger, type AccountProfile } from './profile.js';

/**
 * What is known about an account, regardless of who last said it.
 *
 * The cache, the ledger and the screens used to each invent a bag with the same
 * four fields. One shape means a merge is a merge, not a translation.
 */
export interface AccountSighting {
  email?: string;
  name?: string;
  plan?: string;
  profile?: AccountProfile;
}

/**
 * A sighting as the ledger will actually keep it — its profile stripped of the
 * card, the way `forLedger` strips one (`profile.ts`). Every caller that both
 * decides whether a sighting is worth writing (`store/identity.ts`'s
 * `worthRecording`) and then writes it must use this for *both* steps: a card
 * present in a fresh read but never recorded would otherwise look like a
 * change on every single run, once the write itself started leaving it out.
 */
export function forLedgerSighting<T extends AccountSighting>(sighting: T): T {
  return sighting.profile ? { ...sighting, profile: forLedger(sighting.profile) } : sighting;
}

/** A sighting the ledger has folded, dated. */
export type KnownIdentity = AccountSighting & {
  /** When any part of this was last confirmed. */
  seenAt: number;
};

/** The identity to show: fresh cache, remembered ledger, or both. */
export type ResolvedIdentity = AccountSighting & {
  /** True when nothing was in the cache and every part came from the ledger. */
  remembered?: boolean;
  /** When the remembered part was last confirmed, for anything not read fresh. */
  seenAt?: number;
};
