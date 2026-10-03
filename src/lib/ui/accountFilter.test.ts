import { describe, expect, it } from "vitest";
import { accountFilterSummary, accountsHref, encodeAccountParam, parseAccountParam } from "./accountFilter";

describe("parseAccountParam", () => {
  it("reads no filter as null", () => {
    expect(parseAccountParam(undefined)).toBeNull();
    expect(parseAccountParam("")).toBeNull();
    expect(parseAccountParam("  ")).toBeNull();
    expect(parseAccountParam(",, ,")).toBeNull();
    expect(parseAccountParam([])).toBeNull();
  });

  it("reads a single id as a list of one, as links written before the list did", () => {
    expect(parseAccountParam("acc1")).toEqual(["acc1"]);
  });

  it("reads a comma-separated list in order", () => {
    expect(parseAccountParam("acc1,acc2,acc3")).toEqual(["acc1", "acc2", "acc3"]);
  });

  it("drops blanks, padding and repeats", () => {
    expect(parseAccountParam(" acc1 ,,acc2, acc1 ")).toEqual(["acc1", "acc2"]);
  });

  it("reads a repeated key, rather than only its first value", () => {
    expect(parseAccountParam(["acc1", "acc2"])).toEqual(["acc1", "acc2"]);
    expect(parseAccountParam(["acc1,acc2", "acc3", "acc1"])).toEqual(["acc1", "acc2", "acc3"]);
  });
});

describe("encodeAccountParam", () => {
  it("joins ids and drops repeats", () => {
    expect(encodeAccountParam(["acc1", "acc2", "acc1"])).toBe("acc1,acc2");
  });

  it("is empty when there is no filter", () => {
    expect(encodeAccountParam([])).toBe("");
    expect(encodeAccountParam(["", " "])).toBe("");
  });

  it("round-trips through parse", () => {
    const ids = ["acc3", "acc1", "acc2"];
    expect(parseAccountParam(encodeAccountParam(ids))).toEqual(ids);
  });
});

describe("accountsHref", () => {
  it("links one account exactly as the link did before the list existed", () => {
    expect(accountsHref(["acc1"])).toBe("/transactions?account=acc1");
  });

  it("survives the URL for several accounts", () => {
    const href = accountsHref(["acc1", "acc2"]);
    const value = new URL(href, "http://127.0.0.1").searchParams.get("account");
    expect(parseAccountParam(value ?? undefined)).toEqual(["acc1", "acc2"]);
  });

  it("links the whole ledger when nothing is selected", () => {
    expect(accountsHref([])).toBe("/transactions");
  });
});

describe("accountFilterSummary", () => {
  it("says All only when there is no filter", () => {
    expect(accountFilterSummary([], 0)).toBe("All");
  });

  it("names a single account", () => {
    expect(accountFilterSummary(["Everyday Checking"], 1)).toBe("Everyday Checking");
  });

  it("counts several", () => {
    expect(accountFilterSummary(["Everyday Checking", "Rewards Visa", "Roth IRA"], 3)).toBe("3 accounts");
  });

  it("does not read All over a filter naming an account that is gone", () => {
    expect(accountFilterSummary([], 1)).toBe("Unknown account");
  });
});
