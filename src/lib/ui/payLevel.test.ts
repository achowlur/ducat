import { describe, expect, it } from "vitest";
import { parseNewPay, payLevels } from "./payLevel";
import type { PayItem } from "../../types/contracts";

// Invented: paid on the 1st and 15th, $2,000.00 until a raise to $2,100.00.

const payer = "harbor works payroll";
function run(months: string[], amountFor: (month: string, day: string) => number): PayItem[] {
  return months.flatMap((m) => ["01", "15"].map((d) => ({ date: `${m}-${d}`, amount: amountFor(m, d), payer })));
}
const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

describe("payLevels", () => {
  it("tops up every paycheck before a raise that has repeated, in its month", () => {
    const pay = payLevels(run(MONTHS, (m) => (m >= "2026-08" ? 2100 : 2000)), []);
    expect(pay.changes).toEqual([{ payer, from: 2000, to: 2100, since: "2026-08-01", told: false }]);
    expect(pay.topUps).toEqual({ "2026-04": 200, "2026-05": 200, "2026-06": 200, "2026-07": 200 });
    expect(pay.pending).toEqual([]);
  });

  it("asks about a new amount that has not repeated, counting it as itself until then", () => {
    const pay = payLevels(run(MONTHS, (m, d) => (m === "2026-09" && d === "15" ? 2100 : 2000)), []);
    expect(pay.pending).toEqual([{ payer, date: "2026-09-15", amount: 2100, from: 2000 }]);
    expect(pay.topUps).toEqual({});
    expect(pay.changes).toEqual([]);
  });

  it("projects from it at once when the operator says it is the new pay", () => {
    const items = run(MONTHS, (m, d) => (m === "2026-09" && d === "15" ? 2100 : 2000));
    const pay = payLevels(items, [{ payer, date: "2026-09-15" }]);
    expect(pay.pending).toEqual([]);
    expect(pay.changes).toEqual([{ payer, from: 2000, to: 2100, since: "2026-09-15", told: true }]);
    expect(pay.topUps["2026-04"]).toBe(200);
    expect(pay.topUps["2026-09"]).toBe(100);
  });

  it("does the same for a cut, and nothing at a steady pay", () => {
    expect(payLevels(run(MONTHS, (m) => (m >= "2026-08" ? 1900 : 2000)), []).topUps["2026-04"]).toBe(-200);
    expect(payLevels(run(MONTHS, () => 2000), [])).toEqual({ topUps: {}, changes: [], pending: [] });
  });

  it("reads the stored confirmations tolerantly", () => {
    expect(parseNewPay('[{"payer":"x","date":"2026-09-15"}]')).toEqual([{ payer: "x", date: "2026-09-15" }]);
    expect(parseNewPay("[{\"payer\":\"x\",\"date\":\"Sept\"}]")).toEqual([]);
    expect(parseNewPay("not json")).toEqual([]);
    expect(parseNewPay(null)).toEqual([]);
  });
});

// Invented: every other Friday at $2,000.00 from Harbor Works until June,
// then every other Friday at $2,800.00 from a new employer from July.
describe("payLevels across a job change", () => {
  const DAY = 86_400_000;
  const fortnightly = (from: string, count: number, amount: number, who: string): PayItem[] =>
    Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 14 * DAY).toISOString().slice(0, 10),
      amount,
      payer: who,
    }));
  const old = fortnightly("2026-01-02", 13, 2000, payer); // last 2026-06-19
  const fresh = fortnightly("2026-07-03", 7, 2800, "lakeside data payroll"); // to 2026-09-25

  // The failure: the old salary stayed in the window at its own level.
  it("counts every month of the old job at a month of the new pay", () => {
    const pay = payLevels([...old, ...fresh], []);
    expect(pay.changes).toEqual([
      { payer: "lakeside data payroll", from: 4348.21, to: 6087.5, since: "2026-07-03", told: false, replaces: payer },
    ]);
    // April paid two old paychecks, January three.
    expect(pay.topUps["2026-04"]).toBe(2087.5);
    expect(pay.topUps["2026-01"]).toBe(87.5);
    expect(pay.topUps["2026-08"]).toBeUndefined();
    expect(pay.pending).toEqual([]);
  });

  it("reads two payers paying at once as two jobs, never a change", () => {
    const second = fortnightly("2026-03-06", 15, 600, "corner bookshop");
    const pay = payLevels([...fortnightly("2026-01-02", 20, 2000, payer), ...second], []);
    expect(pay.changes).toEqual([]);
    expect(pay.topUps).toEqual({});
  });

  it("waits until the old pay has been silent two cycles before it reads a stop", () => {
    expect(payLevels([...old, fresh[0]], [])).toMatchObject({ changes: [], pending: [] });
  });

  it("asks about a single new paycheck after the old pay stopped, and projects from it once told", () => {
    const later = [...old, { ...fresh[0], date: "2026-08-28" }];
    const ask = payLevels(later, []);
    expect(ask.pending).toEqual([{ payer: "lakeside data payroll", date: "2026-08-28", amount: 2800, from: 2000, replaces: payer }]);
    expect(ask.changes).toEqual([]);
    const toldPay = payLevels(later, [{ payer: "lakeside data payroll", date: "2026-08-28" }]);
    expect(toldPay.pending).toEqual([]);
    expect(toldPay.changes[0]).toMatchObject({ payer: "lakeside data payroll", told: true, replaces: payer, to: 6087.5 });
  });

  it("asks rather than choosing between two new payers", () => {
    const pay = payLevels([...old, ...fresh, ...fortnightly("2026-07-10", 6, 900, "corner bookshop")], []);
    expect(pay.changes.filter((c) => c.replaces !== undefined)).toEqual([]);
    expect(pay.pending.map((p) => p.payer).sort()).toEqual(["corner bookshop", "lakeside data payroll"]);
  });
});

// Invented: "Acme Payroll direct dep" every other Friday, then the bank calls
// the same employer "Acme Payroll" from June, at a slightly higher amount.
describe("payLevels across a renamed descriptor", () => {
  const DAY = 86_400_000;
  const fortnightly = (from: string, count: number, amount: number, who: string): PayItem[] =>
    Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 14 * DAY).toISOString().slice(0, 10),
      amount,
      payer: who,
    }));
  const before = fortnightly("2026-01-02", 12, 2000, "acme payroll direct dep"); // last 2026-06-05
  const after = fortnightly("2026-06-19", 8, 2080, "acme payroll"); // to 2026-09-25

  // The failure: the old name read as a job whose paychecks stopped.
  it("reads one payer and a raise, never a job change", () => {
    const pay = payLevels([...before, ...after], []);
    expect(pay.changes).toEqual([{ payer: "acme payroll", from: 2000, to: 2080, since: "2026-06-19", told: false }]);
    // Each paycheck before the raise is topped up by the step, in its month.
    expect(pay.topUps["2026-04"]).toBe(160);
    expect(pay.topUps["2026-01"]).toBe(240);
    expect(pay.pending).toEqual([]);
  });

  it("asks about the renamed payer's first paycheck as a raise, and honours the answer", () => {
    const one = [...before, after[0]];
    expect(payLevels(one, []).pending).toEqual([{ payer: "acme payroll", date: "2026-06-19", amount: 2080, from: 2000 }]);
    expect(payLevels(one, [{ payer: "acme payroll", date: "2026-06-19" }]).changes[0]).toMatchObject({ payer: "acme payroll", told: true });
  });

  it("still reads a different employer after it as a job change", () => {
    const pay = payLevels([...fortnightly("2026-01-02", 12, 2000, "acme payroll"), ...fortnightly("2026-07-03", 7, 2800, "birchwood labs")], []);
    expect(pay.changes).toEqual([
      { payer: "birchwood labs", from: 4348.21, to: 6087.5, since: "2026-07-03", told: false, replaces: "acme payroll" },
    ]);
  });
});
