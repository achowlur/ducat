import { describe, expect, it } from "vitest";
import { B_DEFAULTS, E_DEFAULTS, parseTarget, parseTrendsParams } from "./trendsParams";

const noCookie = () => undefined;

describe("parseTrendsParams", () => {
  it("opens every card on its documented default", () => {
    const p = parseTrendsParams({}, noCookie);
    expect(p.a).toEqual({ view: "running" });
    expect(p.b).toEqual({ view: "change", ...B_DEFAULTS });
    // Build your own: income by month, for everything, this year so far, as bars.
    expect(p.e).toEqual({ view: "bars", ...E_DEFAULTS, for: null });
    expect(E_DEFAULTS).toEqual({ show: "income", by: "month", over: "ytd" });
  });

  it("reads each card's own parameters and leaves the others alone", () => {
    const p = parseTrendsParams({ "e.show": "spending", "e.over": "12m", "b.by": "merchant" }, noCookie);
    expect(p.e).toMatchObject({ show: "spending", over: "12m", by: "month" });
    expect(p.b).toMatchObject({ by: "merchant", span: B_DEFAULTS.span, show: B_DEFAULTS.show });
  });

  it("offers income and spending together only by month", () => {
    expect(parseTrendsParams({ "e.show": "both" }, noCookie).e.show).toBe("both");
    expect(parseTrendsParams({ "e.show": "both", "e.by": "category" }, noCookie).e.show).toBe(E_DEFAULTS.show);
  });

  it("takes one month named outright, and refuses anything else it does not know", () => {
    expect(parseTrendsParams({ "e.over": "2026-09" }, noCookie).e.over).toBe("2026-09");
    expect(parseTrendsParams({ "e.over": "2026-13" }, noCookie).e.over).toBe(E_DEFAULTS.over);
    expect(parseTrendsParams({ "e.over": "forever" }, noCookie).e.over).toBe(E_DEFAULTS.over);
  });

  it("honours a remembered chart only where the data's shape allows it", () => {
    const pie = (name: string) => (name === "trends.e" ? "pie" : undefined);
    expect(parseTrendsParams({ "e.by": "category" }, pie).e.view).toBe("pie");
    // Months are not parts of a whole: a remembered pie opens as bars.
    expect(parseTrendsParams({}, pie).e.view).toBe("bars");
    // The URL outranks the cookie.
    expect(parseTrendsParams({ "e.by": "category", "e.view": "table" }, pie).e.view).toBe("table");
  });
});

describe("parseTarget", () => {
  it("reads a group and its key, keeping a key that holds a colon", () => {
    expect(parseTarget("category:cat-1")).toEqual({ by: "category", key: "cat-1" });
    expect(parseTarget("merchant:shop: north")).toEqual({ by: "merchant", key: "shop: north" });
    expect(parseTarget("planet:mars")).toBeNull();
    expect(parseTarget("category:")).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
  });
});
