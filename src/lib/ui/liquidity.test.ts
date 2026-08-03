import { describe, expect, it } from "vitest";
import { computeRunway, countsAsCash, summariseBalances } from "./liquidity";

const acct = (id: string, type: string, balance: number) => ({ id, type, balance });

describe("countsAsCash", () => {
  it("counts a depository account without being told", () => {
    expect(countsAsCash(acct("a", "DEPOSITORY", 100), [])).toBe(true);
  });

  it("does not count an investment account by default", () => {
    expect(countsAsCash(acct("b", "INVESTMENT", 100), [])).toBe(false);
  });

  /**
   * The case the override exists for: a brokerage account holding a
   * money-market balance. It stays INVESTMENT because its balance grows
   * without transactions and net worth needs its snapshots — liquidity and
   * market-valuation are separate questions about the same account.
   */
  it("counts an investment account the operator marked", () => {
    expect(countsAsCash(acct("b", "INVESTMENT", 100), ["b"])).toBe(true);
  });
});

describe("summariseBalances", () => {
  const accounts = [
    acct("chk", "DEPOSITORY", 43143.48),
    acct("mm", "INVESTMENT", 52184.91),
    acct("brk", "INVESTMENT", 511392.72),
    acct("v1", "CREDIT", -1582.43),
    acct("v2", "CREDIT", -88.77),
    acct("v3", "CREDIT", -394.59),
  ];

  it("splits held from owed, leaving debt signed", () => {
    const s = summariseBalances(accounts);
    expect(s.cash).toBe(43143.48);
    expect(s.investments).toBe(563577.63);
    expect(s.debt).toBe(-2065.79);
    expect(s.debtAccounts).toBe(3);
  });

  it("moves a marked account from investments into cash, leaving the total alone", () => {
    const plain = summariseBalances(accounts);
    const marked = summariseBalances(accounts, ["mm"]);
    expect(marked.cash).toBe(95328.39);
    expect(marked.cashAccounts).toBe(2);
    expect(marked.investments).toBe(511392.72);
    // Net worth must not move just because a balance was reclassified.
    expect(marked.cash + marked.investments + marked.debt).toBeCloseTo(
      plain.cash + plain.investments + plain.debt,
      2,
    );
  });

  it("treats a loan as debt, not a negative asset", () => {
    const s = summariseBalances([acct("l", "LOAN", -240000)]);
    expect(s.debt).toBe(-240000);
    expect(s.investments).toBe(0);
  });

  /**
   * The count and the sum come from ONE branch, so they cannot describe
   * different sets. Overview derived the count separately as
   * `!isCash && balance >= 0` and printed "13 accounts" under a figure summing
   * three — its three band notes described ten accounts for eight rows.
   */
  it("counts exactly the accounts it sums into investments", () => {
    const marked = summariseBalances(accounts, ["mm"]);
    expect(marked.investmentAccounts).toBe(1);
    expect(marked.cashAccounts + marked.investmentAccounts + marked.debtAccounts).toBe(
      accounts.length,
    );
  });

  it("keeps a zero-balance card out of investments, and an over-paid one too", () => {
    const s = summariseBalances([
      acct("brk", "INVESTMENT", 511392.72),
      acct("zero", "CREDIT", 0),
      acct("overpaid", "CREDIT", 117.92),
      acct("loan0", "LOAN", 0),
    ]);
    expect(s.investmentAccounts).toBe(1);
    expect(s.investments).toBe(511392.72);
    expect(s.debtAccounts).toBe(3);
  });
});

describe("computeRunway", () => {
  it("divides cash by mean spending and reports the spread", () => {
    const r = computeRunway(43143.48, [6724.16, 7306.97, 8259.92, 13746.27, 7884.92, 8387.38]);
    expect(r?.months).toBe(4.9);
    expect(r?.monthlySpending).toBe(8718.27);
    expect(r?.basisMonths).toBe(6);
    expect(r?.low).toBe(6724.16);
    expect(r?.high).toBe(13746.27);
  });

  it("uses only the last six complete months", () => {
    const r = computeRunway(6000, [99999, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(r?.monthlySpending).toBe(1000);
    expect(r?.months).toBe(6);
  });

  // Refusals: each would otherwise print a number that means nothing.
  it("refuses with too little history to average", () => {
    expect(computeRunway(10000, [1000, 1000])).toBeNull();
  });

  it("refuses when spending nets to zero or below", () => {
    expect(computeRunway(10000, [0, 0, 0])).toBeNull();
    expect(computeRunway(10000, [-50, -20, -30])).toBeNull();
  });

  it("refuses when there is no cash to divide", () => {
    expect(computeRunway(0, [1000, 1000, 1000])).toBeNull();
    expect(computeRunway(-500, [1000, 1000, 1000])).toBeNull();
  });
});
