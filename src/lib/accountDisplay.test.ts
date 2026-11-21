import { describe, expect, it } from "vitest";
import {
  accountLabel,
  accountNumber,
  normalizeAccountName,
  parseAccountNames,
  parseHiddenOnOverview,
  withAccountLabels,
} from "./accountDisplay";

// Invented names and numbers.
describe("account display names", () => {
  it("prints a typed name with the feed's account number beside it", () => {
    const names = { a1: "Long-term", a2: "Travel 0007" };
    expect(accountLabel({ id: "a1", name: "Individual - TOD (0003)" }, names)).toBe("Long-term (0003)");
    // A typed name already carrying the number is not given it twice.
    expect(accountLabel({ id: "a2", name: "Rewards Visa ...0007 (0007)" }, names)).toBe("Travel 0007");
    // A feed name with no number: the typed name alone.
    expect(accountLabel({ id: "a1", name: "Brokerage" }, names)).toBe("Long-term");
    // Nothing typed: the feed's own name.
    expect(accountLabel({ id: "a9", name: "Savings (0002)" }, names)).toBe("Savings (0002)");
  });

  it("relabels rows without touching the ones it has no name for", () => {
    const rows = [{ id: "a1", name: "Individual - TOD (0003)", type: "INVESTMENT" }, { id: "a2", name: "Checking (0004)", type: "DEPOSITORY" }];
    const out = withAccountLabels(rows, { a1: "Long-term" });
    expect(out.map((r) => r.name)).toEqual(["Long-term (0003)", "Checking (0004)"]);
    expect(out[1]).toBe(rows[1]);
    expect(rows[0].name).toBe("Individual - TOD (0003)");
  });

  it("reads the number off the end, and tolerates bad settings", () => {
    expect(accountNumber("Everyday Checking ...0001 (0001)")).toBe("0001");
    expect(accountNumber("Brokerage")).toBeNull();
    expect(normalizeAccountName("  Long   term ")).toBe("Long term");
    expect(normalizeAccountName("   ")).toBeNull();
    expect(parseAccountNames('{"a1":"Long-term","a2":"  ","a3":4}')).toEqual({ a1: "Long-term" });
    expect(parseAccountNames("nope")).toEqual({});
    expect([...parseHiddenOnOverview('["a1",2]')]).toEqual(["a1"]);
    expect([...parseHiddenOnOverview(null)]).toEqual([]);
  });
});
