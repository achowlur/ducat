import { describe, expect, it } from "vitest";
import { P2P_UNREVIEWED_ID } from "../p2p";
import {
  encodeCategoryParam,
  nullBucketFilter,
  parseCategoryParam,
  transactionsHref,
  UNCATEGORIZED,
} from "./categoryFilter";

describe("category filter wire format", () => {
  it("round-trips a single category", () => {
    const encoded = encodeCategoryParam(["cat-dining"]);
    expect(encoded).toBe("cat-dining");
    expect(parseCategoryParam(encoded)).toEqual({ ids: ["cat-dining"], uncategorized: false, p2p: false });
  });

  it("round-trips the uncategorized bucket, which is a category and not an absence", () => {
    const encoded = encodeCategoryParam([null]);
    expect(encoded).toBe(UNCATEGORIZED);
    expect(parseCategoryParam(encoded)).toEqual({ ids: [], uncategorized: true, p2p: false });
  });

  it("round-trips a mixed list — an Other slice can contain the uncategorized pile", () => {
    const encoded = encodeCategoryParam(["cat-gas", null, "cat-travel"]);
    expect(parseCategoryParam(encoded)).toEqual({ ids: ["cat-gas", "cat-travel"], uncategorized: true, p2p: false });
  });

  it("treats no filter and an empty filter alike", () => {
    expect(parseCategoryParam(undefined)).toBeNull();
    expect(parseCategoryParam("")).toBeNull();
    expect(parseCategoryParam("  ")).toBeNull();
    expect(parseCategoryParam(",,")).toBeNull();
  });

  it("drops duplicates rather than repeating them in the IN clause", () => {
    expect(encodeCategoryParam(["a", "a", null, null])).toBe(`a,${UNCATEGORIZED}`);
    expect(parseCategoryParam("a,a,b")).toEqual({ ids: ["a", "b"], uncategorized: false, p2p: false });
  });

  it("builds hrefs that survive their own parser", () => {
    const href = transactionsHref(["cat-gas", null], "2026-07");
    const parsed = new URL(href, "http://x").searchParams;
    expect(parsed.get("period")).toBe("2026-07");
    expect(parseCategoryParam(parsed.get("category") ?? undefined)).toEqual({
      ids: ["cat-gas"],
      uncategorized: true,
      p2p: false,
    });
  });

  it("omits an empty category param instead of filtering to nothing", () => {
    expect(transactionsHref([], "2026-07")).toBe("/transactions?period=2026-07");
    expect(transactionsHref([])).toBe("/transactions");
  });
});

describe("the two buckets with no category", () => {
  const zelle = { normalizedMerchant: "zelle to jane doe", description: "ZELLE TO JANE DOE", categoryId: null, reimbursesId: null, flow: "OUTFLOW" };
  const plain = { normalizedMerchant: "corner cafe", description: "CORNER CAFE", categoryId: null, reimbursesId: null, flow: "OUTFLOW" };
  const dining = { ...plain, categoryId: "cat-dining" };

  it("round-trips the P2P slice's id as its own token", () => {
    const encoded = encodeCategoryParam([P2P_UNREVIEWED_ID, "cat-gas"]);
    expect(parseCategoryParam(encoded)).toEqual({ ids: ["cat-gas"], uncategorized: false, p2p: true });
  });

  it("keeps Uncategorized and P2P — Unreviewed disjoint, so each lists what its slice counts", () => {
    const uncategorizedOnly = nullBucketFilter(parseCategoryParam(UNCATEGORIZED))!;
    expect([zelle, plain, dining].map(uncategorizedOnly)).toEqual([false, true, true]);
    const p2pOnly = nullBucketFilter(parseCategoryParam(P2P_UNREVIEWED_ID))!;
    expect([zelle, plain, dining].map(p2pOnly)).toEqual([true, false, true]);
  });

  it("puts a repayment already LINKED to its expense in Uncategorized, since a link is a decision", () => {
    const linked = { ...zelle, flow: "INFLOW", reimbursesId: "t-dinner" };
    expect(nullBucketFilter(parseCategoryParam(UNCATEGORIZED))!(linked)).toBe(true);
  });

  it("needs no in-memory split when both buckets, or neither, are selected", () => {
    expect(nullBucketFilter(parseCategoryParam(`${UNCATEGORIZED},${P2P_UNREVIEWED_ID}`))).toBeNull();
    expect(nullBucketFilter(parseCategoryParam("cat-gas"))).toBeNull();
    expect(nullBucketFilter(null)).toBeNull();
  });
});
