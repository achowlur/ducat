import { describe, expect, it } from "vitest";
import type { SpendingByCategoryPayload } from "../../types/contracts";
import { spendingBreakdown } from "./spendingBreakdown";

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
