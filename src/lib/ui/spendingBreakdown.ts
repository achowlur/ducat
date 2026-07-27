import type { SpendingByCategoryPayload } from "../../types/contracts";
import { round2 } from "../insights/stats";

/** Slices are positive categories only, so a slice's share is never null. */
export interface DonutSliceData {
  label: string;
  /**
   * Every category this slice stands for — one for a named category, and for
   * "Other" the whole set ranked below the top slices. `null` is the
   * Uncategorized bucket, which is a real category and not an absence.
   *
   * A list rather than a single id because the two are genuinely different and
   * conflating them was a bug: "Other" and "Uncategorized" both carried
   * `categoryId: null`, so a link built from it dropped the filter and drilled
   * into the entire ledger. It is also an INCLUSION list — naming what is in
   * the slice — so a category added later cannot join "Other" silently.
   */
  categoryIds: (string | null)[];
  value: number;
  share: number;
}

export interface CategoryRow {
  label: string;
  categoryId: string | null;
  spending: number;
  previousSpending: number | null;
  deltaPct: number | null;
  /**
   * Fraction of `drawable`. NULL for a category that ended the period in
   * credit: it draws no arc, so it holds no share of the ring.
   */
  share: number | null;
}

export interface SpendingBreakdown {
  /** Payload order (largest spend first), negatives last. */
  categories: CategoryRow[];
  donut: { slices: DonutSliceData[]; total: number } | null;
  /** Sum of the categories with net spending — the one denominator behind every share and arc. */
  drawable: number;
  /** What the period cost net of reimbursements: the number every screen prints. */
  total: number;
  /** `drawable − total`: spending drawn in the ring that a credit elsewhere cancels out. */
  credited: number;
}

const TOP_SLICES = 3;

/**
 * The single place category shares and donut arcs are computed, so /trends
 * and Overview cannot disagree about a month.
 *
 * Two numbers are in play and both are real. `total` is what the period cost
 * net of reimbursements — what /insights and the cash-flow row report.
 * `drawable` is the sum of the categories that ended with net spending. They
 * diverge when a reimbursement outruns its own category: June's rent refund
 * left Rent & Housing at −$409.73, so $3,535.25 was drawable against a
 * $3,125.52 total.
 *
 * Every share divides by `drawable` — a negative category shrinks the
 * denominator while drawing no arc, so dividing by `total` makes the drawn
 * slices sum past 100% and overlap. Every printed total is `total`, because
 * printing `drawable` gives one month two spending totals across two screens.
 */
export function spendingBreakdown(payload: SpendingByCategoryPayload): SpendingBreakdown {
  const total = payload.totalSpending;
  const positive = payload.categories.filter((c) => c.spending > 0);
  const drawable = round2(positive.reduce((sum, c) => sum + c.spending, 0));

  const categories: CategoryRow[] = payload.categories.map((c) => ({
    label: c.categoryName ?? "Uncategorized",
    categoryId: c.categoryId,
    spending: c.spending,
    previousSpending: c.previousSpending,
    deltaPct: c.deltaPct,
    share: drawable > 0 && c.spending > 0 ? c.spending / drawable : null,
  }));

  let donut: SpendingBreakdown["donut"] = null;
  if (drawable > 0) {
    const slices: DonutSliceData[] = positive.slice(0, TOP_SLICES).map((c) => ({
      label: c.categoryName ?? "Uncategorized",
      categoryIds: [c.categoryId],
      value: c.spending,
      share: c.spending / drawable,
    }));
    const rest = positive.slice(TOP_SLICES);
    const restTotal = round2(rest.reduce((sum, c) => sum + c.spending, 0));
    if (restTotal > 0) {
      slices.push({
        label: "Other",
        categoryIds: rest.map((c) => c.categoryId),
        value: restTotal,
        share: restTotal / drawable,
      });
    }
    donut = { slices, total };
  }

  return { categories, donut, drawable, total, credited: round2(drawable - total) };
}
