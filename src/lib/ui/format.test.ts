import { describe, expect, it } from "vitest";
import { titleCase } from "./format";

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
