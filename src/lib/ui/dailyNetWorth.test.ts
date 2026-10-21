import { describe, expect, it } from "vitest";
import { CARRY_DAYS, dailyNetWorth, dayLabel } from "./dailyNetWorth";

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const at = (day: string, hour = 20) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const day = (n: number) => new Date(Date.UTC(2026, 7, 1 + n)).toISOString().slice(0, 10); // 2026-08-01 + n

const checking = { id: "chk", name: "Everyday Checking ...0001", type: "DEPOSITORY" };
const brokerage = { id: "brk", name: "Brokerage ...0003", type: "INVESTMENT" };

/** A balance every day 0..n-1 for each account, from a function of the day. */
function daily(n: number, id: string, value: (i: number) => number, skip: number[] = []) {
  return Array.from({ length: n }, (_, i) => i)
    .filter((i) => !skip.includes(i))
    .map((i) => ({ accountId: id, date: at(day(i)), balance: value(i) }));
}

describe("dailyNetWorth", () => {
  it("adds every account's balance per day, from the first full week", () => {
    const out = dailyNetWorth({
      accounts: [checking, brokerage],
      snapshots: [...daily(10, "chk", (i) => 1_000 + i), ...daily(10, "brk", (i) => 5_000 + 10 * i)],
      txns: [],
      dayOf: utcDay,
      today: day(9),
    });
    expect(out.points).toHaveLength(10);
    expect(out.points[0]).toMatchObject({ period: "2026-08-01", label: "Aug 1", value: 6_000, marketGains: null, leftOut: [] });
    expect(out.points[3]).toMatchObject({ value: 6_033, marketGains: 10 });
    expect(out.missing).toEqual([]);
  });

  it(`carries a bank's last balance up to ${CARRY_DAYS} days, and leaves out a day beyond`, () => {
    const out = dailyNetWorth({
      accounts: [checking, brokerage],
      // Checking posts nothing on days 9 to 12: 9, 10 and 11 carry day 8's; 12 is four days old.
      snapshots: [...daily(20, "chk", () => 1_000, [9, 10, 11, 12]), ...daily(20, "brk", () => 5_000)],
      txns: [],
      dayOf: utcDay,
      today: day(19),
    });
    expect(out.points.map((p) => p.period)).toContain(day(11));
    expect(out.missing).toEqual([day(12)]);
  });

  it("starts at the first run of seven whole days, never at a lone early balance", () => {
    const out = dailyNetWorth({
      accounts: [checking, brokerage],
      // A month-end import far back, then daily balances from day 30.
      snapshots: [
        { accountId: "chk", date: at("2025-12-31", 12), balance: 500 },
        { accountId: "brk", date: at("2025-12-31", 12), balance: 4_000 },
        ...daily(40, "chk", () => 1_000, Array.from({ length: 30 }, (_, i) => i)),
        ...daily(40, "brk", () => 5_000, Array.from({ length: 30 }, (_, i) => i)),
      ],
      txns: [],
      dayOf: utcDay,
      today: day(39),
    });
    expect(out.points[0].period).toBe(day(30));
    expect(out.missing).toEqual([]);
  });

  it("groups a balance by the LOCAL day it was stamped on", () => {
    // Stamped 01:45 UTC: the evening before, Eastern.
    const eastern = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const out = dailyNetWorth({
      accounts: [brokerage],
      snapshots: Array.from({ length: 8 }, (_, i) => ({ accountId: "brk", date: new Date(`${day(i + 1)}T01:45:00Z`), balance: 100 + i })),
      txns: [],
      dayOf: eastern,
      today: day(7),
    });
    expect(out.points[0]).toMatchObject({ period: day(0), value: 100 });
  });

  it("takes money moved into an investment account out of its market movement, on its own day", () => {
    // Posted on day 4; the brokerage's balance stamped on day 5 is day 4's close.
    const out = dailyNetWorth({
      accounts: [checking, { ...brokerage, priorClose: true }],
      snapshots: [...daily(9, "chk", (i) => (i < 4 ? 3_000 : 2_000)), ...daily(9, "brk", (i) => (i < 5 ? 10_000 : 11_050))],
      txns: [
        { accountId: "brk", date: new Date(`${day(4)}T00:00:00Z`), amount: 1_000, description: "Transferred from Everyday Checking" },
        { accountId: "brk", date: new Date(`${day(4)}T00:00:00Z`), amount: -900, description: "YOU BOUGHT INDEX FUND" },
      ],
      dayOf: utcDay,
      today: day(7),
    });
    const on = (k: number) => out.points.find((p) => p.period === day(k));
    expect(on(3)).toMatchObject({ value: 13_000, marketGains: 0 });
    expect(on(4)).toMatchObject({ value: 13_050, marketGains: 50 });
  });

  it("counts a closed account as zero, and names one with no balance yet", () => {
    const closed = { id: "old", name: "Old Savings", type: "DEPOSITORY" };
    const fresh = { id: "new", name: "New Card ...0007", type: "CREDIT" };
    const out = dailyNetWorth({
      accounts: [checking, closed, fresh],
      snapshots: [
        { accountId: "old", date: at("2026-01-15"), balance: 0 },
        ...daily(12, "chk", () => 1_000),
        ...daily(12, "new", () => -50, [0, 1, 2, 3, 4, 5, 6, 7]),
      ],
      txns: [],
      dayOf: utcDay,
      today: day(11),
    });
    expect(out.points[0]).toMatchObject({ value: 1_000, leftOut: ["New Card ...0007"] });
    expect(out.points[8]).toMatchObject({ value: 950, leftOut: [], marketGains: null });
  });

  it("is EMPTY with no run of whole days, and drops a gap that is only today not in yet", () => {
    expect(dailyNetWorth({ accounts: [checking], snapshots: daily(5, "chk", () => 1), txns: [], dayOf: utcDay, today: day(4) }).points).toEqual([]);
    const out = dailyNetWorth({ accounts: [checking], snapshots: daily(8, "chk", () => 1), txns: [], dayOf: utcDay, today: day(14) });
    expect(out.missing).toEqual([]);
    expect(out.points.at(-1)?.period).toBe(day(10));
  });

  it("dates a prior-close balance a day back: an update on day 5 is day 4's close", () => {
    const out = dailyNetWorth({
      accounts: [{ ...brokerage, priorClose: true }],
      snapshots: daily(10, "brk", (i) => 100 * i),
      txns: [],
      dayOf: utcDay,
      today: day(8),
    });
    expect(out.points.find((p) => p.period === day(4))?.value).toBe(500);
  });

  it("labels a day as the axis prints it", () => {
    expect(dayLabel("2026-10-05")).toBe("Oct 5");
  });
});
