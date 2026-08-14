/**
 * The account's profile, as the app's own API recorded it.
 *
 * Lives in domain so the ledger can remember a sighting without importing the
 * store reader that found it.
 */
export interface AccountProfile {
  accountUuid: string;
  email?: string;
  name?: string;
  displayName?: string;
  /** When the account itself was created, as the API reports it. */
  createdAt?: string;
  organizationUuid?: string;
  organizationName?: string;
  /** The organization's own word for its type — "claude_max", "claude_pro". */
  organizationType?: string;
  /**
   * The raw tier, kept verbatim beside the friendly name because it carries what
   * the friendly name throws away: `default_claude_max_20x` is a different
   * subscription from `default_claude_max_5x`, and "Max" cannot say which.
   */
  rateLimitTier?: string;
  billingType?: string;
  /** "active", "canceled", "past_due" — the API's word, not an interpretation. */
  subscriptionStatus?: string;
  /** When the subscription began. For a subscription in its first period this is also when it was first charged. */
  subscriptionCreatedAt?: string;
  hasExtraUsage?: boolean;
  /** Set when a charge is waiting on the cardholder to authorise it. */
  paymentNeedsAuth?: boolean;
  /* The fields below come from the billing endpoint, which the app does not
     always leave in the cache — present when it has, absent when it has not. */
  /** The date the subscription renews, when the billing endpoint's answer was cached. */
  nextChargeDate?: string;
  /** Set when the plan is scheduled to end — the difference between "active" and "active but cancelling". */
  planEndingAt?: string;
  billingInterval?: string;
  currency?: string;
  cardBrand?: string;
  cardLast4?: string;
}
