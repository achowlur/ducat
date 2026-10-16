import { describe, expect, it } from "vitest";
import {
  addMonths,
  assessNetWorthGoal,
  NET_WORTH_PACE_MIN_MONTHS,
  parseNetWorthGoal,
  type NetWorthMonth,
} from "./netWorthGoal";

// Invented figures throughout.

/**
 * `count` complete months ending at `last`, net worth rising by `saved` plus
 * `markets` each month from `start`; every month splits as invested 60%,
 * the cash-counted account 10%, the rest 30%.
 */
function history(opts: {
  count: number;
  last: string;
  start: number;
  saved: number | ((i: number) => number);
  markets?: number;
  leftOut?: (i: number) => string[];
  byAccount?: boolean;
  /** Money into each investment account that month; none by default, null for rows predating it. */
  flows?: (i: number) => Record<string, number> | null;
}): NetWorthMonth[] {
  const months: NetWorthMonth[] = [];
  let value = opts.start;
  for (let i = 0; i < opts.count; i += 1) {
    const saved = typeof opts.saved === "number" ? opts.saved : opts.saved(i);
    const markets = opts.markets ?? 0;
    if (i > 0) value += saved + markets;
    months.push({
      period: addMonths(opts.last, i - (opts.count - 1)),
      value,
      estimated: false,
      leftOut: opts.leftOut?.(i) ?? [],
      marketGains: i === 0 ? null : markets,
      byAccount:
        opts.byAccount === false
          ? null
          : { invested: value * 0.6, cashInvested: value * 0.1, checking: value * 0.3 },
      flowsByAccount: opts.flows === undefined ? {} : opts.flows(i),
    });
  }
  return months;
}

const investedIds = new Set(["invested"]);

describe("parseNetWorthGoal", () => {
  it("reads a goal with and without a typed return", () => {
    expect(parseNetWorthGoal('{"target":250000}')).toEqual({ target: 250000 });
    expect(parseNetWorthGoal('{"target":250000,"realReturnPct":4.5,"returnSetOn":"2026-03-02"}')).toEqual({
      target: 250000,
      realReturnPct: 4.5,
      returnSetOn: "2026-03-02",
    });
  });

  it("refuses what it cannot trust, without throwing", () => {
    expect(parseNetWorthGoal(null)).toBeNull();
    expect(parseNetWorthGoal("not json")).toBeNull();
    expect(parseNetWorthGoal('{"target":0}')).toBeNull();
    expect(parseNetWorthGoal('{"target":250000,"realReturnPct":0}')).toBeNull();
    expect(parseNetWorthGoal('{"target":250000,"realReturnPct":22}')).toBeNull();
    expect(parseNetWorthGoal('{"target":250000,"returnSetOn":"March"}')).toBeNull();
  });
});

describe("assessNetWorthGoal", () => {
  it("measures the pace as SAVED alone, the markets' part left out, as /trends splits it", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 1000, markets: 500 });
    const g = assessNetWorthGoal({ goal: { target: 250000 }, liveNetWorth: 101000, months, investedIds });
    expect(g.pace).toBe(1000);
    expect(g.paceMonths).toBe(12);
    expect(g.anchor).toBe("2026-09");
  });

  it("projects by saving alone from the anchor month-end, in whole months", () => {
    // Anchor value 80,000 + 13 × 1,000 = 93,000; 12 more months reach 105,000.
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 1000 });
    const g = assessNetWorthGoal({ goal: { target: 105000 }, liveNetWorth: 93400, months, investedIds });
    expect(g.saving?.lands).toBe("2027-09");
    expect(g.markets).toBeNull(); // no return typed
  });

  it("adds a typed return to invested money only, never to an account counted as cash", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 0 });
    const g = assessNetWorthGoal({ goal: { target: 81900, realReturnPct: 5 }, liveNetWorth: 80000, months, investedIds });
    expect(g.invested).toBe(48000); // 60% of 80,000; the cash-counted 10% is not invested
    // 32,000 level + 48,000 compounding at 5% a year: the 1,900 it needs
    // takes about nine and a half months, so it lands in the tenth.
    expect(g.markets?.lands).toBe("2027-07");
    // Saving alone, at a pace of zero, never gets there.
    expect(g.saving?.lands).toBeNull();
  });

  it("takes a TYPICAL month's investing, so a lump sum of any size cannot pass for a habit", () => {
    const months = history({
      count: 14,
      last: "2026-09",
      start: 80000,
      saved: 1000,
      // 400 a month into invested money; one month also moves 30,000 in, and
      // the account counted as cash takes 250 a month that is not investing.
      flows: (i) => ({ invested: i === 7 ? 30400 : 400, cashInvested: 250 }),
    });
    const g = assessNetWorthGoal({ goal: { target: 250000, realReturnPct: 5 }, liveNetWorth: 93000, months, investedIds });
    expect(g.contribution).toBe(400);
  });

  it("compounds that contribution, so the markets date comes sooner than with savings as cash", () => {
    const base = { count: 14, last: "2026-09", start: 80000, saved: 1000 };
    const goal = { target: 250000, realReturnPct: 5 };
    const asCash = assessNetWorthGoal({ goal, liveNetWorth: 93000, months: history(base), investedIds });
    const invested = assessNetWorthGoal({
      goal,
      liveNetWorth: 93000,
      months: history({ ...base, flows: () => ({ invested: 800 }) }),
      investedIds,
    });
    expect(asCash.contribution).toBe(0);
    expect(invested.markets!.lands! < asCash.markets!.lands!).toBe(true);
    // By saving alone the split cannot matter.
    expect(invested.saving?.lands).toBe(asCash.saving?.lands);
  });

  it("counts savings as cash when the rows predate per-account flows", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 1000, flows: () => null });
    const g = assessNetWorthGoal({ goal: { target: 250000, realReturnPct: 5 }, liveNetWorth: 93000, months, investedIds });
    expect(g.contribution).toBeNull();
    expect(g.markets?.lands).not.toBeNull();
  });

  it("says how far each date moved since the month-end before, and what the pace was", () => {
    // The newest month saved far more than the one that left the window.
    const months = history({ count: 15, last: "2026-09", start: 80000, saved: (i) => (i === 14 ? 7000 : 1000) });
    const g = assessNetWorthGoal({ goal: { target: 150000 }, liveNetWorth: 101000, months, investedIds });
    expect(g.previousPace).toBe(1000);
    expect(g.pace).toBe(1500);
    expect(g.saving?.shift).toBeLessThan(0); // sooner
  });

  it("never measures the pace across a change in which accounts are counted", () => {
    // The first five months leave an account out: an account entering the sum is not saving.
    const months = history({
      count: 14,
      last: "2026-09",
      start: 80000,
      saved: 1000,
      leftOut: (i) => (i < 5 ? ["late-card"] : []),
    });
    const g = assessNetWorthGoal({ goal: { target: 250000 }, liveNetWorth: 95000, months, investedIds });
    expect(g.paceMonths).toBe(8);
  });

  it(`refuses a date with fewer than ${NET_WORTH_PACE_MIN_MONTHS} months behind it, and keeps the progress`, () => {
    const months = history({ count: NET_WORTH_PACE_MIN_MONTHS, last: "2026-09", start: 80000, saved: 1000 });
    const g = assessNetWorthGoal({ goal: { target: 160000 }, liveNetWorth: 86000, months, investedIds });
    expect(g.refusal).toBe("TOO_FEW_MONTHS");
    expect(g.saving).toBeNull();
    expect(g.progress).toBeCloseTo(86000 / 160000);
  });

  it("is reached on the live figure, and projects nothing then", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 1000 });
    const g = assessNetWorthGoal({ goal: { target: 90000, realReturnPct: 5 }, liveNetWorth: 90500, months, investedIds });
    expect(g.reached).toBe(true);
    expect(g.progress).toBe(1);
    expect(g.saving).toBeNull();
  });

  it("prints no markets date from rows that predate per-account values", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 1000, byAccount: false });
    const g = assessNetWorthGoal({ goal: { target: 250000, realReturnPct: 5 }, liveNetWorth: 93000, months, investedIds });
    expect(g.invested).toBeNull();
    expect(g.markets).toBeNull();
    expect(g.saving?.lands).not.toBeNull();
  });

  it("gives no date past fifty years", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 10 });
    const g = assessNetWorthGoal({ goal: { target: 900000 }, liveNetWorth: 80130, months, investedIds });
    expect(g.saving?.lands).toBeNull();
  });
});
