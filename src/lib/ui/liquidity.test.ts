import { describe, expect, it } from "vitest";
import { debtNote, computeRunway, countsAsCash, summariseBalances } from "./liquidity";

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
  it("divides cash by a typical month, the middle, and reports the spread", () => {
    const r = computeRunway(43143.48, [6724.16, 7306.97, 8259.92, 13746.27, 7884.92, 8387.38]);
    expect(r?.months).toBe(5.3);
    expect(r?.monthlySpending).toBe(8072.42);
    expect(r?.basisMonths).toBe(6);
    expect(r?.low).toBe(6724.16);
    expect(r?.high).toBe(13746.27);
  });

  it("uses only the last six complete months", () => {
    const r = computeRunway(6000, [99999, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(r?.monthlySpending).toBe(1000);
    expect(r?.months).toBe(6);
  });

  // Invented: five ordinary months and one holding a trip and a new laptop.
  // A mean counted a sixth of them as every month's spending.
  it("is not moved by one heavy or one odd month", () => {
    const steady = [2000, 2100, 1900, 2050, 1950];
    expect(computeRunway(20000, [...steady, 2000])?.monthlySpending).toBe(2000);
    expect(computeRunway(20000, [...steady, 9000])?.monthlySpending).toBe(2025);
    expect(computeRunway(20000, [...steady, -1200])?.monthlySpending).toBe(1975);
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

describe("cards", () => {
  it("sums the cards' balances alone, loans left out, signed like debt", () => {
    const s = summariseBalances([acct("chk", "DEPOSITORY", 5000), acct("visa", "CREDIT", -640.12), acct("amex", "CREDIT", -59.88), acct("auto", "LOAN", -8300)]);
    expect(s.cards).toBe(-700);
    expect(s.debt).toBe(-9000);
  });
});

describe("debtNote", () => {
  it("names cards and loans apart — an auto loan is not a card", () => {
    const s = summariseBalances([acct("visa", "CREDIT", -640.12), acct("auto", "LOAN", -8300)]);
    expect(s.loanAccounts).toBe(1);
    expect(debtNote(s.debtAccounts, s.loanAccounts)).toBe("1 card · 1 loan");
  });

  it("leaves out a kind there are none of, and pluralises the rest", () => {
    expect(debtNote(3, 0)).toBe("3 cards");
    expect(debtNote(2, 2)).toBe("2 loans");
  });
});

describe("computeRunway: travel and one-offs spread, never dropped", () => {
  it("adds their monthly average to the middle of the everyday months", async () => {
    const { computeRunway } = await import("./liquidity");
    const r = computeRunway(24_000, [2_000, 2_100, 1_900, 2_000, 2_050, 1_950], 400);
    expect(r).toMatchObject({ monthlySpending: 2_400, lumpy: 400, months: 10, low: 1_900, high: 2_100 });
  });
  it("is the everyday figure alone with nothing lumpy, and never lowered by a negative one", async () => {
    const { computeRunway } = await import("./liquidity");
    expect(computeRunway(20_000, [2_000, 2_000, 2_000])).toMatchObject({ monthlySpending: 2_000, lumpy: 0 });
    expect(computeRunway(20_000, [2_000, 2_000, 2_000], -300)).toMatchObject({ monthlySpending: 2_000, lumpy: 0 });
  });
});
