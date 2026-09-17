/**
 * Peer-to-peer payments, shared by the sync layer, the analyzers and the UI.
 *
 * The payment rail says nothing about what the money was FOR ("ZELLE TO JOHN
 * SMITH" could be rent, dinner or a loan), so a P2P row is never categorized
 * without a person confirming it. Rules may SUGGEST a category for one; only a
 * user rule that marks the payment a TRANSFER still applies on its own, because
 * a transfer is not a spending decision and holding it for review would count
 * real transfers as spending until someone tapped through them.
 */
export const P2P_PATTERN =
  /\b(zelle|venmo|cash ?app|paypal|apple cash|google pay|western union|moneygram|wire transfer)\b/i;

export function isP2P(t: { normalizedMerchant: string; description: string }): boolean {
  return P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description);
}

/**
 * A P2P payment nobody has confirmed yet: no category, not a transfer, and (for
 * money in) not linked to the expense it pays back — a link is a decision.
 */
export function isUnreviewedP2P(t: {
  normalizedMerchant: string;
  description: string;
  categoryId: string | null;
  reimbursesId: string | null;
  flow: string;
}): boolean {
  return t.categoryId === null && t.reimbursesId === null && t.flow !== "TRANSFER" && isP2P(t);
}

/**
 * The spending bucket unconfirmed P2P OUTFLOWS land in — a slice of their own
 * rather than hiding inside Uncategorized. It is not a Category row: nothing is
 * written to a transaction, the analyzer derives it. The id doubles as the
 * `?category=` token, so a link built from a slice needs no translation.
 */
export const P2P_UNREVIEWED_ID = "p2p-unreviewed";
export const P2P_UNREVIEWED_NAME = "P2P — Unreviewed";

/**
 * Words a SQL `contains` can pre-filter on before `isP2P` decides exactly.
 * Every alternative in P2P_PATTERN contains one of these, so the pre-filter
 * is a SUPERSET and can never lose a P2P row ("cash" covers "cash app",
 * "cashapp" and "apple cash"); pinned by p2p.test.ts. SQLite's LIKE is
 * case-insensitive for ASCII, which these all are.
 */
export const P2P_PREFILTER_WORDS = [
  "zelle",
  "venmo",
  "cash",
  "paypal",
  "google pay",
  "western union",
  "moneygram",
  "wire transfer",
] as const;
