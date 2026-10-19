import { describe, expect, it } from "vitest";
import type { RecapInput } from "./monthRecap";
import { buildMonthRecap, recapPeriod } from "./monthRecap";

// Invented figures throughout. October 3: the recap is about September.
const NOW = new Date("2026-10-03T15:00:00Z");

const months = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(2026, start + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });

const spendingRow = (period: string, groceries: number, dining: number) => ({
  type: "SPENDING_BY_CATEGORY",
  period,
  dismissed: false,
  payload: {
    granularity: "MONTH",
    totalSpending: groceries + dining,
    previousTotalSpending: null,
    categories: [
      { categoryId: "g", categoryName: "Groceries", spending: groceries, previousSpending: null, deltaPct: null },
      { categoryId: "d", categoryName: "Dining", spending: dining, previousSpending: null, deltaPct: null },
    ],
  },
});

const growthRow = (
  period: string,
  netWorth: number,
  marketGains: number | null,
  extra: { excluded?: string[]; estimated?: string[] } = {},
) => ({
  type: "NET_WORTH_GROWTH",
  period,
  dismissed: false,
  payload: {
    granularity: "MONTH",
    netWorth,
    previousNetWorth: null,
    growthRate: null,
    byAccountType: {},
    marketGains,
    investmentNetFlows: 0,
    estimatedAccountIds: extra.estimated ?? [],
    excludedAccountIds: extra.excluded ?? [],
  },
});

const cashFlowRow = (period: string) => ({
  type: "CASH_FLOW_TREND",
  period,
  dismissed: false,
  payload: {
    granularity: "MONTH",
    income: 5000,
    spending: 3000,
    net: 2000,
    previousIncome: null,
    previousSpending: null,
    previousNet: null,
    incomeDeltaPct: null,
    spendingDeltaPct: null,
  },
});

// March to September: six complete months of spending, the last one the recap's.
const SPENDING = months(2, 7).map((p, i) => spendingRow(p, 1000 + (i === 6 ? 200 : 0), 500 + (i === 6 ? 600 : 0)));
const GROWTH = [
  growthRow("2026-08", 40_000, 100),
  growthRow("2026-09", 42_850, 950),
];

const input = (over: Partial<RecapInput> = {}): RecapInput => ({
  now: NOW,
  rows: [...SPENDING, ...GROWTH],
  accounts: [{ id: "chk", name: "Checking", type: "DEPOSITORY", balance: 6000 }],
  cashAccountIds: new Set(["chk"]),
  firstRecords: [new Date("2025-01-01T00:00:00Z")],
  settings: { netWorthGoal: null, savingsGoals: null, newPay: null },
  ...over,
});

describe("recapPeriod", () => {
  it("speaks on days 1 to 7 about the month before, and is silent from the 8th", () => {
    expect(recapPeriod(new Date("2026-10-01T00:00:00Z"))).toBe("2026-09");
    expect(recapPeriod(new Date("2026-10-07T23:59:59Z"))).toBe("2026-09");
    expect(recapPeriod(new Date("2026-10-08T00:00:00Z"))).toBeNull();
    expect(recapPeriod(new Date("2026-10-18T12:00:00Z"))).toBeNull();
  });

  it("crosses the year boundary", () => {
    expect(recapPeriod(new Date("2027-01-02T00:00:00Z"))).toBe("2026-12");
  });

  it("builds nothing outside the window", () => {
    expect(buildMonthRecap(input({ now: new Date("2026-10-08T00:00:00Z") }))).toBeNull();
  });
});

describe("buildMonthRecap", () => {
  it("spent: the month's total against the middle of the months before it", () => {
    const r = buildMonthRecap(input())!;
    expect(r.period).toBe("2026-09");
    expect(r.monthName).toBe("September");
    // Five prior months at $1,500; September $2,300.
    expect(r.spent).toMatchObject({ total: 2300, typical: 1500, vsTypical: 800, caveat: null });
  });

  it("net worth: saved and markets add to the change, as /trends splits it", () => {
    const r = buildMonthRecap(input())!;
    expect(r.netWorth).toMatchObject({ change: 2850, markets: 950, saved: 1900, joined: 0, caveat: null });
  });

  it("names accounts joining the total apart from saved", () => {
    const r = buildMonthRecap(
      input({
        rows: [...SPENDING, growthRow("2026-08", 40_000, 100, { excluded: ["brk"] }), growthRow("2026-09", 72_850, 950)],
      }),
    )!;
    expect(r.netWorth).toMatchObject({ change: 32_850, markets: 950, joined: 31_900, saved: 0 });
  });

  it("says in text when the month leaves out or estimates an account", () => {
    const r = buildMonthRecap(
      input({
        rows: [
          ...SPENDING,
          growthRow("2026-08", 40_000, 100, { excluded: ["a"] }),
          growthRow("2026-09", 42_850, 950, { excluded: ["a"], estimated: ["b", "c"] }),
        ],
      }),
    )!;
    expect(r.netWorth?.caveat).toBe("1 account left out, 2 balances estimated");
  });

  it("names the category furthest over typical", () => {
    const r = buildMonthRecap(input())!;
    expect(r.moved).toEqual({ category: "Dining", spending: 1100, typical: 500, over: 600 });
  });

  it("never names a queue or a category new this month as the one that moved", () => {
    const row = spendingRow("2026-09", 1000, 500);
    (row.payload.categories as { categoryId: string | null; categoryName: string | null; spending: number; previousSpending: null; deltaPct: null }[]).push(
      { categoryId: null, categoryName: "Uncategorized", spending: 900, previousSpending: null, deltaPct: null },
      { categoryId: "p2p-unreviewed", categoryName: "P2P unreviewed", spending: 800, previousSpending: null, deltaPct: null },
      { categoryId: "n", categoryName: "Pets", spending: 700, previousSpending: null, deltaPct: null },
    );
    const r = buildMonthRecap(input({ rows: [...SPENDING.slice(0, -1), row, ...GROWTH] }))!;
    expect(r.moved).toBeNull();
  });

  it("survives a month the analyzers emitted nothing for", () => {
    const r = buildMonthRecap(input({ rows: [] }))!;
    expect(r).toMatchObject({ spent: null, netWorth: null, goal: null, moved: null });
  });

  it("gives no typical month from fewer than three comparable months", () => {
    const r = buildMonthRecap(input({ rows: [...SPENDING.slice(-3), ...GROWTH] }))!;
    expect(r.spent).toMatchObject({ total: 2300, typical: null, vsTypical: null });
    expect(r.moved).toBeNull();
  });

  it("gives no net worth when the month before has no row", () => {
    const r = buildMonthRecap(input({ rows: [...SPENDING, GROWTH[1]] }))!;
    expect(r.netWorth).toBeNull();
    expect(r.spent).not.toBeNull();
  });

  it("flags a month that accounts had no records for", () => {
    const r = buildMonthRecap(input({ firstRecords: [new Date("2025-01-01T00:00:00Z"), new Date("2026-09-20T00:00:00Z")] }))!;
    expect(r.spent?.caveat).toBe("1 of 2 accounts had no records yet");
  });

  it("the goal column: absent with no goal declared", () => {
    expect(buildMonthRecap(input())!.goal).toBeNull();
  });

  it("the goal column: the first savings goal's landing against its target month", () => {
    const r = buildMonthRecap(
      input({
        rows: [...SPENDING, ...GROWTH, ...months(4, 5).map(cashFlowRow)],
        settings: {
          netWorthGoal: null,
          savingsGoals: JSON.stringify([
            { id: "deposit", name: "Deposit", target: 12_000, targetMonth: "2028-12", cash: true, accountIds: [], monthlyPace: 500 },
          ]),
          newPay: null,
        },
      }),
    )!;
    expect(r.goal).toMatchObject({ name: "Deposit", lands: "Oct 2027", sub: "14 months ahead of target" });
  });

  it("the goal column: the net worth goal's date with its shift against a month before", () => {
    // Saving $1,000 more each month than the one before: the date moves sooner.
    const steps = [1000, 1000, 1000, 1000, 1000, 1000, 2000, 3000];
    let value = 20_000;
    const rows = months(1, 8).map((p, i) => growthRow(p, (value += steps[i]), 0));
    const r = buildMonthRecap(
      input({
        rows: [...SPENDING, ...rows, ...months(1, 8).map(cashFlowRow)],
        settings: { netWorthGoal: JSON.stringify({ target: 100_000 }), savingsGoals: null, newPay: null },
      }),
    )!;
    expect(r.goal?.name).toBe("Net worth goal");
    expect(r.goal?.lands).toMatch(/^[A-Z][a-z]{2} 20\d\d$/);
    expect(r.goal?.sub).toMatch(/sooner$/);
  });
});
