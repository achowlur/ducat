import type { RecurringCadence } from '../../types/contracts';

/**
 * Turning one transaction into a tracked subscription.
 *
 * Everything except the cadence is already on the row — the merchant, what it
 * cost, and a date it was billed — so registering asks for the one thing a
 * single charge cannot tell you: how often it repeats.
 *
 * This exists because detection structurally cannot cover everything. It needs
 * three occurrences at a regular cadence, so an annual plan needs three YEARS
 * of history, and a merchant whose descriptor shifts between charges never
 * groups at all. `npm run subs:audit` names the annual case as the one honest
 * gap in the detector; this is the door that closes it.
 */

export interface SubscriptionDraft {
  name: string;
  merchantPattern: string;
  expectedAmount: number;
  cadence: RecurringCadence;
  anchorDate: Date;
}

export interface RegisterInput {
  normalizedMerchant: string;
  description: string;
  /** Signed, as stored: an outflow is negative. */
  amount: number;
  date: Date;
  cadence: RecurringCadence;
}

/**
 * A billing reference that changes every cycle, which the pattern must stop
 * before or it will only ever match the one charge it came from. The same
 * markers `payeeKey` uses, deliberately duplicated rather than shared: this
 * must NOT use `payeeKey` itself, because that also replaces punctuation, and
 * "link.com" becomes "link com" — a string that appears nowhere in its own
 * source. `reconcileSubscription` matches with a raw `.includes()`, so a
 * pattern has to survive as a literal substring.
 */
const REFERENCE_MARKERS = [
  /\bref\s*#/,
  /\bon\s+\d{1,2}\/\d{1,2}/,
  /\b\d{4,}\b/,
];

/**
 * The pattern is a case-insensitive SUBSTRING match against the merchant and
 * the raw description, so it has to stay findable in the text it came from.
 * Truncating at the first reference marker — rather than deleting one
 * mid-string — keeps it a contiguous PREFIX of the original by construction.
 *
 * Whitespace is left exactly as it is. Banks pad descriptions into fixed
 * columns ("ZELLE TO  RECIPIENT"), and `reconcileSubscription` does not
 * collapse either side before comparing, so tidying the pattern here would
 * stop it matching. The merchant it is derived from has already been collapsed
 * by `normalizeMerchant`, which is why deriving from the merchant is safe.
 *
 * A too-SHORT pattern is the other failure: matching is a substring with no
 * word boundary, so "o" would sweep up costco, doordash and every Zelle. Three
 * characters is the same floor the grouped review enforces, for the same reason.
 */
export function draftSubscription(input: RegisterInput): SubscriptionDraft | null {
  const source = input.normalizedMerchant.trim() !== '' ? input.normalizedMerchant : input.description;
  const lower = source.toLowerCase();
  const cut = REFERENCE_MARKERS.reduce((earliest, marker) => {
    const found = marker.exec(lower);
    return found !== null && found.index < earliest ? found.index : earliest;
  }, lower.length);
  const pattern = lower.slice(0, cut).trim();
  if (pattern.length < 3) return null;

  // An outflow is what a subscription is. A positive amount here is either an
  // inflow or a refund, and neither is something you are billed for.
  const expectedAmount = -input.amount;
  if (expectedAmount <= 0) return null;

  return {
    name: source.trim(),
    merchantPattern: pattern,
    expectedAmount: Math.round(expectedAmount * 100) / 100,
    cadence: input.cadence,
    anchorDate: input.date,
  };
}
