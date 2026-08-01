import { describe, expect, it } from "vitest";
import { selectPeriod } from "./periodNav";

/** Mid-August, unambiguous in any zone. */
const AUG = new Date(Date.UTC(2026, 7, 15, 12));

describe("period selection admits the month being lived in", () => {
  it("reaches the current month by request even when it has no rows", () => {
    const sel = selectPeriod(["2026-06", "2026-07"], "2026-08", AUG);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null });
  });

  it("keeps the DEFAULT at the latest month with rows, with › leading to the current one", () => {
    const sel = selectPeriod(["2026-06", "2026-07"], undefined, AUG);
    expect(sel).toEqual({ period: "2026-07", prevPeriod: "2026-06", nextPeriod: "2026-08" });
  });

  it("admits ONLY the current month — other rowless months still clamp", () => {
    // A future month...
    expect(selectPeriod(["2026-06", "2026-07"], "2026-09", AUG)?.period).toBe("2026-07");
    // ...a past month inside a gap in the history...
    expect(selectPeriod(["2026-05", "2026-07"], "2026-06", AUG)?.period).toBe("2026-07");
    // ...and a key that is not a month at all.
    expect(selectPeriod(["2026-06", "2026-07"], "banana", AUG)?.period).toBe("2026-07");
  });

  it("changes nothing once the current month has rows of its own", () => {
    const sel = selectPeriod(["2026-07", "2026-08"], "2026-08", AUG);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null });
    // The default is then the current month, because it IS the latest with rows.
    expect(selectPeriod(["2026-07", "2026-08"], undefined, AUG)?.period).toBe("2026-08");
  });

  it("navigates coherently: ‹ from the current month and › from the latest real month meet", () => {
    const fromCurrent = selectPeriod(["2026-06", "2026-07"], "2026-08", AUG);
    const fromLatest = selectPeriod(["2026-06", "2026-07"], "2026-07", AUG);
    expect(fromCurrent?.prevPeriod).toBe("2026-07");
    expect(fromLatest?.nextPeriod).toBe("2026-08");
  });

  it("returns null for a database with no insight rows at all — first run keeps its own page", () => {
    expect(selectPeriod([], "2026-08", AUG)).toBeNull();
    expect(selectPeriod([], undefined, AUG)).toBeNull();
  });

  it("tolerates duplicate periods, one per insight row", () => {
    const sel = selectPeriod(["2026-07", "2026-07", "2026-06"], undefined, AUG);
    expect(sel).toEqual({ period: "2026-07", prevPeriod: "2026-06", nextPeriod: "2026-08" });
  });

  it("derives the current month in UTC, where every period bound lives", () => {
    // 01:00 UTC on the 1st is still the previous evening in US zones — the
    // month must already be August, or the boundary would move with the
    // display timezone.
    const boundary = new Date(Date.UTC(2026, 7, 1, 1));
    const sel = selectPeriod(["2026-07"], "2026-08", boundary);
    expect(sel?.period).toBe("2026-08");
  });
});
