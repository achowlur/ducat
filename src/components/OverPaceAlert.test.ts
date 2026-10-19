import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { computePace } from "../lib/insights/pace";
import { OverPaceAlert, overPaceSentence } from "./OverPaceAlert";

// Invented: Julys of 3000 and 4000 and April to June of 3000, 4000 and 3600, so the top of a typical month is 3800.
const pace = (spentSoFar: number, day = 16) =>
  computePace({
    period: "2026-07",
    now: new Date(Date.UTC(2026, 6, day, 12)),
    spentSoFar,
    committedRemaining: 0,
    priors: [
      { period: "2024-07", total: 3000 },
      { period: "2025-07", total: 4000 },
      { period: "2026-04", total: 3000 },
      { period: "2026-05", total: 4000 },
      { period: "2026-06", total: 3600 },
    ],
  });
const render = (p: ReturnType<typeof pace> | null) => renderToStaticMarkup(createElement(OverPaceAlert, { pace: p, month: "July" }));

describe("OverPaceAlert", () => {
  it("is PRESENT for a month projected over, with the daily figure and a real link", () => {
    const html = render(pace(2400));
    expect(html).toContain('role="status"');
    expect(html).toContain("Over pace");
    expect(html).toContain("Keep to ~$88/day for the rest of July to land inside a typical month");
    expect(html).toContain("See where");
    expect(html).toContain('href="/trends?b.span=mtd&amp;b.show=spending&amp;b.by=category#what-changed"');
    expect(html).toContain("tap44");
  });

  it("says how far over a month already is", () => {
    expect(render(pace(3900))).toContain("Already $100 over a typical month");
  });

  it("speaks of today on the last day", () => {
    expect(overPaceSentence(pace(3750, 31), "July")).toBe("Keep to ~$50 today to land inside a typical month");
  });

  it("renders nothing inside the range, on a refusal or with no pace", () => {
    expect(render(pace(1800))).toBe("");
    expect(render(pace(5000, 3))).toBe("");
    expect(render(null)).toBe("");
  });

  it("carries no em dash", () => {
    expect(render(pace(2400))).not.toContain("—");
  });
});
