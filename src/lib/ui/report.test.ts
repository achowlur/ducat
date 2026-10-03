import { describe, expect, it } from "vitest";
import type { TransactionFlow } from "../../types/contracts";
import { computeCashFlowTrend } from "../insights/cashFlow";
import { computeSpendingByCategory } from "../insights/spendingByCategory";
import type { TxnData } from "../insights/types";
import { P2P_UNREVIEWED_ID } from "../p2p";
import {
  BAND_MIN_MONTHS,
  buildEntries,
  compare,
  compareSpans,
  exploreSpan,
  groupedSeries,
  ledgerHref,
  MERCHANT_ROWS,
  monthSeries,
  monthSoFar,
  monthsOf,
  type Entry,
} from "./report";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

let nextId = 0;
function txn(partial: Partial<TxnData> & { date: Date; amount: number }): TxnData {
  const flow: TransactionFlow = partial.flow ?? (partial.amount >= 0 ? "INFLOW" : "OUTFLOW");
  return {
    id: partial.id ?? `t${++nextId}`,
    accountId: partial.accountId ?? "acc1",
    description: partial.description ?? "desc",
    normalizedMerchant: partial.normalizedMerchant ?? "merchant",
    categoryId: partial.categoryId ?? null,
    categoryName: partial.categoryName ?? null,
    categoryIsIncome: partial.categoryIsIncome ?? false,
    reimbursesId: partial.reimbursesId ?? null,
    ...partial,
    flow,
  };
}

const CATEGORIES = [
  { categoryId: "cat-dining", categoryName: "Dining" },
  { categoryId: "cat-groceries", categoryName: "Groceries" },
  { categoryId: "cat-rent", categoryName: "Rent & Housing" },
  { categoryId: "cat-travel", categoryName: "Travel" },
];
const SALARY = { categoryId: "cat-salary", categoryName: "Salary", categoryIsIncome: true };
const MERCHANTS = ["corner bistro", "green grocer", "harbor lofts", "sky air", "book barn"];
const ACCOUNTS = ["acc-card", "acc-checking", "acc-card2"];

/**
 * Thirty months of every row shape the analyzers treat differently: plain
 * spending, salary, uncategorized money in, categorized refunds, linked
 * repayments (same month, a later month, more than the bill, against a P2P
 * payment, against a row that is gone, against a row that is not an outflow),
 * unconfirmed P2P both ways, and transfers. Deterministic.
 */
function fixture(): TxnData[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const cents = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
  const rows: TxnData[] = [];
  const outflows: TxnData[] = [];
  for (let m = 0; m < 30; m += 1) {
    const y = 2024 + Math.floor((m + 3) / 12);
    const mo = ((m + 3) % 12) + 1;
    for (let k = 0; k < 14; k += 1) {
      const t = txn({
        date: utc(y, mo, 1 + Math.floor(rand() * 28)),
        amount: -cents(3, 400),
        accountId: pick(ACCOUNTS),
        normalizedMerchant: pick(MERCHANTS),
        ...pick(CATEGORIES),
      });
      rows.push(t);
      outflows.push(t);
    }
    rows.push(txn({ date: utc(y, mo, 15), amount: cents(2000, 2600), accountId: "acc-checking", normalizedMerchant: "acme payroll", ...SALARY }));
    rows.push(txn({ date: utc(y, mo, 20), amount: cents(5, 40), accountId: "acc-checking", normalizedMerchant: "mystery deposit" }));
    rows.push(txn({ date: utc(y, mo, 9), amount: cents(5, 60), accountId: pick(ACCOUNTS), normalizedMerchant: pick(MERCHANTS), ...pick(CATEGORIES) }));
    rows.push(txn({ date: utc(y, mo, 3), amount: -500, flow: "TRANSFER", accountId: "acc-checking", normalizedMerchant: "online transfer" }));
    rows.push(txn({ date: utc(y, mo, 3), amount: 500, flow: "TRANSFER", accountId: "acc-card", normalizedMerchant: "online transfer" }));
    const p2pOut = txn({ date: utc(y, mo, 12), amount: -cents(10, 90), accountId: "acc-checking", normalizedMerchant: "zelle transfer", description: `ZELLE TO PAT ${m % 3} ON 01/02 REF # WFCT0000001A` });
    rows.push(p2pOut);
    rows.push(txn({ date: utc(y, mo, 13), amount: cents(10, 90), accountId: "acc-checking", normalizedMerchant: "zelle transfer", description: `ZELLE FROM SAM ${m % 2} ON 01/03 REF # WFCT0000002B` }));
    if (m % 4 === 1) rows.push(txn({ date: utc(y, mo, 25), amount: cents(5, 40), accountId: "acc-checking", reimbursesId: p2pOut.id, description: "ZELLE FROM PAT", normalizedMerchant: "zelle transfer" }));
    const bill = outflows[outflows.length - 1 - Math.floor(rand() * 10)];
    rows.push(txn({ date: utc(y, mo, 27), amount: Math.round(-bill.amount * (m % 5 === 0 ? 1.4 : 0.5) * 100) / 100, accountId: "acc-checking", reimbursesId: bill.id, normalizedMerchant: "zelle transfer", description: "ZELLE FROM FRIEND" }));
  }
  rows.push(txn({ date: utc(2025, 6, 2), amount: 44.5, reimbursesId: "gone-forever", ...CATEGORIES[0] }));
  const salaryRow = rows.find((t) => t.categoryId === "cat-salary")!;
  rows.push(txn({ date: utc(2025, 7, 2), amount: 12, reimbursesId: salaryRow.id }));
  return rows;
}

const cents = (n: number) => Math.round(n * 100);
const sumBy = (entries: Entry[], keep: (e: Entry) => boolean) => entries.filter(keep).reduce((s, e) => s + e.cents, 0);

describe("buildEntries parity with the analyzers", () => {
  const txns = fixture();
  const entries = buildEntries(txns);
  const months = [...new Set(entries.map((e) => e.month))].sort();
  const byCategory = computeSpendingByCategory(txns, months, "MONTH");
  const cashFlow = computeCashFlowTrend(txns, months, "MONTH");

  it("matches every month's spending total, category by category", () => {
    for (const month of months) {
      const payload = byCategory.get(month)!;
      expect(sumBy(entries, (e) => e.month === month && e.measure === "spending")).toBe(cents(payload.totalSpending));
      for (const c of payload.categories) {
        const got = sumBy(entries, (e) => e.month === month && e.measure === "spending" && e.categoryId === c.categoryId);
        expect(got, `${month} ${c.categoryName}`).toBe(cents(c.spending));
      }
    }
  });

  it("matches every month's income and spending in cash flow", () => {
    for (const month of months) {
      const flow = cashFlow.get(month)!;
      expect(sumBy(entries, (e) => e.month === month && e.measure === "income")).toBe(cents(flow.income));
      expect(sumBy(entries, (e) => e.month === month && e.measure === "spending")).toBe(cents(flow.spending));
    }
  });

  it("files unconfirmed P2P under its own bucket on both sides, and never counts a transfer", () => {
    expect(entries.some((e) => e.measure === "spending" && e.categoryId === P2P_UNREVIEWED_ID)).toBe(true);
    expect(entries.some((e) => e.measure === "income" && e.categoryId === P2P_UNREVIEWED_ID)).toBe(true);
    expect(entries.some((e) => e.merchant === "online transfer")).toBe(false);
  });
});

describe("credits file under the row they net against", () => {
  const bill = txn({ id: "bill", date: utc(2026, 5, 30), amount: -90, accountId: "acc-card", normalizedMerchant: "corner bistro", ...CATEGORIES[0] });
  const back = txn({ date: utc(2026, 6, 2), amount: 60, accountId: "acc-checking", reimbursesId: "bill", normalizedMerchant: "zelle transfer", description: "ZELLE FROM PAT ON 06/02 REF # WFCT0000003C" });
  const entries = buildEntries([bill, back]);

  it("takes the bill's month, category, merchant and account", () => {
    const credit = entries.find((e) => e.cents < 0)!;
    expect(credit).toMatchObject({ month: "2026-05", categoryId: "cat-dining", merchant: "corner bistro", accountId: "acc-card", cents: -6000 });
    expect(entries.filter((e) => e.measure === "income")).toEqual([]);
  });

  it("keys a P2P row on its payee, not on the rail", () => {
    const [a, b] = buildEntries([
      txn({ date: utc(2026, 6, 3), amount: -20, normalizedMerchant: "zelle transfer", description: "ZELLE TO ROBIN FAIR ON 06/03 REF # WFCT0000004D", categoryId: "cat-dining", categoryName: "Dining" }),
      txn({ date: utc(2026, 6, 4), amount: -25, normalizedMerchant: "zelle transfer", description: "ZELLE TO LEE PARK ON 06/04 REF # WFCT0000005E", categoryId: "cat-dining", categoryName: "Dining" }),
    ]);
    expect(a.merchant).not.toBe(b.merchant);
    expect(a.merchant).toContain("robin fair");
    expect(a.merchantName).toContain("Robin Fair");
  });
});

describe("compareSpans", () => {
  const oct3 = utc(2026, 10, 3);
  it("compares complete months only", () => {
    expect(compareSpans("12m", oct3)).toEqual({ current: { from: "2025-10", to: "2026-09" }, prior: { from: "2024-10", to: "2025-09" }, throughDay: null });
    expect(compareSpans("3m", oct3)).toEqual({ current: { from: "2026-07", to: "2026-09" }, prior: { from: "2026-04", to: "2026-06" }, throughDay: null });
    expect(compareSpans("1m", oct3)).toEqual({ current: { from: "2026-09", to: "2026-09" }, prior: { from: "2026-08", to: "2026-08" }, throughDay: null });
    expect(compareSpans("ytd", oct3)).toEqual({ current: { from: "2026-01", to: "2026-09" }, prior: { from: "2025-01", to: "2025-09" }, throughDay: null });
  });

  it("sets this month so far against the SAME days of last month", () => {
    expect(compareSpans("mtd", oct3)).toEqual({ current: { from: "2026-10", to: "2026-10" }, prior: { from: "2026-09", to: "2026-09" }, throughDay: 3 });
  });

  it("compares the whole of last year while January is under way", () => {
    expect(compareSpans("ytd", utc(2027, 1, 20))).toEqual({ current: { from: "2026-01", to: "2026-12" }, prior: { from: "2025-01", to: "2025-12" }, throughDay: null });
  });
});

describe("compare", () => {
  const txns = fixture();
  const entries = buildEntries(txns);
  const names = new Map(ACCOUNTS.map((a) => [a, a.toUpperCase()]));
  const spans = compareSpans("12m", utc(2026, 9, 10));

  it.each(["category", "merchant", "account"] as const)("rows add up to the total, by %s", (by) => {
    for (const measure of ["spending", "income"] as const) {
      const c = compare(entries, measure, by, spans, names);
      const rows = c.rows.reduce((s, r) => s + cents(r.change), 0) + cents(c.rest?.change ?? 0);
      expect(rows).toBe(cents(c.total.change));
      expect(c.rows.reduce((s, r) => s + cents(r.current), 0) + cents(c.rest?.current ?? 0)).toBe(cents(c.total.current));
      expect(cents(c.total.current) - cents(c.total.prior)).toBe(cents(c.total.change));
    }
  });

  it("prints the same twelve-month total the months add up to", () => {
    const c = compare(entries, "spending", "category", spans, names);
    const months = new Set(monthsOf(spans.current));
    expect(cents(c.total.current)).toBe(sumBy(entries, (e) => e.measure === "spending" && months.has(e.month)));
  });

  it("names the merchants that moved most and sums the rest into one row", () => {
    const many = buildEntries(
      Array.from({ length: 40 }, (_, i) =>
        txn({ date: utc(2026, 8, 5), amount: -(i + 1), normalizedMerchant: `shop ${String(i).padStart(2, "0")}`, ...CATEGORIES[1] }),
      ),
    );
    const c = compare(many, "spending", "merchant", compareSpans("1m", utc(2026, 9, 2)), names);
    expect(c.rows).toHaveLength(MERCHANT_ROWS);
    expect(c.rows[0].label).toBe("Shop 39");
    expect(c.rest?.count).toBe(40 - MERCHANT_ROWS);
  });

  it("puts what moved most first, either way, and links each row to its own rows over the current span", () => {
    const c = compare(entries, "spending", "category", spans, names);
    for (let i = 1; i < c.rows.length; i += 1) {
      expect(Math.abs(c.rows[i - 1].change)).toBeGreaterThanOrEqual(Math.abs(c.rows[i].change));
    }
    expect(c.rows[0].href).toMatch(/^\/transactions\?period=2025-09\.\.2026-08&category=/);
  });

  it("stops both months at the same day for this month so far", () => {
    const rows = buildEntries([
      txn({ date: utc(2026, 10, 2), amount: -30, ...CATEGORIES[1] }),
      txn({ date: utc(2026, 9, 1), amount: -10, ...CATEGORIES[1] }),
      txn({ date: utc(2026, 9, 3), amount: -5, ...CATEGORIES[1] }),
      txn({ date: utc(2026, 9, 4), amount: -500, ...CATEGORIES[1] }),
    ]);
    const c = compare(rows, "spending", "category", compareSpans("mtd", utc(2026, 10, 3)), names);
    expect(c.total).toEqual({ current: 30, prior: 15, change: 15 });
  });

  it("counts the prior months that hold no records", () => {
    const c = compare(entries, "spending", "category", compareSpans("12m", utc(2025, 6, 1)), names);
    // The fixture starts 2024-04; the prior span runs 2023-06 to 2024-05.
    expect(c.priorMonthsMissing).toBe(10);
  });
});

describe("monthSoFar", () => {
  const spend = (y: number, m: number, d: number, amount: number) =>
    txn({ date: utc(y, m, d), amount: -amount, ...CATEGORIES[1] });

  it("runs this month to today and last month across the whole axis", () => {
    const entries = buildEntries([spend(2026, 10, 1, 10), spend(2026, 10, 3, 5), spend(2026, 9, 2, 7), spend(2026, 9, 30, 3)]);
    const a = monthSoFar(entries, utc(2026, 10, 3));
    expect(a).toMatchObject({ month: "2026-10", previous: "2026-09", today: 3, days: 31 });
    expect(a.current).toEqual([10, 10, 15]);
    expect(a.currentDaily).toEqual([10, 0, 5]);
    expect(a.last).toHaveLength(31);
    expect(a.last[1]).toBe(7);
    // September has 30 days: its line runs flat across October's 31st.
    expect(a.last[29]).toBe(10);
    expect(a.last[30]).toBe(10);
  });

  it("draws the middle half of the recent months, and no band from too few", () => {
    const months = [7, 8, 9];
    const rows = months.map((m, i) => spend(2026, m, 1, (i + 1) * 100));
    const a = monthSoFar(buildEntries(rows), utc(2026, 10, 3));
    expect(a.band?.months).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(a.band?.low[0]).toBe(150);
    expect(a.band?.high[0]).toBe(250);
    const thin = monthSoFar(buildEntries(rows.slice(0, BAND_MIN_MONTHS - 1)), utc(2026, 10, 3));
    expect(thin.band).toBeNull();
  });

  it("survives an empty ledger", () => {
    const a = monthSoFar([], utc(2026, 10, 3));
    expect(a.current).toEqual([0, 0, 0]);
    expect(a.band).toBeNull();
  });
});

describe("exploreSpan", () => {
  const now = utc(2026, 10, 3);
  it("covers one month when asked: the one being lived in, the last complete one, or one named outright", () => {
    expect(exploreSpan("month", now, "2024-06")).toEqual({ from: "2026-10", to: "2026-10" });
    expect(exploreSpan("lastmonth", now, "2024-06")).toEqual({ from: "2026-09", to: "2026-09" });
    expect(exploreSpan("2026-07", now, "2024-06")).toEqual({ from: "2026-07", to: "2026-07" });
    expect(exploreSpan("2026-11", now, "2024-06")).toBeNull();
    expect(exploreSpan("2023-01", now, "2024-06")).toBeNull();
    expect(exploreSpan("nonsense", now, "2024-06")).toBeNull();
  });

  it("clamps to the first recorded month and stops at the last complete one", () => {
    expect(exploreSpan("12m", now, "2026-02")).toEqual({ from: "2026-02", to: "2026-09" });
    expect(exploreSpan("all", now, "2024-06")).toEqual({ from: "2024-06", to: "2026-09" });
    expect(exploreSpan("lastyear", now, "2024-06")).toEqual({ from: "2025-01", to: "2025-12" });
    expect(exploreSpan("lastyear", utc(2027, 1, 9), "2024-06")).toEqual({ from: "2026-01", to: "2026-12" });
    expect(exploreSpan("12m", now, null)).toBeNull();
    expect(exploreSpan("lastyear", now, "2026-03")).toBeNull();
  });
});

describe("groupedSeries and monthSeries", () => {
  const txns = fixture();
  const entries = buildEntries(txns);
  const names = new Map(ACCOUNTS.map((a) => [a, a.toUpperCase()]));
  const span = { from: "2025-01", to: "2025-12" };

  it("groups add up to the total, and the drawn lines plus the rest add up month by month", () => {
    for (const by of ["category", "merchant", "account"] as const) {
      const g = groupedSeries(entries, "spending", by, span, null, names);
      expect(g.groups.reduce((s, x) => s + cents(x.total), 0)).toBe(cents(g.total));
      g.months.forEach((_, i) => {
        const drawn = g.lines.reduce((s, l) => s + cents(l.byMonth[i]), 0) + cents(g.restByMonth?.[i] ?? 0);
        expect(drawn).toBe(cents(g.totalByMonth[i]));
      });
    }
  });

  it("applies a filter, and links a row to the filter AND its group", () => {
    const g = groupedSeries(entries, "spending", "category", span, { by: "account", key: "acc-card" }, names);
    const only = sumBy(entries, (e) => e.measure === "spending" && e.accountId === "acc-card" && e.month >= "2025-01" && e.month <= "2025-12");
    expect(cents(g.total)).toBe(only);
    expect(g.groups[0].href).toMatch(/account=acc-card/);
    expect(g.groups[0].href).toMatch(/category=/);
  });

  it("gives one category over time the same months the grouped view sums", () => {
    const s = monthSeries(entries, ["spending"], span, { by: "category", key: "cat-dining" });
    const g = groupedSeries(entries, "spending", "category", span, null, names);
    const dining = g.groups.find((x) => x.key === "cat-dining")!;
    expect(s.values.spending!.reduce((a, v) => a + cents(v), 0)).toBe(cents(dining.total));
    expect(s.href.spending).toBe("/transactions?period=2025-01..2025-12&category=cat-dining");
  });
});

describe("ledgerHref", () => {
  it("opens one month by its key, money in only for income", () => {
    expect(ledgerHref([{ by: "merchant", key: "corner bistro" }], { from: "2026-09", to: "2026-09" }, "income")).toBe(
      "/transactions?period=2026-09&merchant=corner+bistro&flow=INFLOW",
    );
  });
});
