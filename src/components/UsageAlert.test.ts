import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageAlertBanner } from "./UsageAlert";
import type { UsageReading } from "../lib/usage/limits";

/** Assertions are on what is PRESENT (CLAUDE.md); the quiet case renders nothing by design. */
const NOW = new Date("2026-03-16T00:00:00Z");
const reading = (over: Partial<UsageReading> = {}): UsageReading => ({
  month: "2026-03",
  monthly: { "turso.rowsRead": 1_000_000, "app.requests": 300 },
  simplefinToday: 1,
  simplefinBusiestDay: 1,
  countedSince: null,
  ...over,
});
const render = (r: UsageReading) => renderToStaticMarkup(createElement(UsageAlertBanner, { reading: r, now: NOW }));

describe("UsageAlertBanner", () => {
  it("is a loud alert naming the allowance, how much is spent, the pace and what happens past it", () => {
    const html = render(reading({ monthly: { "turso.rowsRead": 300_000_000 } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("bg-warn");
    expect(html).toContain("Close to a free-plan limit");
    expect(html).toContain("Turso rows read: 300M of the free plan&#x27;s 500M this month (60%), on pace for 12");
    expect(html).toContain("by Apr 1");
    expect(html).toContain("Turso blocks every database on the account");
    expect(html).toContain('href="/providers"');
  });

  it("warns at 80% spent even before a pace can be told", () => {
    const html = renderToStaticMarkup(
      createElement(UsageAlertBanner, {
        reading: reading({ monthly: { "turso.rowsWritten": 8_500_000 } }),
        now: new Date("2026-03-01T06:00:00Z"),
      }),
    );
    expect(html).toContain("Turso rows written: 8.5M of the free plan&#x27;s 10M this month (85%).");
  });

  it("names SimpleFIN's busiest day when any day this month came near 24", () => {
    const html = render(reading({ simplefinBusiestDay: 21 }));
    expect(html).toContain("the busiest day this month made 21 of the 24 a day it allows");
    expect(html).toContain("may disable the access token");
  });

  it("renders nothing while every allowance is comfortable", () => {
    expect(render(reading())).toBe("");
  });
});
