/**
 * The `?flow=` wire format for `/transactions`, read in ONE place.
 *
 * OUTFLOW, INFLOW and TRANSFER are a row's own flow, and SQL answers them
 * exactly. SPENDING and INCOME are the two FIGURES /trends and Overview print,
 * so a link from a figure opens the rows that make it up and nothing else.
 * Under INFLOW, Trends' income opened a list that also held every linked
 * repayment, and the list's IN came to more than the figure it was opened
 * from; a spending link opened every flow, so its net took in the income.
 *
 * Both are decided by insights/reimbursements.ts itself, never restated here:
 * - INCOME is money in that is not a reimbursement: exactly what ui/report.ts
 *   counts as income.
 * - SPENDING is money out, plus each reimbursement that credits ITSELF: a
 *   refund carrying a spending category, or a link to a row that is not an
 *   outflow. A repayment linked to an outflow credits that bill, which can
 *   sit in another month, account or merchant than the repayment does, so it
 *   is never listed; it arrives through REPAID (ui/repaid.ts) from the bill's
 *   side, and the band's net is the figure to the cent.
 *
 * Whether a row reimburses turns on its category's isIncome, which SQL does
 * not hold on the row, so SQL narrows to a SUPERSET and the list is finished
 * in memory, as the merchant filter's is.
 */
import type { TransactionFlow } from "../../types/contracts";
import { creditsLinkedRow, isReimbursement } from "../insights/reimbursements";

export type FlowParam = TransactionFlow | "SPENDING" | "INCOME";

const FLOWS: readonly FlowParam[] = ["OUTFLOW", "INFLOW", "TRANSFER", "SPENDING", "INCOME"];

/** Null for no flow filter, and for anything that is not one. */
export function parseFlowParam(value: string | undefined): FlowParam | null {
  return FLOWS.find((f) => f === value) ?? null;
}

/** What SQL narrows to: the row's own flow exactly, a superset for the two figures. */
export function sqlFlow(flow: FlowParam): TransactionFlow | { not: TransactionFlow } {
  if (flow === "INCOME") return "INFLOW";
  if (flow === "SPENDING") return { not: "TRANSFER" };
  return flow;
}

/** Whether the list must be finished in memory, and so fetched whole. */
export function finishedInMemory(flow: FlowParam | null): boolean {
  return flow === "SPENDING" || flow === "INCOME";
}

export interface FlowRow {
  flow: string;
  categoryId: string | null;
  reimbursesId: string | null;
  /** The row a link points at; null when there is no link, or it is gone. */
  reimburses: { flow: string } | null;
}

/**
 * The in-memory finish for the two figures; null for a row's own flow, which
 * SQL has already answered.
 */
export function flowFinish(
  flow: FlowParam | null,
  incomeCategoryIds: ReadonlySet<string>,
): ((t: FlowRow) => boolean) | null {
  if (!finishedInMemory(flow)) return null;
  const reimburses = (t: FlowRow) =>
    isReimbursement({
      flow: t.flow as TransactionFlow,
      reimbursesId: t.reimbursesId,
      categoryId: t.categoryId,
      categoryIsIncome: t.categoryId !== null && incomeCategoryIds.has(t.categoryId),
    });
  if (flow === "INCOME") return (t) => t.flow === "INFLOW" && !reimburses(t);
  return (t) => t.flow === "OUTFLOW" || (reimburses(t) && !creditsLinkedRow(t.reimburses));
}
