import type { AccountProfile } from './profile.js';

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
