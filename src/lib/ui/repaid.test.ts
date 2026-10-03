import { describe, expect, it } from "vitest";
import { computeSpendingByCategory } from "../insights/spendingByCategory";
import type { TxnData } from "../insights/types";
import { ledgerTotals } from "./ledgerTotals";
import { repaidByExpense, repaidFromOutside, repaidNote, type LinkedRepayment } from "./repaid";

const link = (id: string, reimbursesId: string, amount: number, flow = "INFLOW"): LinkedRepayment => ({
  id,
  reimbursesId,
  flow,
  amount,
});

describe("repaidByExpense", () => {
  it("adds up every linked repayment of one bill", () => {
    const repaid = repaidByExpense([link("r1", "bill", 30), link("r2", "bill", 30), link("r3", "other", 12.5)]);
    expect(repaid.get("bill")).toEqual({ amount: 60, count: 2 });
    expect(repaid.get("other")).toEqual({ amount: 12.5, count: 1 });
  });

  it("does not drift over many small repayments", () => {
    const repaid = repaidByExpense(Array.from({ length: 3000 }, (_, i) => link(`r${i}`, "bill", 0.1)));
    expect(repaid.get("bill")?.amount).toBe(300);
  });

  // The analyzers credit nothing for a link whose repayment became a transfer
  // (insights/reimbursements.ts), so the bill's row must not claim it either.
  it("ignores a linked row that is no longer money in", () => {
    expect(repaidByExpense([link("r1", "bill", 30, "TRANSFER")]).has("bill")).toBe(false);
  });
});

describe("repaidFromOutside", () => {
  const rows = [
    { id: "bill", flow: "OUTFLOW" },
    { id: "lunch", flow: "OUTFLOW" },
    { id: "pay", flow: "INFLOW" },
  ];
  const repayments = [link("r1", "bill", 30), link("r2", "bill", 30), link("r3", "lunch", 9)];

  it("counts what came back on the bills in view from rows the list does not show", () => {
    expect(repaidFromOutside(rows, repayments, new Set(["bill", "lunch", "pay"]))).toEqual({ amount: 69, count: 3 });
  });

  it("leaves out a repayment the list already shows, which is in its IN", () => {
    expect(repaidFromOutside(rows, repayments, new Set(["bill", "lunch", "pay", "r1"]))).toEqual({
      amount: 39,
      count: 2,
    });
  });

  it("is nothing for a view with no bills in it", () => {
    expect(repaidFromOutside([{ id: "pay", flow: "INFLOW" }], repayments, new Set(["pay"]))).toEqual({
      amount: 0,
      count: 0,
    });
  });
});

describe("repaidNote", () => {
  it("says what came back and what the bill really cost", () => {
    expect(repaidNote(-90, { amount: 60, count: 2 })).toBe("repaid $60.00 · your share $30.00");
  });

  it("says when a bill was repaid in full", () => {
    expect(repaidNote(-186.4, { amount: 186.4, count: 1 })).toBe("repaid $186.40, in full");
  });

  it("never prints a negative share for a bill repaid past its charge", () => {
    expect(repaidNote(-40, { amount: 44.1, count: 1 })).toBe("repaid $44.10, $4.10 more than the charge");
  });
});

describe("the ledger's net against the analyzers' spending", () => {
  const UTIL = { categoryId: "c-util", categoryName: "Utilities", categoryIsIncome: false };
  const NONE = { categoryId: null, categoryName: null, categoryIsIncome: false };
  const INCOME = { categoryId: "c-income", categoryName: "Income", categoryIsIncome: true };
  const DINING = { categoryId: "c-dine", categoryName: "Dining", categoryIsIncome: false };
  const txn = (
    id: string,
    date: string,
    amount: number,
    flow: TxnData["flow"],
    category: Pick<TxnData, "categoryId" | "categoryName" | "categoryIsIncome">,
    reimbursesId: string | null = null,
  ): TxnData => ({
    id,
    accountId: "checking",
    date: new Date(`${date}T12:00:00Z`),
    amount,
    description: id.toUpperCase(),
    normalizedMerchant: id,
    flow,
    reimbursesId,
    ...category,
  });

  // An internet bill split three ways: one share comes back the same month
  // uncategorized, the other the NEXT month filed as income. Both are linked,
  // so the analyzers credit both to the bill's category and month.
  const txns: TxnData[] = [
    txn("internet", "2026-07-08", -90, "OUTFLOW", UTIL),
    txn("power-share", "2026-07-01", -60, "OUTFLOW", UTIL),
    txn("share-a", "2026-07-14", 30, "INFLOW", NONE, "internet"),
    txn("share-b", "2026-08-02", 30, "INFLOW", INCOME, "internet"),
    txn("deposit-back", "2026-07-20", 5, "INFLOW", UTIL),
    txn("dinner", "2026-07-11", -25, "OUTFLOW", DINING),
  ];
  const july = computeSpendingByCategory(txns, ["2026-07", "2026-08"], "MONTH").get("2026-07");
  const linked = txns.flatMap((t) =>
    t.reimbursesId === null ? [] : [{ id: t.id, reimbursesId: t.reimbursesId, flow: t.flow, amount: t.amount }],
  );
  const viewTotals = (view: TxnData[]) =>
    ledgerTotals(view, repaidFromOutside(view, linked, new Set(view.map((t) => t.id))));

  it("nets a category view to exactly what /trends prints for it", () => {
    const view = txns.filter((t) => t.categoryId === "c-util" && t.date.toISOString().startsWith("2026-07"));
    const totals = viewTotals(view);
    expect(totals.out).toBe(150);
    expect(totals.repaid).toEqual({ amount: 60, count: 2 });
    expect(-totals.net).toBe(july?.categories.find((c) => c.categoryId === "c-util")?.spending);
    expect(-totals.net).toBe(85);
  });

  it("nets a month view to the month's spending when nothing else came in", () => {
    const view = txns.filter((t) => t.date.toISOString().startsWith("2026-07"));
    const totals = viewTotals(view);
    // share-a is in this view, so it is in IN; share-b landed in August.
    expect(totals.repaid).toEqual({ amount: 30, count: 1 });
    expect(-totals.net).toBe(july?.totalSpending);
  });

  it("keeps the page totals adding up to the whole list's", () => {
    const view = txns.filter((t) => t.date.toISOString().startsWith("2026-07"));
    const listed = new Set(view.map((t) => t.id));
    const pages = [view.slice(0, 2), view.slice(2)].map((page) =>
      ledgerTotals(page, repaidFromOutside(page, linked, listed)),
    );
    const whole = viewTotals(view);
    expect(pages.reduce((sum, p) => sum + p.net * 100, 0) / 100).toBe(whole.net);
    expect(pages.reduce((sum, p) => sum + p.repaid.amount, 0)).toBe(whole.repaid.amount);
  });
});
