import type { SharedPlanPayload } from '../../types/contracts';
import { creditsLinkedRow, reimbursementSources } from './reimbursements';
import { round2 } from './stats';
import type { TxnData } from './types';

/**
 * A plan split with other people, read from the repayments LINKED to its
 * bills (Transaction.reimbursesId), never from a share typed in.
 *
 * A phone plan billed in full and split three ways reached every subscription
 * figure at the full bill: the /yr, the next charge, the 30-day commitments
 * and the pace call's committed spend all counted money two other people pay
 * back, while spending (which nets linked repayments) did not. The operator
 * already links the repayments, so the share is there to be read, and any
 * future split plan works with no setup.
 *
 * The rules, in order:
 * - A bill's NET is the bill less the repayments linked to it, by the same
 *   resolution spending uses (reimbursementSources), so the two can never
 *   disagree about which repayments count.
 * - A bill is SETTLED once repayments are linked to it, or once the next bill
 *   has arrived. The newest bill with nothing linked is still waiting.
 * - A plan becomes SHARED when two settled bills in a row both had linked
 *   repayments. One repaid bill is a one-off reimbursement, not a split.
 * - A shared plan bills its SHARE as a PART of the bill: the middle of its
 *   last few settled nets, each as a fraction of its own bill, never a mean
 *   (between two, the larger), times the newest bill. A split is the same
 *   fraction whatever the price, so a price rise split the same way stays
 *   shared and the share follows it; dollars fixed at the old price read
 *   every bill after a rise as short.
 * - The newest bill joins the sample only once it is repaid as the sample
 *   expects: half-linked so far, it would raise the share until the second
 *   repayment lands. It still counts toward two repaid bills in a row.
 * - Fail safe: once the next bill has arrived, a bill repaid less than
 *   expected (the bill less its share, within a small tolerance) is UNSPLIT. It
 *   leaves the share's sample and is named so the operator can link the rest
 *   or say it was not shared. Two unsplit bills in a row and the plan is no
 *   longer shared: it goes back to full price with nothing to answer.
 * - History is never backfilled: a month with nothing linked stays at full
 *   price, in spending as everywhere else.
 */

/** Settled nets the share is the middle of: the most recent few. */
export const SHARE_SAMPLE = 3;

/** How far under the expected repayment a bill may fall and still count as split. */
export function shortfallTolerance(bill: number): number {
  return Math.max(1, bill * 0.02);
}

export interface PlanBill {
  id: string;
  /** ISO day. */
  date: string;
  /** Positive magnitude of the charge. */
  amount: number;
  /** Positive sum of the repayments linked to it. */
  repaid: number;
}

/** The middle of the recent parts; between two, the larger. */
function middle(parts: number[]): number {
  const s = parts.slice(-SHARE_SAMPLE).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Whether a plan is shared and what its share is, from its bills oldest
 * first; null when it is not shared. Pure: the engine hands it the plan's
 * charges and what is linked to each.
 */
export function sharedPlan(bills: readonly PlanBill[]): SharedPlanPayload | null {
  // Each settled net as a fraction of its own bill.
  let parts: number[] = [];
  let shared = false;
  let shortRun = 0;
  let prevSplit = false;
  let unsplit: SharedPlanPayload['unsplit'] = null;

  for (let i = 0; i < bills.length; i++) {
    const b = bills[i];
    const newest = i === bills.length - 1;
    const split = b.repaid > 0.005;
    // The newest bill with nothing linked yet is waiting, not settled.
    if (newest && !split) break;
    const part = b.amount > 0 ? (b.amount - b.repaid) / b.amount : 1;
    // Repaid as the sample expects: the bill less its share, within tolerance.
    const repaidInFull = () =>
      parts.length > 0 && b.repaid >= b.amount * (1 - middle(parts)) - shortfallTolerance(b.amount);

    if (shared) {
      // The newest bill is never judged short: its other repayments may
      // simply not be linked yet. The next bill's arrival is what settles it.
      if (newest) {
        if (repaidInFull()) parts.push(part);
        break;
      }
      const short = !repaidInFull();
      if (short) {
        shortRun += 1;
        if (shortRun >= 2) {
          shared = false;
          parts = [];
          shortRun = 0;
          unsplit = null;
          // Sharing starts over from two repaid bills, whatever this one had.
          prevSplit = false;
          continue;
        }
        unsplit = { date: b.date, amount: round2(b.amount), repaid: round2(b.repaid) };
      } else {
        // An unsplit bill stays news through the next one (checked below),
        // even once that next bill has its repayments linked.
        shortRun = 0;
        parts.push(part);
      }
    } else if (split) {
      if (newest) {
        // Two repaid in a row make it shared, but a newest bill linked only
        // in part never sets the share: that comes from the settled ones.
        if (prevSplit) {
          shared = true;
          if (repaidInFull()) parts.push(part);
        }
        break;
      }
      parts = prevSplit ? [...parts, part] : [part];
      if (prevSplit) shared = true;
    }
    prevSplit = split;
  }

  if (!shared) return null;
  // Only the bill just before the newest is news: an older unsplit bill has
  // had its cycle to be answered.
  const previous = bills.length >= 2 ? bills[bills.length - 2] : undefined;
  return {
    share: round2(middle(parts) * bills[bills.length - 1].amount),
    unsplit: unsplit !== null && previous !== undefined && unsplit.date === previous.date ? unsplit : null,
  };
}

/**
 * Positive sum linked to each bill, by bill id, over the whole history: the
 * repayments spending nets against an outflow, and nothing else.
 */
export function repaidByBill(txns: readonly TxnData[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { source, amount } of reimbursementSources([...txns])) {
    // A credit that falls back to the inflow itself credits no bill.
    if (!creditsLinkedRow(source)) continue;
    out.set(source.id, (out.get(source.id) ?? 0) + amount);
  }
  return out;
}

/** A plan's charges as bills, with what is linked to each. `rows` oldest first. */
export function billsOf(rows: readonly TxnData[], repaid: ReadonlyMap<string, number>): PlanBill[] {
  return rows.map((t) => ({
    id: t.id,
    date: t.date.toISOString().slice(0, 10),
    amount: -t.amount,
    repaid: repaid.get(t.id) ?? 0,
  }));
}
