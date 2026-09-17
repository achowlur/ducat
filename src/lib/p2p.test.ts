import { describe, expect, it } from "vitest";
import { isP2P, isUnreviewedP2P, P2P_PATTERN, P2P_PREFILTER_WORDS } from "./p2p";

describe("the SQL pre-filter", () => {
  // Every spelling P2P_PATTERN accepts, generated from the pattern itself so a
  // rail added later is covered without anyone remembering this test.
  const alternatives = /\\b\((.*)\)\\b/.exec(P2P_PATTERN.source)![1].split("|");
  const spellings = alternatives.flatMap((a) =>
    a.includes(" ?") ? [a.replace(" ?", " "), a.replace(" ?", "")] : [a],
  );

  it("is generated from every rail in the pattern", () => {
    expect(spellings).toContain("cash app");
    expect(spellings).toContain("cashapp");
    expect(spellings.length).toBeGreaterThanOrEqual(alternatives.length);
  });

  it("is a SUPERSET: nothing the pattern calls P2P can be filtered out in SQL", () => {
    for (const s of spellings) {
      const text = `payment ${s.toUpperCase()} to someone`;
      expect(P2P_PATTERN.test(text), s).toBe(true);
      expect(
        P2P_PREFILTER_WORDS.some((w) => text.toLowerCase().includes(w)),
        `no pre-filter word covers "${s}"`,
      ).toBe(true);
    }
  });
});

describe("isUnreviewedP2P", () => {
  const zelle = {
    normalizedMerchant: "zelle to jane doe",
    description: "ZELLE TO JANE DOE ON 07/18",
    categoryId: null,
    reimbursesId: null,
    flow: "OUTFLOW",
  };

  it("is a P2P payment with no category that is neither a transfer nor a linked repayment", () => {
    expect(isUnreviewedP2P(zelle)).toBe(true);
    expect(isUnreviewedP2P({ ...zelle, flow: "INFLOW" })).toBe(true);
    expect(isUnreviewedP2P({ ...zelle, categoryId: "cat-rent" })).toBe(false);
    expect(isUnreviewedP2P({ ...zelle, flow: "TRANSFER" })).toBe(false);
    expect(isUnreviewedP2P({ ...zelle, flow: "INFLOW", reimbursesId: "t-dinner" })).toBe(false);
  });

  it("reads the rail from either the merchant or the description", () => {
    expect(isP2P({ normalizedMerchant: "jane doe", description: "VENMO PAYMENT 1000000001" })).toBe(true);
    expect(isP2P({ normalizedMerchant: "zelle to jane doe", description: "" })).toBe(true);
    expect(isP2P({ normalizedMerchant: "corner cafe", description: "CORNER CAFE" })).toBe(false);
  });
});
