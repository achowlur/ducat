import { describe, expect, it } from "vitest";
import {
  encodeCategoryParam,
  parseCategoryParam,
  transactionsHref,
  UNCATEGORIZED,
} from "./categoryFilter";

describe("category filter wire format", () => {
  it("round-trips a single category", () => {
    const encoded = encodeCategoryParam(["cat-dining"]);
    expect(encoded).toBe("cat-dining");
    expect(parseCategoryParam(encoded)).toEqual({ ids: ["cat-dining"], uncategorized: false });
  });

  it("round-trips the uncategorized bucket, which is a category and not an absence", () => {
    const encoded = encodeCategoryParam([null]);
    expect(encoded).toBe(UNCATEGORIZED);
    expect(parseCategoryParam(encoded)).toEqual({ ids: [], uncategorized: true });
  });

  it("round-trips a mixed list — an Other slice can contain the uncategorized pile", () => {
    const encoded = encodeCategoryParam(["cat-gas", null, "cat-travel"]);
    expect(parseCategoryParam(encoded)).toEqual({ ids: ["cat-gas", "cat-travel"], uncategorized: true });
  });

  it("treats no filter and an empty filter alike", () => {
    expect(parseCategoryParam(undefined)).toBeNull();
    expect(parseCategoryParam("")).toBeNull();
    expect(parseCategoryParam("  ")).toBeNull();
    expect(parseCategoryParam(",,")).toBeNull();
  });

  it("drops duplicates rather than repeating them in the IN clause", () => {
    expect(encodeCategoryParam(["a", "a", null, null])).toBe(`a,${UNCATEGORIZED}`);
    expect(parseCategoryParam("a,a,b")).toEqual({ ids: ["a", "b"], uncategorized: false });
  });

  it("builds hrefs that survive their own parser", () => {
    const href = transactionsHref(["cat-gas", null], "2026-07");
    const parsed = new URL(href, "http://x").searchParams;
    expect(parsed.get("period")).toBe("2026-07");
    expect(parseCategoryParam(parsed.get("category") ?? undefined)).toEqual({
      ids: ["cat-gas"],
      uncategorized: true,
    });
  });

  it("omits an empty category param instead of filtering to nothing", () => {
    expect(transactionsHref([], "2026-07")).toBe("/transactions?period=2026-07");
    expect(transactionsHref([])).toBe("/transactions");
  });
});
