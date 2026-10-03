import { describe, expect, it } from "vitest";
import { parsePeriodParam, spanLabel, spanParam } from "./periodSpan";

describe("parsePeriodParam", () => {
  it("reads a single period key as before", () => {
    expect(parsePeriodParam("2026-07")).toEqual({
      start: new Date(Date.UTC(2026, 6, 1)),
      end: new Date(Date.UTC(2026, 7, 1)),
      span: null,
    });
    expect(parsePeriodParam("2026")?.end).toEqual(new Date(Date.UTC(2027, 0, 1)));
  });

  it("reads a span of whole months, inclusive at both ends", () => {
    expect(parsePeriodParam("2025-10..2026-09")).toEqual({
      start: new Date(Date.UTC(2025, 9, 1)),
      end: new Date(Date.UTC(2026, 9, 1)),
      span: { from: "2025-10", to: "2026-09" },
    });
  });

  it.each(["", undefined, "2026-09..2025-10", "2026-13..2026-14", "2026-Q1..2026-Q2", "2026-01..", "nonsense"])(
    "ignores %s rather than crash",
    (raw) => {
      expect(parsePeriodParam(raw)).toBeNull();
    },
  );
});

describe("spanParam and spanLabel", () => {
  it("writes one month as its own key, and names a span with both years", () => {
    expect(spanParam("2026-09", "2026-09")).toBe("2026-09");
    expect(spanParam("2025-10", "2026-09")).toBe("2025-10..2026-09");
    expect(spanLabel("2025-10", "2026-09")).toBe("Oct 2025 to Sep 2026");
    expect(spanLabel("2026-09", "2026-09")).toBe("September 2026");
  });

  it("round-trips through the parser", () => {
    const parsed = parsePeriodParam(spanParam("2024-11", "2026-02"));
    expect(parsed?.span).toEqual({ from: "2024-11", to: "2026-02" });
  });
});
