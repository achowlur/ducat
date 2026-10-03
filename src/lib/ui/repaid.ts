/**
 * What linked repayments returned, seen from the EXPENSE's side.
 *
 * A link is stored on the repayment (`reimbursesId`), so the ledger only ever
 * showed it on the row that paid money back, never on the bill it paid back.
 * The analyzers credit it to the bill's category and month
 * (insights/reimbursements.ts), so /trends printed the net figure while the
 * ledger it links to listed the full charge with nothing beside it: a bill
 * split three ways read as unsplit one click away from the figure that had
 * already split it. These give the ledger the same facts from the bill's side.
 *
 * Only what the analyzers count is counted: an INFLOW linked to an OUTFLOW.
 * A link whose repayment has since become a transfer credits nothing there,
 * so it credits nothing here either.
 *
 * Summed in whole cents, as ledgerTotals.ts sums, for its reason.
 */
import { money } from "./format";

export interface LinkedRepayment {
  id: string;
  /** The expense it pays back. */
  reimbursesId: string;
  flow: string;
  /** Signed as stored: positive for money in. */
  amount: number;
}

export interface Repaid {
  /** A positive magnitude. */
  amount: number;
  /** How many linked repayments make it up. */
  count: number;
}

const NONE: Repaid = { amount: 0, count: 0 };

/** Per expense id, everything its linked repayments returned. */
export function repaidByExpense(repayments: readonly LinkedRepayment[]): Map<string, Repaid> {
  const cents = new Map<string, { cents: number; count: number }>();
  for (const r of repayments) {
    if (r.flow !== "INFLOW") continue;
    const entry = cents.get(r.reimbursesId) ?? { cents: 0, count: 0 };
    entry.cents += Math.round(r.amount * 100);
    entry.count += 1;
    cents.set(r.reimbursesId, entry);
  }
  return new Map([...cents].map(([id, e]) => [id, { amount: e.cents / 100, count: e.count }]));
}

/**
 * What linked repayments returned on the OUTFLOW rows of `rows`, counting only
 * repayments whose own row is not in `listed`.
 *
 * `listed` is the whole filtered list, every page of it, and never the page
 * alone: a repayment the list shows is already in its IN, wherever it sits.
 * Counting it again here would count it twice, and taking the page instead of
 * the list would make the page totals stop adding up to the overall one.
 *
 * This is what lets a CATEGORY view agree with /trends. The view lists the
 * bill and not the Zelle that paid two thirds of it, because the Zelle carries
 * another category or none, so without this its total printed the whole
 * charge as spent.
 */
export function repaidFromOutside(
  rows: readonly { id: string; flow: string }[],
  repayments: readonly LinkedRepayment[],
  listed: ReadonlySet<string>,
): Repaid {
  const outflows = new Set(rows.filter((t) => t.flow === "OUTFLOW").map((t) => t.id));
  if (outflows.size === 0) return NONE;
  let cents = 0;
  let count = 0;
  for (const r of repayments) {
    if (r.flow !== "INFLOW" || !outflows.has(r.reimbursesId) || listed.has(r.id)) continue;
    cents += Math.round(r.amount * 100);
    count += 1;
  }
  return count === 0 ? NONE : { amount: cents / 100, count };
}

/**
 * The line under a repaid bill, in words: what came back, and what that leaves
 * as the bill's real cost. Never a negative share: a bill repaid past its
 * charge says by how much, because "your share −$4.10" reads as a typo.
 */
export function repaidNote(charge: number, repaid: Repaid): string {
  const left = (Math.round(Math.abs(charge) * 100) - Math.round(repaid.amount * 100)) / 100;
  const back = `repaid ${money(repaid.amount)}`;
  if (left > 0) return `${back} · your share ${money(left)}`;
  if (left === 0) return `${back}, in full`;
  return `${back}, ${money(-left)} more than the charge`;
}
