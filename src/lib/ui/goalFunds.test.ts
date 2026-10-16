import { describe, expect, it } from "vitest";
import { fundGrowthOver, fundHistory, fundValue, type MonthByAccount } from "./goalFunds";

// Invented figures throughout.
const months: MonthByAccount[] = [
  { period: "2026-01", byAccount: null }, // stored before per-account values
  { period: "2026-02", byAccount: { checking: 3000, brokerage: 90000 } },
  { period: "2026-03", byAccount: { checking: 3400, moneyMarket: 10000, brokerage: 91000 } },
  { period: "2026-04", byAccount: { checking: 3100, moneyMarket: 11000, brokerage: 95000 } },
  { period: "2026-05", byAccount: { checking: 3600, moneyMarket: 12200, brokerage: 93000 } },
];
const fund = ["checking", "moneyMarket"];

describe("fundValue", () => {
  it("sums the fund's own accounts, nothing else, an absent one counting nothing", () => {
    expect(fundValue(months[1], fund)).toBe(3000);
    expect(fundValue(months[4], fund)).toBe(15800);
  });
});

describe("fundHistory", () => {
  it("keeps the last few month-ends that carry per-account values, oldest first", () => {
    expect(fundHistory(months, fund, 3)).toEqual([
      { period: "2026-03", value: 13400 },
      { period: "2026-04", value: 14100 },
      { period: "2026-05", value: 15800 },
    ]);
    expect(fundHistory(months, fund, 10).map((m) => m.period)).toEqual(["2026-02", "2026-03", "2026-04", "2026-05"]);
  });
});

describe("fundGrowthOver", () => {
  // The money-market account books trades and sweeps as rows; none of that
  // can move a growth read from month-end balances.
  it("is the month-end before the window to its last, per month, from balances", () => {
    expect(fundGrowthOver(months, fund, ["2026-04", "2026-05"])).toBe((15800 - 13400) / 2);
  });

  it("says nothing when either end predates per-account values", () => {
    expect(fundGrowthOver(months, fund, ["2026-02", "2026-03"])).toBeNull();
    expect(fundGrowthOver(months, fund, [])).toBeNull();
  });
});
