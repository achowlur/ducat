import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { countLabel, shareLabel, UsageLimits } from "./UsageLimits";
import { usageLines, type UsageReading } from "../lib/usage/limits";

/** Assertions are on what is PRESENT (CLAUDE.md): an absent string passes on a page that never rendered. */
const NOW = new Date("2026-03-16T00:00:00Z");
const reading = (over: Partial<UsageReading> = {}): UsageReading => ({
  month: "2026-03",
  monthly: { "turso.rowsRead": 12_300_000, "turso.rowsWritten": 41_200, "turso.statements": 9_000, "app.requests": 1_234 },
  simplefinToday: 1,
  simplefinBusiestDay: 2,
  countedSince: null,
  ...over,
});
const render = (r: UsageReading | null, cloud = true) =>
  renderToStaticMarkup(createElement(UsageLimits, { cloud, reading: r, lines: r === null ? [] : usageLines(r, NOW) }));

describe("UsageLimits", () => {
  it("prints each allowance as used, of the limit, its share and the month-end pace", () => {
    const html = render(reading());
    expect(html).toContain("Free-plan limits");
    expect(html).toContain("12.3M of 500M · 2.5% · on pace for 5.");
    expect(html).toContain("41.2k of 10M");
    expect(html).toContain("1,234 of 1M");
    expect(html).toContain("1 of 24");
    expect(html).toContain("unmetered on a public repository");
    expect(html).toContain("this counts only this one");
  });

  it("says in words when the pace passes a limit", () => {
    const html = render(reading({ monthly: { "turso.rowsRead": 300_000_000 } }));
    expect(html).toContain("Turso rows read pass the free limit before the month ends");
  });

  it("names statements the host did not report, so the figure can be discounted", () => {
    const html = render(reading({ monthly: { "turso.statements": 400, "turso.unreported": 25 } }));
    expect(html).toContain("did not report row counts for 25 of 400 statements");
  });

  it("names a month counted partway", () => {
    expect(render(reading({ countedSince: new Date("2026-03-09T14:00:00Z") }))).toContain("Counted since");
  });

  it("says a database behind its schema is not being counted", () => {
    expect(render(null)).toContain("this database has no UsageCount table yet");
  });

  it("tells local mode it spends no host allowance", () => {
    expect(render(null, false)).toContain("Local mode spends no Turso or Vercel allowance");
  });
});

describe("labels", () => {
  it("compacts counts and shares", () => {
    expect([countLabel(0), countLabel(9_999), countLabel(41_200), countLabel(500_000_000), countLabel(2_500_000_000)]).toEqual([
      "0",
      "9,999",
      "41.2k",
      "500M",
      "2.5B",
    ]);
    expect([shareLabel(0), shareLabel(0.0004), shareLabel(0.024), shareLabel(0.37), shareLabel(1.2)]).toEqual([
      "0%",
      "<0.1%",
      "2.4%",
      "37%",
      "120%",
    ]);
  });
});
