import { describe, expect, it } from "vitest";
import {
  addMonths,
  assessNetWorthGoal,
  NET_WORTH_PACE_MIN_MONTHS,
  NET_WORTH_PACE_MONTHS,
  goalPath,
  idleCashAt,
  withCashMoved,
  nextNetWorthGoal,
  parseNetWorthGoal,
  projectGoal,
  returnToSlider,
  sliderToReturn,
  keepingUp,
  withSaving,
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
  /** Interest each account was paid that month; absent by default (rows predating it). */
  interest?: (i: number) => Record<string, number> | null;
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
      ...(opts.interest === undefined ? {} : { interestByAccount: opts.interest(i) }),
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
    expect(parseNetWorthGoal('{"target":250000,"realReturnPct":120}')).toBeNull();
    expect(parseNetWorthGoal('{"target":250000,"returnSetOn":"March"}')).toBeNull();
  });
});

describe("assessNetWorthGoal", () => {
  it("measures the pace as SAVED alone, the markets' part left out, as /trends splits it", () => {
    const months = history({ count: 14, last: "2026-09", start: 80000, saved: 1000, markets: 500 });
    const g = assessNetWorthGoal({ goal: { target: 250000 }, liveNetWorth: 101000, months, investedIds });
    expect(g.pace).toBe(1000);
    expect(g.paceMonths).toBe(NET_WORTH_PACE_MONTHS);
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

  const deposits = (flows: (i: number) => Record<string, number>) =>
    assessNetWorthGoal({
      goal: { target: 250000, realReturnPct: 5 },
      liveNetWorth: 93000,
      months: history({ count: 14, last: "2026-09", start: 80000, saved: 1000, flows }),
      investedIds,
    });

  it("never lets a lump sum pass for a habit, and names the month that did not match", () => {
    // 400 a month into invested money; the newest month also moves 30,000 in,
    // and the account counted as cash takes 250 a month that is not investing.
    const g = deposits((i) => ({ invested: i === 13 ? 30400 : 400, cashInvested: 250 }));
    expect(g.contribution).toBe(400);
    expect(g.unmatchedDeposit).toBe(30400);
  });

  it("counts a RAISE once it repeats, and says what the deposit was before", () => {
    const first = deposits((i) => ({ invested: i === 13 ? 700 : 400 }));
    expect(first.contribution).toBe(400); // one month is not a pattern
    expect(first.unmatchedDeposit).toBe(700); // but it is not silent either
    const repeated = deposits((i) => ({ invested: i >= 12 ? 700 : 400 }));
    expect(repeated.contribution).toBe(700);
    expect(repeated.previousContribution).toBe(400);
    expect(repeated.unmatchedDeposit).toBeNull();
  });

  it("carries a deposit that slipped into the next month, rather than reading a skip and a double", () => {
    // The usual deposit lands on the 31st one month and the 1st the next.
    const g = deposits((i) => ({ invested: i === 12 ? 0 : i === 13 ? 800 : 400 }));
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
    expect(g.pace).toBe(2000);
    expect(g.saving?.shift).toBeLessThan(0); // sooner
  });

  it("never measures the pace across a change in which accounts are counted", () => {
    // The first nine months leave an account out: an account entering the sum is not saving.
    const months = history({
      count: 14,
      last: "2026-09",
      start: 80000,
      saved: 1000,
      leftOut: (i) => (i < 9 ? ["late-card"] : []),
    });
    const g = assessNetWorthGoal({ goal: { target: 250000 }, liveNetWorth: 95000, months, investedIds });
    expect(g.paceMonths).toBe(4);
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

describe('projectGoal, as the panel re-projects while its controls move', () => {
  const months = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
  const g = assessNetWorthGoal({ goal: { target: 150000 }, liveNetWorth: 94000, months, investedIds });

  it("gives the server's dates for the same target and return", () => {
    expect(projectGoal(g.basis!, g.previousBasis, 150000, undefined)).toEqual({ saving: g.saving, markets: null });
  });

  it('shows no markets date at a return of zero, and an earlier one as the return rises', () => {
    expect(projectGoal(g.basis!, g.previousBasis, 150000, 0).markets).toBeNull();
    const four = projectGoal(g.basis!, g.previousBasis, 150000, 4).markets!.lands!;
    const seven = projectGoal(g.basis!, g.previousBasis, 150000, 7).markets!.lands!;
    expect(seven <= four).toBe(true);
  });

  // The shift compares the SAME target and return a month apart: moving a
  // control must never read as the data moving.
  it('measures the shift at the target and return on screen', () => {
    const near = projectGoal(g.basis!, g.previousBasis, 120000, 5);
    const far = projectGoal(g.basis!, g.previousBasis, 400000, 5);
    // A steady pace lands on the same month from either month-end, whatever
    // target the control is set to: the data did not move, so neither does the date.
    expect(near.saving.shift).toBe(0);
    expect(far.saving.shift).toBe(0);
  });
});

describe('nextNetWorthGoal, what a save from the panel writes', () => {
  const stored = { target: 1000000, realReturnPct: 5, returnSetOn: '2026-03-02' };

  it('keeps the day a return was set while only the target moves', () => {
    expect(nextNetWorthGoal(stored, { target: 750000, realReturnPct: 5, monthlyInvest: null, monthlyPace: null }, '2026-10-16')).toEqual({
      ok: true,
      goal: { target: 750000, realReturnPct: 5, returnSetOn: '2026-03-02' },
    });
  });

  it('dates a changed return today, and clears it at zero', () => {
    expect(nextNetWorthGoal(stored, { target: 1000000, realReturnPct: 6.5, monthlyInvest: null, monthlyPace: null }, '2026-10-16')).toEqual({
      ok: true,
      goal: { target: 1000000, realReturnPct: 6.5, returnSetOn: '2026-10-16' },
    });
    expect(nextNetWorthGoal(stored, { target: 1000000, realReturnPct: 0, monthlyInvest: null, monthlyPace: null }, '2026-10-16')).toEqual({
      ok: true,
      goal: { target: 1000000 },
    });
  });

  it('stores a monthly amount the operator sets, with or without a return, and clears it on null', () => {
    expect(nextNetWorthGoal(stored, { target: 1000000, realReturnPct: 5, monthlyInvest: 2000, monthlyPace: null }, '2026-10-16')).toEqual({
      ok: true,
      goal: { target: 1000000, realReturnPct: 5, returnSetOn: '2026-03-02', monthlyInvest: 2000 },
    });
    expect(nextNetWorthGoal(stored, { target: 1000000, realReturnPct: 0, monthlyInvest: 0, monthlyPace: null }, '2026-10-16')).toEqual({
      ok: true,
      goal: { target: 1000000, monthlyInvest: 0 },
    });
    const set = { ...stored, monthlyInvest: 2000 };
    expect(nextNetWorthGoal(set, { target: 1000000, realReturnPct: 5, monthlyInvest: null, monthlyPace: null }, '2026-10-16')).toEqual({
      ok: true,
      goal: stored,
    });
  });

  it('reads back what it writes, and refuses a stored amount it cannot use', () => {
    const goal = { target: 1000000, realReturnPct: 5, returnSetOn: '2026-03-02', monthlyInvest: 1500 };
    expect(parseNetWorthGoal(JSON.stringify(goal))).toEqual(goal);
    expect(parseNetWorthGoal(JSON.stringify({ ...goal, monthlyInvest: -1 }))).toBeNull();
    expect(parseNetWorthGoal(JSON.stringify({ ...goal, monthlyInvest: '1500' }))).toBeNull();
  });

  it('refuses what it cannot project, with a sentence for the person', () => {
    for (const input of [
      { target: 0, realReturnPct: 5, monthlyInvest: null, monthlyPace: null },
      { target: Number.NaN, realReturnPct: 5, monthlyInvest: null, monthlyPace: null },
      { target: 1000000, realReturnPct: -1, monthlyInvest: null, monthlyPace: null },
      { target: 1000000, realReturnPct: 120, monthlyInvest: null, monthlyPace: null },
      { target: 1000000, realReturnPct: 5, monthlyInvest: -50, monthlyPace: null },
      { target: 1000000, realReturnPct: 5, monthlyInvest: Number.NaN, monthlyPace: null },
    ]) {
      const r = nextNetWorthGoal(stored, input, '2026-10-16');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

describe('a monthly amount the operator sets', () => {
  // Measured: $1,000 saved a month, $400 of it into invested money.
  const months = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
  const g = assessNetWorthGoal({ goal: { target: 300000, realReturnPct: 5 }, liveNetWorth: 94000, months, investedIds });

  // The saving is the total; the investing only splits it. Clearing the
  // investing to $0 once read as saving the whole deposit less every month.
  it('splits the same saving, never changing the total', () => {
    expect(g.basis!.contribution).toBe(400);
    const more = withSaving(g.basis!, { monthlyInvest: 900 });
    expect(more).toMatchObject({ contribution: 900, pace: g.basis!.pace });
    expect(withSaving(g.basis!, { monthlyInvest: 0 }).pace).toBe(g.basis!.pace);
    expect(withSaving(g.basis!, {})).toBe(g.basis);
  });

  it('moves the markets date with the split, leaves saving alone, and the server agrees with the panel', () => {
    const set = assessNetWorthGoal({
      goal: { target: 300000, realReturnPct: 5, monthlyInvest: 900 },
      liveNetWorth: 94000,
      months,
      investedIds,
    });
    expect(set.saving!.lands).toBe(g.saving!.lands);
    expect(set.markets!.lands! < g.markets!.lands!).toBe(true);
    // The figures the working-out prints stay the measured ones.
    expect(set.contribution).toBe(400);
    expect(set.pace).toBe(g.pace);
    const panel = projectGoal(
      withSaving(set.basis!, { monthlyInvest: 900 }),
      withSaving(set.previousBasis!, { monthlyInvest: 900 }),
      300000,
      5,
    );
    expect(panel).toEqual({ saving: set.saving, markets: set.markets });
  });

  // The shift still says what the DATA did: the same amount applies a month apart.
  it('leaves a steady history unshifted', () => {
    const set = assessNetWorthGoal({
      goal: { target: 300000, realReturnPct: 5, monthlyInvest: 1400 },
      liveNetWorth: 94000,
      months,
      investedIds,
    });
    expect(set.saving!.shift).toBe(0);
  });
});

describe('one-off pay', () => {
  // Invented: $1,000 saved a month, and two $3,000 bonuses inside the year.
  const months = history({ count: 15, last: '2026-09', start: 80000, saved: (i) => (i === 10 || i === 12 ? 4000 : 1000) });
  const bonuses = {
    [months[10].period]: [{ date: `${months[10].period}-21`, amount: 3000, payer: 'harbor works payroll' }],
    [months[12].period]: [{ date: `${months[12].period}-18`, amount: 3000, payer: 'harbor works payroll' }],
  };

  it('is left out of the pace, and named', () => {
    const counted = assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months, investedIds });
    const left = assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months, investedIds, oneOffs: bonuses });
    expect(counted.pace).toBe(2000);
    expect(left.pace).toBe(1000);
    expect(left.paceLeavesOut.map((o) => o.amount)).toEqual([3000, 3000]);
    expect(left.saving!.lands! > counted.saving!.lands!).toBe(true);
  });
});

describe('pay as it is now', () => {
  // Invented: $1,000 saved a month on pay that rose by $200 a month two
  // months before the anchor; the four months before count at the new pay.
  const months = history({ count: 15, last: '2026-09', start: 80000, saved: 1000 });
  const raise = {
    topUps: Object.fromEntries(months.slice(9, 13).map((m) => [m.period, 200])),
    changes: [{ payer: 'harbor works payroll', from: 2000, to: 2100, since: '2026-08-01', told: false }],
    pending: [],
  };

  it('counts the earlier paychecks in the window at the new pay, and says so', () => {
    const g = assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months, investedIds, pay: raise });
    expect(g.pace).toBe(1133.33); // 1,000 + 4 × 200 / 6
    expect(g.payChanges).toEqual(raise.changes);
  });

  it('names no change the window no longer reaches', () => {
    const old = { ...raise, topUps: {}, changes: [{ ...raise.changes[0], since: '2025-01-01' }] };
    expect(assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months, investedIds, pay: old }).payChanges).toEqual([]);
  });
});

describe('a monthly saving pace the operator sets', () => {
  const months = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
  const g = assessNetWorthGoal({ goal: { target: 300000, realReturnPct: 5 }, liveNetWorth: 94000, months, investedIds });

  it('is the whole of what is saved, the deposit its invested part', () => {
    expect(withSaving(g.basis!, { monthlyPace: 1500 })).toMatchObject({ pace: 1500, contribution: 400 });
    expect(withSaving(g.basis!, { monthlyPace: 1500, monthlyInvest: 900 })).toMatchObject({ pace: 1500, contribution: 900 });
  });

  it('moves the dates the server prints, and round-trips through the Setting', () => {
    const goal = { target: 300000, realReturnPct: 5, monthlyPace: 2000 };
    const set = assessNetWorthGoal({ goal, liveNetWorth: 94000, months, investedIds });
    expect(set.saving!.lands! < g.saving!.lands!).toBe(true);
    expect(set.pace).toBe(g.pace);
    expect(parseNetWorthGoal(JSON.stringify(goal))).toEqual(goal);
    expect(
      nextNetWorthGoal(null, { target: 300000, realReturnPct: 0, monthlyInvest: null, monthlyPace: 2000 }, '2026-10-17'),
    ).toEqual({ ok: true, goal: { target: 300000, monthlyPace: 2000 } });
  });
});

describe('keeping up with inflation', () => {
  it('flags a deposit that has not grown by the assumed 3% in a year', () => {
    expect(keepingUp(1000, 1000)).toEqual({ needed: 1030, changePct: 0, behind: true });
    expect(keepingUp(1020, 1000).behind).toBe(true);
  });

  it('is satisfied by a raise at or above it', () => {
    expect(keepingUp(1030, 1000).behind).toBe(false);
    expect(keepingUp(1235, 1150)).toMatchObject({ changePct: 7, behind: false });
  });

  it('measures the deposit a year before the anchor', () => {
    const months = history({ count: 16, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
    const g = assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months, investedIds });
    expect(g.contributionYearAgo).toBe(400);
    const short = assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months: months.slice(-12), investedIds });
    expect(short.contributionYearAgo).toBeNull();
  });
});

describe('what cash earns', () => {
  // Invented: checking (30% of net worth) is paid nothing; the account counted
  // as cash (10%) is paid 0.3% of its month-start balance each month.
  const cashAccounts = [
    { id: 'checking', name: 'Checking' },
    { id: 'cashInvested', name: 'Money market' },
  ];
  const months = history({
    count: 15,
    last: '2026-09',
    start: 80000,
    saved: 1000,
    flows: () => ({ invested: 400 }),
    interest: () => ({}),
  });
  // Paid 0.3% of what the money market started each month with.
  for (let i = 1; i < months.length; i += 1) {
    months[i].interestByAccount = { cashInvested: Math.round(months[i - 1].byAccount!.cashInvested * 0.003 * 100) / 100 };
  }
  const goal = { target: 300000, realReturnPct: 5 };
  const g = assessNetWorthGoal({ goal, liveNetWorth: 94000, months, investedIds, cashAccounts });

  it('reads each account from what it was paid, weighted by where the cash sat', () => {
    expect(g.cash!.accounts.map((a) => a.name)).toEqual(['Checking', 'Money market']);
    expect(g.cash!.accounts[0].nominalPct).toBe(0);
    expect(g.cash!.accounts[1].nominalPct).toBeCloseTo(3.66, 1);
    expect(g.cash!.accounts.reduce((s, a) => s + a.share, 0)).toBeCloseTo(1, 6);
    expect(g.cash!.accounts[0].share).toBeCloseTo(0.75, 6); // checking is 30% of net worth against 10%
    // The mix, 0.9% before inflation, loses about 2% after the assumed 3%.
    expect(g.cash!.nominalPct).toBeCloseTo(0.92, 1);
    expect(g.cash!.realPct).toBeLessThan(-1.9);
    expect(g.basis!.cash).toBeCloseTo(months.at(-1)!.value * 0.4, 1);
  });

  it('moves both dates later when cash loses value, and the panel agrees', () => {
    const level = assessNetWorthGoal({ goal, liveNetWorth: 94000, months, investedIds });
    expect(level.cash).toBeNull();
    expect(g.saving!.lands! > level.saving!.lands!).toBe(true);
    expect(g.markets!.lands! >= level.markets!.lands!).toBe(true);
    expect(projectGoal(g.basis!, g.previousBasis, 300000, 5)).toEqual({ saving: g.saving, markets: g.markets });
    const t = 24;
    expect(goalPath(g.basis!, undefined, t)[t]).toBeLessThan(goalPath(level.basis!, undefined, t)[t]);
  });

  // A lump moved into the money market last month: the cash held is nearly
  // all there now, while saved cash has mostly sat in checking.
  it('earns cash held at where it sits now, and new saving at where it has sat', () => {
    const moved = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }), interest: () => ({}) });
    for (let i = 1; i < moved.length; i += 1) {
      moved[i].interestByAccount = { cashInvested: Math.round(moved[i - 1].byAccount!.cashInvested * 0.003 * 100) / 100 };
    }
    const last = moved.at(-1)!;
    const lump = last.byAccount!.checking * 0.9;
    last.byAccount = { ...last.byAccount!, checking: last.byAccount!.checking - lump, cashInvested: last.byAccount!.cashInvested + lump };
    const c = assessNetWorthGoal({ goal, liveNetWorth: 94000, months: moved, investedIds, cashAccounts }).cash!;
    const mm = c.accounts.find((a) => a.name === 'Money market')!;
    expect(mm.share).toBeGreaterThan(0.9);
    expect(mm.habitShare).toBeLessThan(0.4);
    expect(c.realPct).toBeGreaterThan(c.newRealPct);
  });

  it('holds cash level on rows stored before interest was recorded', () => {
    const old = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
    const o = assessNetWorthGoal({ goal, liveNetWorth: 94000, months: old, investedIds, cashAccounts });
    expect(o.cash).toBeNull();
    expect(o.basis!.cashRealPct).toBe(0);
  });
});

describe('idle cash', () => {
  // Invented: checking pays nothing, a money market about 3.4%.
  const cash = {
    accounts: [
      { id: 'checking', name: 'Checking', nominalPct: 0, share: 0.3, habitShare: 0.3 },
      { id: 'mm', name: 'Money market', nominalPct: 3.4, share: 0.7, habitShare: 0.7 },
    ],
    nominalPct: 2.38,
    realPct: -0.6,
    newRealPct: -0.6,
  };
  const spending = [4100, 5200, 4800, 4900];

  it('counts what checking holds beyond a month of spending, and what the best-paying account would earn on it', () => {
    const idle = idleCashAt(cash, [{ id: 'checking', balance: 18000 }, { id: 'mm', balance: 40000 }], spending)!;
    expect(idle).toMatchObject({ held: 18000, buffer: 4900, idle: 13100, from: ['Checking'] });
    expect(idle.to).toEqual({ name: 'Money market', nominalPct: 3.4 });
    expect(idle.yearly).toBeCloseTo(445.4, 2);
  });

  it('says nothing under a thousand idle, without an account that pays, or before spending is measured', () => {
    expect(idleCashAt(cash, [{ id: 'checking', balance: 5500 }], spending)).toBeNull();
    expect(idleCashAt({ ...cash, accounts: [cash.accounts[0]] }, [{ id: 'checking', balance: 18000 }], spending)).toBeNull();
    expect(idleCashAt(cash, [{ id: 'checking', balance: 18000 }], [4000, 4000])).toBeNull();
    expect(idleCashAt(null, [{ id: 'checking', balance: 18000 }], spending)).toBeNull();
  });

  it('prices a move as cash earning more from now on, which brings a date nearer', () => {
    const months = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
    const b = { ...assessNetWorthGoal({ goal: { target: 300000 }, liveNetWorth: 94000, months, investedIds }).basis!, cash: 30000, cashNominalPct: 1, cashRealPct: -1.94 };
    const moved = withCashMoved(b, 15000, 3.4);
    expect(moved.cashNominalPct).toBeCloseTo(2.7, 6);
    expect(projectGoal(moved, null, 300000, undefined).saving.lands! < projectGoal(b, null, 300000, undefined).saving.lands!).toBe(true);
    expect(withCashMoved(b, 0, 3.4)).toBe(b);
  });
});

describe('the return slider', () => {
  it('runs from no growth to 100%, on a scale that gives the realistic few percent room', () => {
    expect(sliderToReturn(0)).toBe(0);
    expect(sliderToReturn(1000)).toBe(100);
    // About a quarter of the travel reaches 7%.
    expect(sliderToReturn(265)).toBe(7);
    expect(returnToSlider(7)).toBeLessThan(300);
  });

  it('snaps to half points below 20% and whole points above, and shows what it saved', () => {
    for (const pct of [0.5, 4, 4.5, 7, 12.5, 25, 60, 100]) {
      expect(sliderToReturn(returnToSlider(pct))).toBe(pct);
    }
    expect(sliderToReturn(500) % 1).toBe(0); // 25%: whole points up there
  });

  it('lets the panel save anything the slider can reach', () => {
    for (let position = 0; position <= 1000; position += 37) {
      const r = nextNetWorthGoal(null, { target: 1000000, realReturnPct: sliderToReturn(position), monthlyInvest: null, monthlyPace: null }, '2026-10-16');
      expect(r.ok).toBe(true);
    }
  });
});

describe('goalPath, what the goal chart draws', () => {
  const months = history({ count: 15, last: '2026-09', start: 80000, saved: 1000, flows: () => ({ invested: 400 }) });
  const g = assessNetWorthGoal({ goal: { target: 150000, realReturnPct: 5 }, liveNetWorth: 94000, months, investedIds });
  const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;

  // A line and the date printed beside it can never disagree: each path
  // first reaches the target in exactly the month the date names.
  it('crosses the target in the month each printed date names', () => {
    for (const [pct, lands] of [[undefined, g.saving!.lands!], [5, g.markets!.lands!]] as const) {
      const t = index(lands) - index(g.basis!.anchor);
      const path = goalPath(g.basis!, pct, t);
      expect(path[t]).toBeGreaterThanOrEqual(150000);
      expect(path[t - 1]).toBeLessThan(150000);
    }
  });

  it('starts from the anchor month-end, and carries the last few years before it', () => {
    expect(goalPath(g.basis!, 5, 3)[0]).toBe(g.basis!.netWorth);
    expect(g.recent.at(-1)).toEqual({ period: '2026-09', value: months.at(-1)!.value });
    expect(g.recent.length).toBe(15);
  });
});
