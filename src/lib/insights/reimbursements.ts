import type { TxnData } from "./types";

/**
 * Reimbursement semantics shared by the analyzers.
 *
 * An INFLOW reduces spending instead of counting as income when either:
 * - LINKED: reimbursesId points at an outflow — the amount is subtracted
 *   from the ORIGINAL transaction's category, in the ORIGINAL's period
 *   (cross-month repayments land where the expense was); or
 * - CATEGORIZED: it carries a non-income spending category — subtracted
 *   from that category in the INFLOW's own period.
 *
 * Inflows that are uncategorized or in an isIncome category are income.
 * TRANSFERs never participate on either side.
 */

export function isReimbursement(t: TxnData): boolean {
  if (t.flow !== "INFLOW") return false;
  if (t.reimbursesId !== null) return true;
  return t.categoryId !== null && !t.categoryIsIncome;
}

export interface ReimbursementCredit {
  /** Category the credit nets against (the original's for linked ones). */
  categoryId: string | null;
  categoryName: string | null;
  /** Period attribution date (original outflow's for linked ones). */
  date: Date;
  /** Positive magnitude to subtract from spending. */
  amount: number;
}

/**
 * Resolves every reimbursement inflow to the (category, date) it credits.
 * Linked inflows whose target is missing or not an outflow fall back to
 * their own category/date so money never silently disappears.
 */
export function reimbursementCredits(txns: TxnData[]): ReimbursementCredit[] {
  const byId = new Map(txns.map((t) => [t.id, t]));
  const credits: ReimbursementCredit[] = [];
  for (const t of txns) {
    if (!isReimbursement(t)) continue;
    const target = t.reimbursesId === null ? undefined : byId.get(t.reimbursesId);
    if (target !== undefined && target.flow === "OUTFLOW") {
      credits.push({
        categoryId: target.categoryId,
        categoryName: target.categoryName,
        date: target.date,
        amount: t.amount,
      });
    } else {
      credits.push({
        categoryId: t.categoryId,
        categoryName: t.categoryName,
        date: t.date,
        amount: t.amount,
      });
    }
  }
  return credits;
}
