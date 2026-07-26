import { P2P_PATTERN } from './rules';

/**
 * Groups the uncategorized backlog by payee so one decision resolves every
 * occurrence instead of one-transaction-at-a-time. A few hundred transactions
 * are typically only a few dozen distinct payees, and the distribution is
 * heavily skewed — clearing the top handful clears most of the queue.
 *
 * Two grouping keys, because the right identity differs by payee type:
 *  - Normal merchants group on `normalizedMerchant` ("cold stone creamery"),
 *    and the resulting rule matches MERCHANT.
 *  - P2P rails group on a payee key derived from the description, because the
 *    rail itself is meaningless — every Zelle payment normalizes to "zelle
 *    transfer", but "ZELLE TO LENA" and "ZELLE TO HOLLIS AMARI" are different
 *    people who deserve different categories. Those rules match DESCRIPTION.
 */
/**
 * Sentinel used by the bulk-review UI in place of a category id, meaning
 * "this payee is a TRANSFER" (excluded from spending, carries no category).
 * Category ids are cuids, so this can never collide with one.
 */
export const TRANSFER_TARGET = "__transfer__";

export interface GroupTxn {
  id: string;
  amount: number;
  description: string;
  normalizedMerchant: string;
  flow: string;
}

export interface PayeeGroup {
  /** Group identity; also the rule's matchValue. */
  key: string;
  matchField: 'MERCHANT' | 'DESCRIPTION';
  isP2P: boolean;
  count: number;
  /** Summed magnitude across the group. */
  total: number;
  transactionIds: string[];
  /** Distinct raw descriptions, for disambiguating what a group actually is. */
  samples: string[];
  /** Dominant flow, or 'MIXED'. */
  flow: string;
}

/**
 * Reduces a P2P description to the counterparty by TRUNCATING at the first
 * reference marker, embedded date, or long digit run — everything after those
 * is per-payment noise that would otherwise make each payment to the same
 * person look unique.
 *
 *   "ZELLE TO  LENA ON 07/21 REF # WFCT0000000E" -> "zelle to lena"
 *   "VENMO   PAYMENT   260704 1000000000003   MARLOWE" -> "venmo payment"
 *
 * Truncating rather than deleting-and-rejoining is load-bearing: the key
 * becomes a rule's CONTAINS value, matched against the description itself. Cut
 * the noise out of the MIDDLE and the key stops being a contiguous substring,
 * so the rule silently matches nothing — which is exactly what happened to
 * Venmo, whose reference numbers sit between the verb and the name.
 */
const NOISE_MARKERS = [
  /\bref\s*#/, // "REF # WFCT0000000E"
  /\bon\s+\d{1,2}\/\d{1,2}/, // "ON 07/21"
  /\b\d{4,}\b/, // confirmation and account numbers
];

export function payeeKey(description: string): string {
  const lower = description.toLowerCase();
  const cut = NOISE_MARKERS.reduce((earliest, marker) => {
    const found = marker.exec(lower);
    return found !== null && found.index < earliest ? found.index : earliest;
  }, lower.length);
  return lower
    .slice(0, cut)
    .replace(/[^a-z0-9\s&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function groupByPayee(txns: GroupTxn[]): PayeeGroup[] {
  const groups = new Map<string, PayeeGroup>();

  for (const t of txns) {
    const isP2P = P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description);
    const key = isP2P
      ? payeeKey(t.description)
      : t.normalizedMerchant !== ''
        ? t.normalizedMerchant
        : payeeKey(t.description);
    if (key === '') continue;

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        matchField: isP2P ? 'DESCRIPTION' : 'MERCHANT',
        isP2P,
        count: 1,
        total: Math.abs(t.amount),
        transactionIds: [t.id],
        samples: [t.description],
        flow: t.flow,
      });
      continue;
    }
    existing.count += 1;
    existing.total += Math.abs(t.amount);
    existing.transactionIds.push(t.id);
    if (existing.samples.length < 3 && !existing.samples.includes(t.description)) {
      existing.samples.push(t.description);
    }
    if (existing.flow !== t.flow) existing.flow = 'MIXED';
  }

  // Highest-leverage first: most transactions resolved per decision.
  return [...groups.values()].sort((a, b) => b.count - a.count || b.total - a.total);
}
