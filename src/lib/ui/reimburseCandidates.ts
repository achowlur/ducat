import { REPAYMENT_LEAD_DAYS, suggestReimbursements } from "../insights/suggestReimbursements";
import { merchantLabel } from "./merchantLabel";
import { isoDate } from "./format";

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
/**
 * How long after a repayment its expense may come — the ranker's own window,
 * re-exported so the pool queries fetch exactly what it can score.
 */
export const REIMBURSE_LEAD_DAYS = REPAYMENT_LEAD_DAYS;
/** Same cap the ledger's pool query has always carried. */
export const REIMBURSE_POOL_TAKE = 2000;

/**
 * How many ranked candidates the picker offers.
 *
 * `suggestReimbursements` defaults to 5, which is right for a hint and too
 * few for a picker: the ranking multiplies amount evidence by date decay, so
 * a clean 1/3-of-dinner from three weeks ago scores about the same as a
 * shapeless "part of $X" from yesterday (0.85/(1+1.5) = 0.34 against 0.3),
 * and five slots is where real matches start losing to recent noise. Twelve
 * reaches past that without turning the panel into a list of everything in
 * the 45-day window — and the panel scrolls, so length costs no layout.
 *
 * Raising it cannot change the collapsed hint: the page takes [0], and a
 * longer list shares its prefix. That is what keeps the wide-pool/narrow-pool
 * equivalence pinned in the tests true.
 */
export const REIMBURSE_CANDIDATE_LIMIT = 12;

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

/**
 * Account types whose INFLOWS cannot be a peer paying you back.
 *
 * `UNSPLITTABLE` guards the outflow side — what an expense can plausibly be a
 * share of. Nothing guarded the inflow side, so a brokerage DIVIDEND ranked as
 * a repayment on amount and date alone: every one of the five hints on ledger
 * page 1 was a dividend, and two of those sat inside IRAs, where money
 * arriving is definitionally not a friend settling up for dinner. The
 * arithmetic worked in each case, which is exactly the failure mode — the same
 * one UNSPLITTABLE exists for, arriving from the other direction.
 *
 * Typed by ACCOUNT rather than by category because the dividends were
 * correctly categorized as income and the ranker never consulted the category
 * of the inflow, only of the outflow.
 */
export const NON_REIMBURSABLE_ACCOUNT_TYPES = new Set(["INVESTMENT"]);

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
): (inflow: { amount: number; date: Date; accountType?: string }) => ReimburseCandidate[] {
  const byId = new Map(pool.map((o) => [o.id, o]));
  const rankable = pool.map((o) => ({
    id: o.id,
    amount: o.amount,
    date: o.date,
    splittable: !UNSPLITTABLE.has(categoryName(o.categoryId) ?? ""),
  }));
  return (inflow) => {
    // The guard lives HERE and not at either call site, because the collapsed
    // hint and the opened list must stay the identical projection — that
    // equivalence is what the wide-pool/narrow-pool tests pin. Refusing in one
    // place would show a dot that opens onto an empty list.
    if (inflow.accountType !== undefined && NON_REIMBURSABLE_ACCOUNT_TYPES.has(inflow.accountType)) {
      return [];
    }
    return suggestReimbursements(inflow, rankable, {
      windowDays: REIMBURSE_WINDOW_DAYS,
      leadDays: REIMBURSE_LEAD_DAYS,
      limit: REIMBURSE_CANDIDATE_LIMIT,
    }).flatMap((s) => {
      const o = byId.get(s.id);
      if (o === undefined) return [];
      return [
        {
          id: o.id,
          // merchantLabel, not titleCase: for a P2P rail the bank's payee field
          // is the RAIL, so this printed "Zelle Transfer" as a candidate name —
          // reintroducing, inside the picker, exactly the unreviewable string
          // the ledger's merchant column exists to replace.
          label: merchantLabel(o).label,
          date: isoDate(o.date),
          amount: Math.abs(o.amount),
          category: categoryName(o.categoryId),
          reason: s.reason,
          strong: s.strong,
        },
      ];
    });
  };
}

/** How many search matches the panel lists; it scrolls, and a search narrows. */
export const REIMBURSE_SEARCH_LIMIT = 30;

/**
 * The picker's SEARCH, over the same window as the suggestions but without
 * their judgement: the ranked list is a guess, capped at
 * REIMBURSE_CANDIDATE_LIMIT, and a repayment whose amount is no clean share of
 * its expense can rank far below it: a Zelle covering part of the next day's
 * dinner (numbers invented: $17.20 of $52.60) sat under two dozen unrelated
 * weak matches and could not be linked at all. Search is the guarantee that
 * ANY expense in the window can be found.
 *
 * A query matches the displayed merchant, the bank description, or the amount
 * (typed as "52.60", "52", or "$52"). Matches sort by closeness in time, and
 * the amount rule is NOT applied — the person searching knows which expense it
 * was, even one smaller than the repayment. The reason line reports the ranked
 * view's amount evidence when there is some, so a match still says why it fits.
 */
export function searchCandidates(
  pool: PoolOutflow[],
  categoryName: (categoryId: string | null) => string | null,
  inflow: { amount: number; date: Date },
  query: string,
): ReimburseCandidate[] {
  const q = query.trim().toLowerCase().replace(/^\$/, '');
  if (q.length < 2) return [];
  const numeric = /^[\d.,]+$/.test(q) ? q.replace(/,/g, '') : null;
  const scored = new Map(
    suggestReimbursements(
      inflow,
      pool.map((o) => ({ id: o.id, amount: o.amount, date: o.date })),
      { limit: pool.length, windowDays: REIMBURSE_WINDOW_DAYS, leadDays: REIMBURSE_LEAD_DAYS, minScore: 0 },
    ).map((s) => [s.id, s]),
  );
  const at = inflow.date.getTime();
  return pool
    .filter((o) => {
      const label = merchantLabel(o).label.toLowerCase();
      if (label.includes(q) || o.description.toLowerCase().includes(q) || o.normalizedMerchant.includes(q)) return true;
      return numeric !== null && Math.abs(o.amount).toFixed(2).startsWith(numeric);
    })
    .sort((a, b) => Math.abs(a.date.getTime() - at) - Math.abs(b.date.getTime() - at) || a.id.localeCompare(b.id))
    .slice(0, REIMBURSE_SEARCH_LIMIT)
    .map((o) => {
      const s = scored.get(o.id);
      return {
        id: o.id,
        label: merchantLabel(o).label,
        date: isoDate(o.date),
        amount: Math.abs(o.amount),
        category: categoryName(o.categoryId),
        reason: s?.reason ?? 'found by search',
        strong: s?.strong ?? false,
      };
    });
}
