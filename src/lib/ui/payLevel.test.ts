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
