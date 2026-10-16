import { describe, expect, it } from "vitest";
import { sourceCategoryToApply } from "./sourceCategory";

const row = (over: Partial<{ sourceCategory?: string; description: string; normalizedMerchant: string; flow: string }> = {}) => ({
  sourceCategory: "Dining",
  description: "MARIGOLD BISTRO",
  normalizedMerchant: "marigold bistro",
  flow: "OUTFLOW",
  ...over,
});

describe("sourceCategoryToApply", () => {
  it("applies the source's category to a card purchase no rule matched", () => {
    expect(sourceCategoryToApply(row(), "CREDIT", false)).toBe("Dining");
  });

  it("gives way to any rule, flow-only rules included", () => {
    expect(sourceCategoryToApply(row(), "CREDIT", true)).toBeNull();
  });

  it("never categorizes a P2P payment, a transfer, or a row inside an investment account", () => {
    expect(sourceCategoryToApply(row({ description: "VENMO *JANE DOE", normalizedMerchant: "venmo" }), "CREDIT", false)).toBeNull();
    expect(sourceCategoryToApply(row({ flow: "TRANSFER" }), "CREDIT", false)).toBeNull();
    expect(sourceCategoryToApply(row(), "INVESTMENT", false)).toBeNull();
  });

  it("has nothing to apply when the source named nothing", () => {
    expect(sourceCategoryToApply(row({ sourceCategory: undefined }), "CREDIT", false)).toBeNull();
    expect(sourceCategoryToApply(row({ sourceCategory: "" }), "CREDIT", false)).toBeNull();
  });
});
