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
 *    transfer", while two different recipients on it deserve two different
 *    categories. Those rules match DESCRIPTION.
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
 *   "ZELLE TO  RECIPIENT ON 07/21 REF # WFCT0000000A" -> "zelle to recipient"
 *   "VENMO   PAYMENT   260704 1000000000001   NAME" -> "venmo payment"
 *
 * Truncating rather than deleting-and-rejoining is load-bearing: the key
 * becomes a rule's CONTAINS value, matched against the description itself. Cut
 * the noise out of the MIDDLE and the key stops being a contiguous substring,
 * so the rule silently matches nothing — which is exactly what happened to
 * Venmo, whose reference numbers sit between the verb and the name.
 */
const NOISE_MARKERS = [
  /\bref\s*#/, // "REF # WFCT0000000A"
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

/**
 * The rail and its direction words, which carry no information about WHO.
 * Measured against what remains, because a length check on the whole payee is
 * a floor in name only: "ZELLE 12345678" keys to "zelle", five characters that
 * pass any such test and match every P2P payment in the database.
 */
export const RAIL_WORDS = /\b(to|from|payment|transfer|pmt)\b/g;

/** Shorter than this matches half the ledger, as a rule value or a name. */
export const MIN_PAYEE_NAME = 3;

/** What a P2P string names beyond its rail: "zelle to lena" is "lena", "zelle transfer" nothing. */
export function beyondRail(s: string): string {
  return s.replace(P2P_PATTERN, ' ').replace(RAIL_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a P2P row keys on the counterparty in its DESCRIPTION or, as any
 * purchase does, on its merchant. The description wins unless its key never
 * reaches the rail while the merchant names more than the rail. A card-network
 * payment ("Purchase authorized on 11/19 Venmo* VISA Direct NY ...") cuts at
 * its date to "purchase authorized": the bank's bookkeeping, naming neither the
 * rail nor anyone on it, and as a DESCRIPTION rule it matches every card
 * purchase on the account. Its merchant ("venmo* visa direct ny") is the payee.
 */
export function keysOnDescription(t: { normalizedMerchant: string; description: string }): boolean {
  return P2P_PATTERN.test(payeeKey(t.description)) || beyondRail(t.normalizedMerchant).length < MIN_PAYEE_NAME;
}

export function groupByPayee(txns: GroupTxn[]): PayeeGroup[] {
  const groups = new Map<string, PayeeGroup>();

  for (const t of txns) {
    const isP2P = P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description);
    const byPayee = isP2P && keysOnDescription(t);
    const key = byPayee
      ? payeeKey(t.description)
      : t.normalizedMerchant !== ''
        ? t.normalizedMerchant
        : payeeKey(t.description);
    if (key === '') continue;

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        matchField: byPayee ? 'DESCRIPTION' : 'MERCHANT',
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
