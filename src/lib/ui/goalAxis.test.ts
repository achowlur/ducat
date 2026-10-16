import { describe, expect, it } from "vitest";
import { goalAxisTicks } from "./timeAxis";

describe("goalAxisTicks", () => {
  it("labels a short chart by quarter, with the year on January", () => {
    // March 2026 to April 2027: fifteen months.
    expect(goalAxisTicks("2026-03", "2027-04").map((t) => t.label)).toEqual(["Apr", "Jul", "Oct", "2027", "Apr"]);
    expect(goalAxisTicks("2026-03", "2027-04")[0].at).toBe(1);
  });

  it("never puts a label on the first month, half off the edge", () => {
    expect(goalAxisTicks("2026-01", "2026-12").map((t) => t.label)).toEqual(["Apr", "Jul", "Oct"]);
  });

  it("labels a long chart by calendar year, stepped so it never crowds", () => {
    expect(goalAxisTicks("2021-10", "2045-06").map((t) => t.label)).toEqual(["2025", "2030", "2035", "2040", "2045"]);
    expect(goalAxisTicks("2021-10", "2031-05").map((t) => t.label)).toEqual(["2022", "2024", "2026", "2028", "2030"]);
  });
});
