import { describe, expect, it } from "vitest";
import { higherThan, titleCase } from "./format";

describe("higherThan", () => {
  it("states an anomaly's magnitude as a rank", () => {
    expect(higherThan(0.96, "your Dining")).toBe("higher than 96% of your Dining");
    expect(higherThan(0.7123, "prior months")).toBe("higher than 71% of prior months");
  });

  // Rounding UP would let 399/400 read as "higher than 100%", a claim the data
  // does not support.
  it("rounds down, and says 'all' rather than 100%", () => {
    expect(higherThan(0.9975, "your Dining")).toBe("higher than 99% of your Dining");
    expect(higherThan(1, "prior months")).toBe("higher than all prior months");
  });

  // Rows stored before the field existed, which regeneration replaces.
  it("falls back when the fraction is missing or zero", () => {
    expect(higherThan(undefined, "your Dining")).toBe("unusual for your Dining");
    expect(higherThan(0, "your Dining")).toBe("unusual for your Dining");
  });
});

describe("titleCase", () => {
  it("capitalizes word starts across the separators merchants actually use", () => {
    expect(titleCase("zelle payment to john smith")).toBe("Zelle Payment To John Smith");
    expect(titleCase("cvs/pharmacy")).toBe("Cvs/Pharmacy");
    expect(titleCase("in-n-out burger")).toBe("In-N-Out Burger");
    expect(titleCase("7-eleven")).toBe("7-Eleven");
    expect(titleCase("pg&e web pay")).toBe("Pg&E Web Pay");
  });

  it("does not capitalize after apostrophes", () => {
    expect(titleCase("trader joe's #058")).toBe("Trader Joe's #058");
    expect(titleCase("casey's general store")).toBe("Casey's General Store");
  });
});

describe("titleCase and domain suffixes", () => {
  /**
   * The dot is a word separator, which is right for a name and wrong for a
   * domain: /insights rendered its two subscription merchants as
   * "Coursera.Org" and "Link.Com".
   */
  it("leaves a domain suffix lowercase", () => {
    expect(titleCase("coursera.org")).toBe("Coursera.org");
    expect(titleCase("link.com")).toBe("Link.com");
    expect(titleCase("company.io")).toBe("Company.io");
  });

  it("still capitalises after a dot that is really a separator", () => {
    expect(titleCase("st. louis market")).toBe("St. Louis Market");
  });

  /**
   * The suffix list contains "co", so a word merely STARTING with one of them
   * must not be swallowed — the guard is a boundary, not a prefix match.
   */
  it("does not lowercase a word that merely begins with a suffix", () => {
    expect(titleCase("coring services")).toBe("Coring Services");
    expect(titleCase("acme.commerce")).toBe("Acme.Commerce");
  });
});
