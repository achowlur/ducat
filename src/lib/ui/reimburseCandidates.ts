import { suggestReimbursements } from "../insights/suggestReimbursements";
import { isoDate, titleCase } from "./format";

/**
 * One projection path for reimbursement candidates, shared by the page (which
 * needs only the strong-match hint per inflow row) and the on-open server
 * action (which returns the full list). The split exists so the ledger stops
 * serializing every inflow's candidates into the HTML when none is opened —
 * and sharing this module is what guarantees the list that appears on open is
 * exactly the list the page would have embedded: same candidates, same order,
 * same wording.
 */

/** How far back an outflow can be and still count as being paid back. */
export const REIMBURSE_WINDOW_DAYS = 45;
/** Repayment can lead the charge by a few days (paid before it posted). */
export const REIMBURSE_LEAD_DAYS = 3;
/** Same cap the ledger's pool query has always carried. */
export const REIMBURSE_POOL_TAKE = 2000;

/**
 * Expenses nobody splits with the friend who Venmo'd them. Without this the
 * reimbursement ranker will happily offer "1/6 of your $6,300.49 tax payment",
 * because the arithmetic works. Uncategorized outflows stay splittable — a
 * shared dinner often hasn't been categorized yet.
 */
export const UNSPLITTABLE = new Set([
  "Rent & Housing",
  "Taxes",
  "Fees & Charges",
  "Utilities",
  "Subscriptions",
  "Health",
  "Cash & ATM",
]);

/** An outflow as the pool query selects it (amount already Number()ed). */
export interface PoolOutflow {
  id: string;
  amount: number;
  date: Date;
  categoryId: string | null;
  normalizedMerchant: string;
  description: string;
}

export interface ReimburseCandidate {
  id: string;
  label: string; // merchant/description
  date: string; // ISO date
  amount: number; // positive magnitude
  category: string | null;
  /** Why it was suggested: "exact amount", "1/3 of $90.00". */
  reason: string;
  /** Amount evidence is strong (exact or a clean split), not just proximity. */
  strong: boolean;
}

/**
 * Builds a finder over a pool of outflows. The pool projection happens ONCE
 * here, not per inflow — the per-row form of this map is the bug the backlog
 * recorded as 34,780 projections per load.
 *
 * The pool may be wider than any one inflow's window (the page fetches one
 * pool spanning every inflow on the page): `suggestReimbursements` zeroes the
 * date evidence outside [inflow − REIMBURSE_WINDOW_DAYS, inflow +
 * REIMBURSE_LEAD_DAYS], so extra rows cannot appear, and filtering preserves
 * order, so a per-inflow pool over exactly that window returns the identical
 * list — the property the lazy action depends on, pinned by the tests.
 *
 * The identity holds while every pool stays under REIMBURSE_POOL_TAKE; past
 * the cap the wide and narrow queries would truncate differently (the narrow
 * one keeping the rows that matter). Both queries order date desc, id desc,
 * so same-date ties cannot resolve differently either.
 */
export function makeCandidateFinder(
  pool: PoolOutflow[],
  categoryName: (categoryId: string | null) => string | null,
): (inflow: { amount: number; date: Date }) => ReimburseCandidate[] {
  const byId = new Map(pool.map((o) => [o.id, o]));
  const rankable = pool.map((o) => ({
    id: o.id,
    amount: o.amount,
    date: o.date,
    splittable: !UNSPLITTABLE.has(categoryName(o.categoryId) ?? ""),
  }));
  return (inflow) =>
    suggestReimbursements(inflow, rankable, { windowDays: REIMBURSE_WINDOW_DAYS }).flatMap((s) => {
      const o = byId.get(s.id);
      if (o === undefined) return [];
      return [
        {
          id: o.id,
          label: titleCase(o.normalizedMerchant !== "" ? o.normalizedMerchant : o.description.toLowerCase()),
          date: isoDate(o.date),
          amount: Math.abs(o.amount),
          category: categoryName(o.categoryId),
          reason: s.reason,
          strong: s.strong,
        },
      ];
    });
}
