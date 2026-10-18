import { describe, expect, it } from "vitest";
import { droppedNote, shortNote, windowSpan } from "./recentMonthsNote";

const whole = { used: ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"], dropped: [], short: [] };
const gapped = {
  used: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"],
  dropped: [{ period: "2026-04", missing: 2, total: 4 }],
  short: ["2026-05", "2026-06"],
};

describe("recent months, in words", () => {
  it("says the plain window when nothing was left out", () => {
    expect(windowSpan(whole)).toBe("your last 6 complete months");
    expect(droppedNote(whole)).toBeNull();
    expect(shortNote(whole, "the pace may run high")).toBeNull();
  });

  it("names a month left out and why, and the months it still leans on", () => {
    expect(windowSpan(gapped)).toBe("5 of your last 6 complete months");
    expect(droppedNote(gapped)).toBe("April left out: it predates 2 of your 4 accounts' records.");
    expect(shortNote(gapped, "the pace may run high")).toBe(
      "May and June predate an account's records, so the pace may run high.",
    );
  });

  it("names a run of months by its ends, and a month in another year with its year", () => {
    const w = {
      used: ["2026-03", "2026-04"],
      dropped: [
        { period: "2025-11", missing: 3, total: 5 },
        { period: "2025-12", missing: 2, total: 5 },
        { period: "2026-01", missing: 2, total: 5 },
        { period: "2026-02", missing: 2, total: 5 },
      ],
      short: ["2026-03"],
    };
    expect(droppedNote(w)).toBe("November 2025 to February left out: each predates at least 2 of your 5 accounts' records.");
    expect(shortNote(w, "the runway may run long")).toBe("March predates an account's records, so the runway may run long.");
  });

  it("carries no em dash", () => {
    expect(`${droppedNote(gapped)} ${shortNote(gapped, "x")}`).not.toContain("—");
  });
});
