import { describe, expect, it } from "vitest";
import { selectPeriod } from "./periodNav";

/** Mid-August, unambiguous in any zone. */
const AUG = new Date(Date.UTC(2026, 7, 15, 12));

describe("period selection admits and defaults to the month being lived in", () => {
  it("DEFAULTS to the current month even when it has no rows yet", () => {
    // Reversed 2026-08-02: goals, readiness, pace and commitments are all
    // gated to the lived-in month, so opening on the latest month WITH rows
    // hid the page's richest view every month-start.
    const sel = selectPeriod(["2026-06", "2026-07"], undefined, AUG);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null, clampedFrom: null });
  });

  it("reaches the current month by request even when it has no rows", () => {
    const sel = selectPeriod(["2026-06", "2026-07"], "2026-08", AUG);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null, clampedFrom: null });
  });

  it("admits ONLY the current month — other rowless months clamp to the lived-in default", () => {
    // A future month...
    expect(selectPeriod(["2026-06", "2026-07"], "2026-09", AUG)?.period).toBe("2026-08");
    // ...a past month inside a gap in the history...
    expect(selectPeriod(["2026-05", "2026-07"], "2026-06", AUG)?.period).toBe("2026-08");
    // ...and a key that is not a month at all.
    expect(selectPeriod(["2026-06", "2026-07"], "banana", AUG)?.period).toBe("2026-08");
  });

  /**
   * The clamp is correct and stays; it was the SILENCE that misled. The URL
   * went on saying `?period=2026-09` while the page rendered August, which is
   * the hazard Overview already works around by refusing to link a period
   * /trends has no row for.
   */
  it("reports which period it refused, so the page can say so", () => {
    expect(selectPeriod(["2026-06", "2026-07"], "2026-09", AUG)?.clampedFrom).toBe("2026-09");
    expect(selectPeriod(["2026-05", "2026-07"], "2026-06", AUG)?.clampedFrom).toBe("2026-06");
    expect(selectPeriod(["2026-06", "2026-07"], "banana", AUG)?.clampedFrom).toBe("banana");
  });

  it("reports nothing refused when the request was honoured, absent or empty", () => {
    expect(selectPeriod(["2026-06", "2026-07"], "2026-07", AUG)?.clampedFrom).toBeNull();
    // The lived-in month is admitted rowless, so asking for it is honoured.
    expect(selectPeriod(["2026-06", "2026-07"], "2026-08", AUG)?.clampedFrom).toBeNull();
    expect(selectPeriod(["2026-06", "2026-07"], undefined, AUG)?.clampedFrom).toBeNull();
    expect(selectPeriod(["2026-06", "2026-07"], "", AUG)?.clampedFrom).toBeNull();
  });

  it("changes nothing once the current month has rows of its own", () => {
    const sel = selectPeriod(["2026-07", "2026-08"], "2026-08", AUG);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null, clampedFrom: null });
    expect(selectPeriod(["2026-07", "2026-08"], undefined, AUG)?.period).toBe("2026-08");
  });

  it("keeps every prior month one ‹ away, and › from the latest real month returns", () => {
    const fromDefault = selectPeriod(["2026-06", "2026-07"], undefined, AUG);
    expect(fromDefault?.prevPeriod).toBe("2026-07");
    const july = selectPeriod(["2026-06", "2026-07"], "2026-07", AUG);
    expect(july).toEqual({ period: "2026-07", prevPeriod: "2026-06", nextPeriod: "2026-08", clampedFrom: null });
  });

  it("keeps rows AHEAD of the lived-in month reachable without moving the default", () => {
    // Clock skew or a future-dated import: the default still lands on the
    // month being lived in, and the future rows wait one › away.
    const skewOnly = selectPeriod(["2026-09"], undefined, AUG);
    expect(skewOnly).toEqual({ period: "2026-08", prevPeriod: null, nextPeriod: "2026-09", clampedFrom: null });
    const skewWithHistory = selectPeriod(["2026-07", "2026-09"], undefined, AUG);
    expect(skewWithHistory).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: "2026-09", clampedFrom: null });
  });

  it("returns null for a database with no insight rows at all — first run keeps its own page", () => {
    expect(selectPeriod([], "2026-08", AUG)).toBeNull();
    expect(selectPeriod([], undefined, AUG)).toBeNull();
  });

  it("tolerates duplicate periods, one per insight row", () => {
    const sel = selectPeriod(["2026-07", "2026-07", "2026-06"], undefined, AUG);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null, clampedFrom: null });
  });

  it("derives the current month in UTC, where every period bound lives", () => {
    // 01:00 UTC on the 1st is still the previous evening in US zones — the
    // month must already be August, or the boundary would move with the
    // display timezone.
    const boundary = new Date(Date.UTC(2026, 7, 1, 1));
    expect(selectPeriod(["2026-07"], "2026-08", boundary)?.period).toBe("2026-08");
    // The default lands there too — the day this matters most is the 1st.
    const sel = selectPeriod(["2026-07"], undefined, boundary);
    expect(sel).toEqual({ period: "2026-08", prevPeriod: "2026-07", nextPeriod: null, clampedFrom: null });
  });
});
