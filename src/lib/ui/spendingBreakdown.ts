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
  /** The rolled-up remainder rather than a category — drawn in a neutral colour. */
  isOther: boolean;
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

/**
 * How a ring chooses its slices. /trends draws the TOP few, because the full
 * table beside it names everything. Overview has no such table, so its ring
 * names every category worth a slice: each at `minShare` or more, as many as
 * `maxRows` legend rows hold, the rest rolled into Other.
 */
export type DonutSlicing =
  | { kind: "top"; count: number }
  | { kind: "share"; minShare: number; maxRows: number };

export const TRENDS_SLICING: DonutSlicing = { kind: "top", count: 3 };
export const OVERVIEW_SLICING: DonutSlicing = { kind: "share", minShare: 0.03, maxRows: 8 };

/**
 * Percentages of ONE whole, rounded together: floor every share, then hand the
 * leftover points to the largest fractional parts. Rounding each row on its own
 * let a column sum to 101%. A null share (a category that ended in credit)
 * holds no points and prints as 0 here; callers show it as a dash.
 */
export function wholePercents(shares: (number | null)[]): number[] {
  const raw = shares.map((v) => (v === null ? null : v * 100));
  const out = raw.map((v) => (v === null ? 0 : Math.floor(v)));
  const floored = out.reduce((a, b) => a + b, 0);
  const whole = raw.some((v) => v !== null) ? 100 : 0;
  const order = raw
    .map((v, i) => ({ i, frac: v === null ? -1 : v - Math.floor(v) }))
    .filter((x) => x.frac >= 0)
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < whole - floored && k < order.length; k += 1) out[order[k].i] += 1;
  return out;
}

/** How many of the ranked positive categories get a slice of their own. */
function namedCount(shares: number[], slicing: DonutSlicing): number {
  if (slicing.kind === "top") return Math.min(slicing.count, shares.length);
  const eligible = shares.filter((s) => s >= slicing.minShare).length;
  // Everything left over fits in one more row when it is a single category —
  // an "Other" holding one name hides that name for nothing.
  if (shares.length - eligible === 1 && eligible < slicing.maxRows) return shares.length;
  if (eligible === shares.length && eligible <= slicing.maxRows) return eligible;
  return Math.min(eligible, slicing.maxRows - 1);
}

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
export function spendingBreakdown(
  payload: SpendingByCategoryPayload,
  slicing: DonutSlicing = TRENDS_SLICING,
): SpendingBreakdown {
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
    const named = namedCount(
      positive.map((c) => c.spending / drawable),
      slicing,
    );
    const slices: DonutSliceData[] = positive.slice(0, named).map((c) => ({
      label: c.categoryName ?? "Uncategorized",
      categoryIds: [c.categoryId],
      value: c.spending,
      share: c.spending / drawable,
      isOther: false,
    }));
    const rest = positive.slice(named);
    const restTotal = round2(rest.reduce((sum, c) => sum + c.spending, 0));
    if (restTotal > 0) {
      slices.push({
        label: "Other",
        categoryIds: rest.map((c) => c.categoryId),
        value: restTotal,
        share: restTotal / drawable,
        isOther: true,
      });
    }
    donut = { slices, total };
  }

  return { categories, donut, drawable, total, credited: round2(drawable - total) };
}
