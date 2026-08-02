import { describe, expect, it } from "vitest";
import { tripsForPeriod, type TaggedRow } from "./trips";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

const row = (groupLabel: string, date: Date, amount: number, flow = "OUTFLOW"): TaggedRow => ({
  groupLabel,
  date,
  amount,
  flow,
});

describe("tripsForPeriod", () => {
  const label = "Tess's March trip";
  const rows: TaggedRow[] = [
    row(label, utc(2026, 2, 27), -120.5), // paid in February — the cross-period point
    row(label, utc(2026, 3, 3), -600),
    row(label, utc(2026, 3, 8), 40, "INFLOW"), // a repayment nets against the rest
    row(label, utc(2026, 3, 10), -75.25, "TRANSFER"), // tagged transfer rides along
    row("Kitchen reno", utc(2026, 6, 2), -900),
  ];

  it("a group with activity in the period carries portion, running net, span and transfers", () => {
    const trips = tripsForPeriod(rows, "2026-03");
    expect(trips).toHaveLength(1); // Kitchen reno has no March rows — absent, not zeroed
    const t = trips[0];
    expect(t.label).toBe(label);
    expect(t.periodNet).toBe(-635.25);
    expect(t.periodRowCount).toBe(3);
    expect(t.runningNet).toBe(-755.75); // February's payment counts — no month lies
    expect(t.rowCount).toBe(4);
    expect(t.firstDate).toEqual(utc(2026, 2, 27));
    expect(t.lastDate).toEqual(utc(2026, 3, 10));
    expect(t.transferCount).toBe(1);
  });

  it("the same group appears on every month its rows touch", () => {
    const feb = tripsForPeriod(rows, "2026-02");
    expect(feb).toHaveLength(1);
    expect(feb[0].periodNet).toBe(-120.5);
    expect(feb[0].runningNet).toBe(-755.75); // running is all-time on both pages
  });

  it("a period no group touches yields nothing — the section is absent, not empty", () => {
    expect(tripsForPeriod(rows, "2026-05")).toEqual([]);
    expect(tripsForPeriod([], "2026-03")).toEqual([]);
  });

  it("an unparseable period key yields nothing rather than throwing", () => {
    expect(tripsForPeriod(rows, "not-a-period")).toEqual([]);
  });

  it("the href round-trips the apostrophe label to the group-filtered ledger", () => {
    const t = tripsForPeriod(rows, "2026-03")[0];
    expect(new URLSearchParams(t.href.split("?")[1]).get("group")).toBe(label);
  });
});
