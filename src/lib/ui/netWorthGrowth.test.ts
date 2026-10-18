import { describe, expect, it } from "vitest";
import { growthBetween, growthByYear, type NetWorthPoint } from "./netWorthGrowth";

const point = (period: string, value: number, marketGains: number | null = 0, estimated = false): NetWorthPoint => ({
  period,
  value,
  estimated,
  leftOut: [],
  marketGains,
});

/** Month keys from `start` for `count` months. */
const periods = (start: string, count: number) => {
  const [y, m] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
};

describe("growthBetween", () => {
  it("splits a change into the markets and what was saved, adding up exactly", () => {
    const points = [point("2025-12", 10_000, null), point("2026-01", 11_500, 400), point("2026-02", 12_100, -150)];
    const g = growthBetween(points, 0, 2);
    expect(g).toMatchObject({ from: "2025-12", to: "2026-02", change: 2100, markets: 250, saved: 1850, pct: 0.21 });
    expect(g.markets + g.saved).toBe(g.change);
  });

  // Invented: a brokerage holding $30,000 enters the total in March, its
  // records starting there. Its balance arriving is not saving.
  it("names an account joining the total apart from saved and markets, the three adding up exactly", () => {
    const points = [
      { ...point("2026-01", 10_000, null), leftOut: ["Brokerage"] },
      { ...point("2026-02", 11_000, 0), leftOut: ["Brokerage"] },
      point("2026-03", 42_200, null),
      point("2026-04", 43_500, 300),
    ];
    const g = growthBetween(points, 0, 3);
    expect(g).toMatchObject({ change: 33_500, markets: 300, joined: 31_200, saved: 2000 });
    expect(g.saved + g.markets + g.joined).toBe(g.change);
    // A span over the same accounts throughout has nothing joining.
    expect(growthBetween(points, 2, 3).joined).toBe(0);
  });

  it("never counts the base month's own market movement: that happened before the span", () => {
    const points = [point("2026-01", 5000, 999), point("2026-02", 5200, 50)];
    expect(growthBetween(points, 0, 1).markets).toBe(50);
  });

  it("prints no growth rate from a base at or below zero", () => {
    const points = [point("2026-01", -300), point("2026-02", 700)];
    expect(growthBetween(points, 0, 1).pct).toBeNull();
  });

  it("counts the months that must be discounted, the base included", () => {
    const points = [point("2026-01", 100, 0, true), point("2026-02", 200), { ...point("2026-03", 300), leftOut: ["Card"] }];
    expect(growthBetween(points, 0, 2).uncertainMonths).toBe(2);
  });

  it("charges a carried month nothing and the catch-up month the whole move, once", () => {
    // February's value was carried (no market figure); March's statement
    // returns and its market figure holds both months' movement.
    const points = [point("2026-01", 1000), point("2026-02", 1000, 0), point("2026-03", 1300, 300)];
    expect(growthBetween(points, 0, 2)).toMatchObject({ change: 300, markets: 300, saved: 0 });
  });
});

describe("growthByYear", () => {
  const points = periods("2023-11", 24).map((p, i) => point(p, 1000 + i * 100, i === 0 ? null : 10));

  it("measures each year from the December before it, newest first", () => {
    const years = growthByYear(points);
    expect(years.map((y) => y.year)).toEqual(["2025", "2024", "2023"]);
    const y2024 = years[1];
    expect(y2024).toMatchObject({ from: "2023-12", to: "2024-12", change: 1200, markets: 120, saved: 1080, soFar: false, fromInside: false });
  });

  it("marks the year being lived in as so far, and a first year from inside it", () => {
    const years = growthByYear(points);
    expect(years[0]).toMatchObject({ year: "2025", from: "2024-12", to: "2025-10", soFar: true });
    expect(years[2]).toMatchObject({ year: "2023", from: "2023-11", to: "2023-12", fromInside: true });
  });

  it("leaves out a year with one month on record and no December before it", () => {
    const years = growthByYear([point("2023-12", 500, null), point("2024-01", 600)]);
    expect(years.map((y) => y.year)).toEqual(["2024"]);
  });

  it("sums every year's change to the whole history's", () => {
    const total = growthByYear(points).reduce((sum, y) => sum + y.change, 0);
    expect(total).toBe(points[points.length - 1].value - points[0].value);
  });
});
