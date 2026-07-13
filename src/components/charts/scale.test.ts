import { describe, expect, it } from "vitest";
import { axisMoney, niceTicks } from "./scale";

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

describe("axisMoney", () => {
  it("compacts to k/m and keeps small values whole", () => {
    expect(axisMoney(39_264.69)).toBe("$39.3k");
    expect(axisMoney(6000)).toBe("$6k");
    expect(axisMoney(500)).toBe("$500");
    expect(axisMoney(-2500)).toBe("−$2.5k");
    expect(axisMoney(1_500_000)).toBe("$1.5m");
  });
});
