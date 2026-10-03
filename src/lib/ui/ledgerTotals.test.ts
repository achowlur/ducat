import { describe, expect, it } from "vitest";
import { ledgerTotals } from "./ledgerTotals";

const out = (amount: number) => ({ flow: "OUTFLOW", amount: -amount });
const inflow = (amount: number) => ({ flow: "INFLOW", amount });
const transfer = (amount: number) => ({ flow: "TRANSFER", amount });

describe("ledgerTotals", () => {
  it("adds money out and money in, and nets the two", () => {
    const t = ledgerTotals([out(40), out(12.5), inflow(20)]);
    expect(t.out).toBe(52.5);
    expect(t.in).toBe(20);
    expect(t.net).toBe(-32.5);
    expect(t.count).toBe(3);
  });

  it("reports money out as a positive magnitude", () => {
    expect(ledgerTotals([out(9.99)]).out).toBe(9.99);
  });

  it("keeps transfers OUT of the net, and counts them in both directions", () => {
    const t = ledgerTotals([out(100), inflow(30), transfer(-500), transfer(-250), transfer(500)]);
    expect(t.out).toBe(100);
    expect(t.in).toBe(30);
    expect(t.net).toBe(-70);
    expect(t.transfers).toEqual({ count: 3, out: 750, in: 500 });
    // Every row is in one of the figures.
    expect(t.count).toBe(5);
  });

  it("agrees with the signed sum of every row once transfers are added back", () => {
    const rows = [out(100), inflow(30), transfer(-500), transfer(200)];
    const t = ledgerTotals(rows);
    const signed = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(t.net + t.transfers.in - t.transfers.out).toBe(signed);
  });

  it("a view of transfers alone has nothing in the net", () => {
    const t = ledgerTotals([transfer(-80), transfer(80)]);
    expect(t.out).toBe(0);
    expect(t.in).toBe(0);
    expect(t.net).toBe(0);
    expect(t.transfers).toEqual({ count: 2, out: 80, in: 80 });
  });

  it("is all zeros for no rows", () => {
    expect(ledgerTotals([])).toEqual({
      count: 0,
      out: 0,
      in: 0,
      repaid: { amount: 0, count: 0 },
      net: 0,
      transfers: { count: 0, out: 0, in: 0 },
    });
  });

  it("nets in what linked repayments outside the list paid back", () => {
    const t = ledgerTotals([out(90), out(60), inflow(5)], { amount: 60, count: 2 });
    expect(t.out).toBe(150);
    expect(t.repaid).toEqual({ amount: 60, count: 2 });
    expect(t.net).toBe(-85);
  });

  it("does not drift over many rows", () => {
    // 0.1 added three thousand times as floats is 300.0000000000429.
    const t = ledgerTotals(Array.from({ length: 3000 }, () => out(0.1)));
    expect(t.out).toBe(300);
    expect(t.net).toBe(-300);
  });

  it("a page's totals add up to the whole list's", () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      i % 7 === 0 ? transfer(i % 2 === 0 ? -i - 0.37 : i + 0.37) : i % 5 === 0 ? inflow(i + 0.13) : out(i + 0.91),
    );
    const whole = ledgerTotals(rows);
    const pages = [rows.slice(0, 100), rows.slice(100, 200), rows.slice(200)].map((page) => ledgerTotals(page));
    const sum = (pick: (t: ReturnType<typeof ledgerTotals>) => number) =>
      Math.round(pages.reduce((s, p) => s + pick(p), 0) * 100) / 100;
    expect(sum((p) => p.out)).toBe(whole.out);
    expect(sum((p) => p.in)).toBe(whole.in);
    expect(sum((p) => p.net)).toBe(whole.net);
    expect(sum((p) => p.transfers.out)).toBe(whole.transfers.out);
    expect(sum((p) => p.transfers.in)).toBe(whole.transfers.in);
    expect(pages.reduce((s, p) => s + p.count, 0)).toBe(whole.count);
  });
});
