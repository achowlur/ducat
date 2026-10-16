import { describe, expect, it } from "vitest";
import { monthStep, monthTicks, yearLabels, yearSpans } from "./timeAxis";

const periods = (start: string, count: number) => {
  const [y, m] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
};

describe("monthStep", () => {
  it("labels every month when there is room, then every other, quarters, halves", () => {
    expect(monthStep(40, 34)).toBe(1);
    expect(monthStep(20, 34)).toBe(2);
    expect(monthStep(12, 34)).toBe(3);
    expect(monthStep(6, 34)).toBe(6);
  });

  it("names years alone when even halves would crowd", () => {
    expect(monthStep(2.7, 34)).toBeNull();
  });
});

describe("monthTicks", () => {
  it("puts quarter labels on January, April, July and October, wherever the window starts", () => {
    const p = periods("2024-11", 12); // Nov 2024 .. Oct 2025
    expect(monthTicks(p, 0, 11, 3).map((i) => p[i])).toEqual(["2025-01", "2025-04", "2025-07", "2025-10"]);
    // Panned one month on: the same months stay labelled.
    expect(monthTicks(p, 1, 11, 3).map((i) => p[i])).toEqual(["2025-01", "2025-04", "2025-07", "2025-10"]);
  });
});

describe("yearLabels", () => {
  const p = periods("2016-07", 112); // Jul 2016 .. Oct 2025
  const spans = yearSpans(p);

  it("splits a series into its calendar years", () => {
    expect(spans[0]).toEqual({ year: "2016", start: 0, end: 5 });
    expect(spans[1]).toEqual({ year: "2017", start: 6, end: 17 });
    expect(spans.at(-1)).toEqual({ year: "2025", start: 102, end: 111 });
  });

  it("leaves out a year with too little on show to hold its label", () => {
    // The whole history on a phone: 2016 is six months, a sliver.
    const labels = yearLabels(spans, { start: 0, end: 111 }, 256 / 111, 26);
    expect(labels.map((l) => l.year)).not.toContain("2016");
    expect(labels.map((l) => l.year)).toContain("2017");
  });

  it("always names the newest year on show, the label before it giving way if they touch", () => {
    // A phone's whole history: 2025 has ten months, too few for the plain rule.
    const labels = yearLabels(spans, { start: 0, end: 111 }, 256 / 111, 30);
    expect(labels.at(-1)?.year).toBe("2025");
    for (let i = 1; i < labels.length; i++) expect((labels[i].at - labels[i - 1].at) * (256 / 111)).toBeGreaterThanOrEqual(30);
  });

  it("names every other year when years crowd", () => {
    const labels = yearLabels(spans, { start: 0, end: 111 }, 1.5, 26);
    // Every other year, the newest named whatever its parity.
    expect(labels.slice(0, -1).every((l) => Number(l.year) % 2 === 0)).toBe(true);
    expect(labels.at(-1)?.year).toBe("2025");
  });

  it("centres a label on the part of its year on show", () => {
    const [label] = yearLabels(spans, { start: 42, end: 60 }, 20, 26).filter((l) => l.year === "2020");
    // 2020 is indices 42..53; on show from 42 to its end at 53.5.
    expect(label.at).toBeCloseTo((42 + 53.5) / 2);
  });
});
