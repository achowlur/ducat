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

export function isReimbursement(t: Pick<TxnData, "flow" | "reimbursesId" | "categoryId" | "categoryIsIncome">): boolean {
  if (t.flow !== "INFLOW") return false;
  if (t.reimbursesId !== null) return true;
  return t.categoryId !== null && !t.categoryIsIncome;
}

/**
 * Whether a linked reimbursement credits the row it is linked to: only an
 * OUTFLOW can be credited, and a link to anything else (or to a row that is
 * gone) falls back to the inflow itself, so money never silently disappears.
 * reimbursementSources files every credit by it, and the ledger's SPENDING
 * view (ui/flowFilter.ts) lists exactly the credits that fall back.
 */
export function creditsLinkedRow<T extends { flow: string }>(linked: T | null | undefined): linked is T {
  return linked !== null && linked !== undefined && linked.flow === "OUTFLOW";
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
 * A reimbursement inflow and the row it nets against: the linked original,
 * or the inflow itself. EVERYTHING a credit is filed under comes from that
 * one row — its category, its date (so its period), and for /trends its
 * merchant and account — so no view can file one credit two ways.
 */
export interface ReimbursementSource<T extends TxnData = TxnData> {
  source: T;
  /** Positive magnitude to subtract from spending. */
  amount: number;
}

/**
 * Resolves every reimbursement inflow to the row it credits. Linked inflows
 * whose target is missing or not an outflow fall back to themselves so money
 * never silently disappears.
 */
export function reimbursementSources<T extends TxnData>(txns: T[]): ReimbursementSource<T>[] {
  const byId = new Map(txns.map((t) => [t.id, t]));
  const sources: ReimbursementSource<T>[] = [];
  for (const t of txns) {
    if (!isReimbursement(t)) continue;
    const target = t.reimbursesId === null ? undefined : byId.get(t.reimbursesId);
    sources.push({
      source: creditsLinkedRow(target) ? target : t,
      // Deliberately NOT capped at the original's amount: an over-repayment
      // stays visible as a negative category total rather than being
      // silently discarded (see the over-reimbursement test). Presentation
      // handles the consequences — the donut's denominator uses only
      // positive categories so slices can never exceed 100%.
      amount: t.amount,
    });
  }
  return sources;
}

/** Every reimbursement inflow as the (category, date) it credits. */
export function reimbursementCredits(txns: TxnData[]): ReimbursementCredit[] {
  return reimbursementSources(txns).map(({ source, amount }) => ({
    categoryId: source.categoryId,
    categoryName: source.categoryName,
    date: source.date,
    amount,
  }));
}
