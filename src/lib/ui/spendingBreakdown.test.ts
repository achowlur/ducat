import { describe, expect, it } from "vitest";
import type { SpendingByCategoryPayload } from "../../types/contracts";
import { sliceFill, sliceSwatch } from "./donutColors";
import { OVERVIEW_SLICING, spendingBreakdown, wholePercents } from "./spendingBreakdown";

function payload(
  categories: { name: string | null; spending: number }[],
): SpendingByCategoryPayload {
  return {
    granularity: "MONTH",
    totalSpending: categories.reduce((sum, c) => sum + c.spending, 0),
    previousTotalSpending: null,
    categories: categories
      .map((c) => ({
        categoryId: c.name === null ? null : `cat-${c.name.toLowerCase()}`,
        categoryName: c.name,
        spending: c.spending,
        previousSpending: null,
        deltaPct: null,
      }))
      .sort((a, b) => b.spending - a.spending),
  };
}

describe("spendingBreakdown", () => {
  // June 2026, real shape: a rent refund left Rent & Housing at −$409.73, so
  // the ring draws $3,535.25 while the month cost $3,125.52. Dividing the
  // table's shares by the total (as it did) printed "Dining 55%" under a
  // $3,535.25 headline — 55% of which is $1943.8.
  const june = payload([
    { name: "Dining", spending: 1719.90 },
    { name: "Groceries", spending: 804.58 },
    { name: "Shopping", spending: 622.02 },
    { name: "Transport", spending: 388.75 },
    { name: "Rent & Housing", spending: -409.73 },
  ]);

  it("divides every share by the drawn total, not the reimbursement-shrunk one", () => {
    const b = spendingBreakdown(june);
    expect(b.drawable).toBe(3535.25);
    expect(b.total).toBe(3125.52);
    expect(b.credited).toBe(409.73);

    const dining = b.categories.find((c) => c.label === "Dining");
    expect(dining?.share).toBeCloseTo(1719.90 / 3535.25, 10);
    expect(Math.round((dining?.share ?? 0) * 100)).toBe(49); // was 55 against the net total
  });

  it("gives a category that ended in credit no share of the ring", () => {
    const b = spendingBreakdown(june);
    const rent = b.categories.find((c) => c.label === "Rent & Housing");
    expect(rent?.spending).toBe(-409.73); // the credit stays visible and honest
    expect(rent?.share).toBeNull();
    expect(b.donut?.slices.some((s) => s.label === "Rent & Housing")).toBe(false);
  });

  it("keeps arcs and table shares on one denominator, summing to exactly 1", () => {
    const b = spendingBreakdown(june);
    const arcs = (b.donut?.slices ?? []).reduce((sum, s) => sum + s.share, 0);
    const rows = b.categories.reduce((sum, c) => sum + (c.share ?? 0), 0);
    expect(arcs).toBeCloseTo(1, 10);
    expect(rows).toBeCloseTo(1, 10);
  });

  it("prints the net total in the hole, so /trends and /insights agree", () => {
    // The alternative — printing `drawable` — is what gave one month two
    // spending totals on two screens.
    expect(spendingBreakdown(june).donut?.total).toBe(3125.52);
  });

  it("rolls everything past the top 3 into Other", () => {
    const b = spendingBreakdown(june);
    expect(b.donut?.slices.map((s) => s.label)).toEqual(["Dining", "Groceries", "Shopping", "Other"]);
    expect(b.donut?.slices.find((s) => s.label === "Other")?.value).toBe(388.75);
  });

  it("names the categories inside Other, so a link can enumerate them", () => {
    // Which categories land in Other changes by period, so the slice has to
    // carry its own membership rather than a token resolved later.
    const other = spendingBreakdown(june).donut?.slices.find((s) => s.label === "Other");
    expect(other?.categoryIds).toEqual(["cat-transport"]);
    // Rent & Housing ended negative, draws no arc, and so is not in Other
    // either — a link built from an EXCLUSION list would have swept it in.
    expect(other?.categoryIds).not.toContain("cat-rent & housing");
  });

  it("keeps Uncategorized distinct from Other, though both once carried a null id", () => {
    const b = spendingBreakdown(
      payload([
        { name: "Dining", spending: 100 },
        { name: "Groceries", spending: 90 },
        { name: null, spending: 80 }, // the uncategorized pile, ranked 3rd
        { name: "Gas", spending: 20 },
      ]),
    );
    const slices = b.donut?.slices ?? [];
    expect(slices.map((s) => s.label)).toEqual(["Dining", "Groceries", "Uncategorized", "Other"]);
    // Uncategorized is a bucket of its own: [null], not an empty membership.
    expect(slices[2].categoryIds).toEqual([null]);
    expect(slices[3].categoryIds).toEqual(["cat-gas"]);
  });

  it("puts an uncategorized pile that ranks low INSIDE Other", () => {
    const b = spendingBreakdown(
      payload([
        { name: "Dining", spending: 100 },
        { name: "Groceries", spending: 90 },
        { name: "Shopping", spending: 80 },
        { name: "Gas", spending: 20 },
        { name: null, spending: 10 },
      ]),
    );
    const other = b.donut?.slices.find((s) => s.label === "Other");
    expect(other?.categoryIds).toEqual(["cat-gas", null]);
    expect(other?.value).toBe(30);
  });

  it("gives every single-category slice a one-element membership", () => {
    const b = spendingBreakdown(june);
    for (const s of b.donut?.slices ?? []) {
      if (s.label === "Other") continue;
      expect(s.categoryIds).toHaveLength(1);
    }
  });

  it("draws no donut when reimbursements outran every category", () => {
    const b = spendingBreakdown(payload([{ name: "Dining", spending: -50 }]));
    expect(b.donut).toBeNull();
    expect(b.drawable).toBe(0);
    expect(b.categories[0].share).toBeNull(); // no ring to hold a share of
  });

  it("omits an Other slice when the top 3 are everything", () => {
    const b = spendingBreakdown(
      payload([
        { name: "Dining", spending: 30 },
        { name: "Groceries", spending: 20 },
        { name: "Transport", spending: 10 },
      ]),
    );
    expect(b.donut?.slices.map((s) => s.label)).toEqual(["Dining", "Groceries", "Transport"]);
    expect(b.credited).toBe(0);
  });
});

describe("spendingBreakdown on Overview (every category at 3% or more)", () => {
  const labels = (cats: { name: string | null; spending: number }[]) =>
    spendingBreakdown(payload(cats), OVERVIEW_SLICING).donut?.slices.map((s) => s.label);

  it("names every category at 3% or more and rolls the rest into Other", () => {
    const b = spendingBreakdown(
      payload([
        { name: "Rent", spending: 50 },
        { name: "Groceries", spending: 20 },
        { name: "Dining", spending: 15 },
        { name: "Transport", spending: 6 },
        { name: "Shopping", spending: 4 },
        { name: "Gas", spending: 3 }, // exactly 3% counts
        { name: "Books", spending: 1 },
        { name: "Fees", spending: 1 },
      ]),
      OVERVIEW_SLICING,
    );
    const slices = b.donut?.slices ?? [];
    expect(slices.map((s) => s.label)).toEqual(["Rent", "Groceries", "Dining", "Transport", "Shopping", "Gas", "Other"]);
    expect(slices.map((s) => s.isOther)).toEqual([false, false, false, false, false, false, true]);
    expect(slices[6].categoryIds).toEqual(["cat-books", "cat-fees"]);
  });

  it("names a lone small category instead of hiding it in an Other of one", () => {
    expect(
      labels([
        { name: "Rent", spending: 90 },
        { name: "Groceries", spending: 9 },
        { name: "Fees", spending: 1 },
      ]),
    ).toEqual(["Rent", "Groceries", "Fees"]);
  });

  it("caps the legend at eight rows, the eighth being Other", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `Cat${i}`, spending: 20 - i }));
    const b = spendingBreakdown(payload(ten), OVERVIEW_SLICING);
    const slices = b.donut?.slices ?? [];
    expect(slices).toHaveLength(8);
    expect(slices[7].label).toBe("Other");
    expect(slices[7].categoryIds).toEqual(["cat-cat7", "cat-cat8", "cat-cat9"]);
    expect(slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });

  it("spends the eighth row on a category when exactly eight are everything", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `Cat${i}`, spending: 20 - i }));
    expect(labels(eight)).toEqual(eight.map((c) => c.name));
  });

  it("leaves /trends on its top three", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `Cat${i}`, spending: 20 - i }));
    expect(spendingBreakdown(payload(eight)).donut?.slices.map((s) => s.label)).toEqual([
      "Cat0",
      "Cat1",
      "Cat2",
      "Other",
    ]);
  });
});

describe("wholePercents", () => {
  it("sums to exactly 100 where rounding each share alone overshoots", () => {
    const shares = [0.495, 0.215, 0.115, 0.085, 0.065, 0.025];
    expect(shares.reduce((sum, s) => sum + Math.round(s * 100), 0)).toBeGreaterThan(100);
    const pct = wholePercents(shares);
    expect(pct.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("gives a category in credit no points", () => {
    expect(wholePercents([0.5, null, 0.5])).toEqual([50, 0, 50]);
    expect(wholePercents([null])).toEqual([0]);
  });
});

describe("donut colours", () => {
  it("draws Other in the neutral whatever its position, and cycles the rest", () => {
    expect(sliceFill({ isOther: true }, 0)).toBe("var(--pie-other)");
    expect(sliceSwatch({ isOther: true }, 7)).toBe("bg-pie-other");
    const named = Array.from({ length: 7 }, (_, i) => sliceFill({ isOther: false }, i));
    expect(new Set(named).size).toBe(7);
  });
});
