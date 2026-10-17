import { describe, expect, it } from "vitest";
import { axisMoney, labelStepFor, monthWithYear, niceTicks, valueAxis } from "./scale";

describe("niceTicks", () => {
  it("always encloses the data range — last tick >= max (the July cash-flow bug)", () => {
    // Regression: income 5413.93 once produced ticks topping at 4000,
    // letting bars overflow the plot and collide with the static label.
    const ticks = niceTicks(0, 5413.93 * 1.06, 4);
    expect(ticks[0]).toBeLessThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(5413.93);
  });

  it("encloses arbitrary ranges from both ends", () => {
    for (const [min, max] of [
      [31_000, 39_264.69],
      [-500, 1200],
      [0.02, 0.98],
      [7, 7], // degenerate range must not loop forever or produce one tick
    ] as const) {
      const ticks = niceTicks(min, max, 4);
      expect(ticks[0]).toBeLessThanOrEqual(min);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("produces rounded boundaries", () => {
    expect(niceTicks(0, 5738, 4)).toEqual([0, 2000, 4000, 6000]);
  });
});

describe("valueAxis", () => {
  // Invented: a net worth from −$29.7k to $272.5k, padded 6% of its range.
  const pad = (272_511.75 + 29_741.49) * 0.06;

  it("floors a line crossing zero at its lowest value, not a rounded tick below it", () => {
    const axis = valueAxis(-29_741.49, 272_511.75, pad);
    expect(axis.lo).toBeCloseTo(-29_741.49 - pad / 3, 2);
    expect(axis.lo).toBeGreaterThan(-50_000);
    expect(axis.ticks).toEqual([0, 100_000, 200_000, 300_000]);
    expect(axis.hi).toBeGreaterThanOrEqual(272_511.75);
    // Zero sits within the lowest sixth of the plot, not a quarter of the way up.
    expect((0 - axis.lo) / (axis.hi - axis.lo)).toBeLessThan(1 / 6);
  });

  it("starts a line that never goes below zero at zero or above", () => {
    expect(valueAxis(1_000, 272_511.75, 16_000)).toMatchObject({ lo: 0 });
    expect(valueAxis(150_000, 272_511.75, 7_000).lo).toBeGreaterThan(0);
  });

  it("keeps rounded ticks for a line wholly below zero", () => {
    const axis = valueAxis(-30_000, -10_000, 1_200);
    expect(axis.lo).toBe(axis.ticks[0]);
    expect(axis.lo).toBeLessThanOrEqual(-31_200);
    expect(axis.hi).toBeGreaterThanOrEqual(-8_800);
  });
});

describe("axisMoney", () => {
  it("compacts to k/m and keeps small values whole", () => {
    expect(axisMoney(39_264.69)).toBe("$39.3k");
    expect(axisMoney(6000)).toBe("$6k");
    expect(axisMoney(500)).toBe("$500");
    expect(axisMoney(-2500)).toBe("−$2.5k");
    expect(axisMoney(1_500_000)).toBe("$1.5m");
  });
});

describe('monthWithYear', () => {
  /**
   * The axis thins its labels and carries a year band because "Jun" appears
   * three times across 26 months. The tooltip is the only place exact figures
   * live and printed the bare month, reintroducing exactly that ambiguity.
   */
  it('disambiguates the repeated months an axis already worries about', () => {
    expect(monthWithYear('2025-10')).toBe('Oct 2025');
    expect(monthWithYear('2024-06')).not.toBe(monthWithYear('2026-06'));
  });
});

describe('labelStepFor', () => {
  it('labels every item when they fit, and thins when they do not', () => {
    expect(labelStepFor(30, 26)).toBe(1);
    expect(labelStepFor(17.7, 26)).toBe(2);
    expect(labelStepFor(8, 26)).toBe(4);
  });

  /**
   * The net-worth axis was comfortable at 7 points and would have started
   * colliding at 13 — January 2027 for a series that began 2026-01.
   */
  it('thins the mobile net-worth axis before it can collide', () => {
    const plot = 246;
    expect(labelStepFor(plot / (7 - 1), 34)).toBe(1);
    expect(labelStepFor(plot / (13 - 1), 34)).toBeGreaterThan(1);
  });

  it('never returns 0 or a negative step for a degenerate plot', () => {
    expect(labelStepFor(0, 26)).toBe(1);
    expect(labelStepFor(-5, 26)).toBe(1);
    expect(labelStepFor(Number.NaN, 26)).toBe(1);
  });
});
