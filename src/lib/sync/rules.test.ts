import { describe, expect, it } from "vitest";
import { containsAtLetterBoundary } from "./rules";

/**
 * The cases here are not invented. Every REJECT is a collision the rule audit
 * found latent in the shipped pack or in a rule made from the UI, and every
 * KEEP is a merchant variant that exists in real transaction data — so a change
 * that "fixes" the rejects by breaking the keeps has fixed nothing.
 *
 * Inputs are already collapsed and lowercased, as `matches` hands them over.
 */
describe("containsAtLetterBoundary", () => {
  describe("rejects a value that cuts into a longer word", () => {
    const collisions: [value: string, merchant: string][] = [
      ["sage", "sagebrush"],
      ["bucks", "starbucks"],
      ["aldi", "grimaldi's"],
      ["uber", "gruber bakery"],
      ["steam", "steamboat grill"],
      ["shell", "bombshell beauty"],
      ["kohl", "kohler plumbing"],
      ["adobe", "adobelands cafe"],
      ["rei", "reinvestment"],
      ["ulta", "consultant services"],
      ["avis", "davis pharmacy"],
    ];
    for (const [value, merchant] of collisions) {
      it(`"${value}" does not claim "${merchant}"`, () => {
        expect(containsAtLetterBoundary(merchant, value)).toBe(false);
      });
    }
  });

  describe("keeps the decorations a bank actually adds", () => {
    const variants: [value: string, merchant: string][] = [
      // Store number glued to the front, seen on 4 real rows.
      ["a hanover food center", "410a hanover food center"],
      // Per-charge reference suffix; the value's own "*" anchors it.
      ["blizzard *", "blizzard *us1000000001"],
      ["heb #", "heb #1234"],
      // Digits either side are decoration, never a word.
      ["shell", "shell 74821"],
      ["aldi", "aldi 0472"],
      // Ordinary word-boundary matches.
      ["belle mie", "belle mie - maple st"],
      ["van leeuwen", "van leeuwen ice cream"],
      ["mr sage", "mr sage fairview il"],
      // Exact.
      ["bucks", "bucks"],
    ];
    for (const [value, merchant] of variants) {
      it(`"${value}" still claims "${merchant}"`, () => {
        expect(containsAtLetterBoundary(merchant, value)).toBe(true);
      });
    }
  });

  it("scans every occurrence, not just the first", () => {
    // "bucks" cuts into "garden" at index 6 and stands alone at the end. The
    // clean one is what counts, so a first-match-only check would be wrong.
    expect(containsAtLetterBoundary("olive garden and bucks", "bucks")).toBe(true);
  });

  it("treats a punctuation edge on the VALUE as already anchored", () => {
    // The right-hand side is never tested when the value ends in a separator,
    // which is what keeps reference suffixes matching.
    expect(containsAtLetterBoundary("sq *pierogi", "sq *")).toBe(true);
  });

  it("is unchanged for values that do not appear at all", () => {
    expect(containsAtLetterBoundary("costco wholesale", "sage")).toBe(false);
  });

  it("refuses an empty needle rather than matching everything", () => {
    expect(containsAtLetterBoundary("anything", "")).toBe(false);
  });

  it("accepts a digit-led value against a digit-led merchant", () => {
    expect(containsAtLetterBoundary("7-eleven 221", "7-eleven")).toBe(true);
  });
});
