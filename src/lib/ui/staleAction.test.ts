import { describe, expect, it } from "vitest";
import { staleAction, SIMPLEFIN_RECONNECT_URL, type StaleCandidate } from "./staleAction";

const acct = (over: Partial<StaleCandidate> = {}): StaleCandidate => ({
  name: "Riverstone Rewards Visa",
  connectorType: "SIMPLEFIN",
  balanceLagDays: 6,
  behind: true,
  ...over,
});

describe("staleAction", () => {
  it("names one stale SimpleFIN account with its lag and the hosted reconnect link", () => {
    const a = staleAction([acct()]);
    expect(a?.sentence).toBe("Riverstone Rewards Visa is 6 days behind");
    expect(a?.href).toBe(SIMPLEFIN_RECONNECT_URL);
  });

  it("says one day in the singular", () => {
    expect(staleAction([acct({ balanceLagDays: 1 })])?.sentence).toBe("Riverstone Rewards Visa is 1 day behind");
  });

  it("is null when nothing is behind", () => {
    expect(staleAction([acct({ behind: false })])).toBeNull();
    expect(staleAction([])).toBeNull();
  });

  it("never names a statement-only CSV or PDF account", () => {
    expect(staleAction([acct({ connectorType: "CSV" }), acct({ connectorType: "PDF", name: "Archive" })])).toBeNull();
    const a = staleAction([acct({ connectorType: "CSV", name: "Old Card" }), acct()]);
    expect(a?.names).toEqual(["Riverstone Rewards Visa"]);
  });

  it("words several accounts as one alert naming the count and the accounts", () => {
    const two = staleAction([acct(), acct({ name: "Harbor Checking" })]);
    expect(two?.sentence).toBe("2 accounts are behind: Riverstone Rewards Visa and Harbor Checking");
    const three = staleAction([acct({ name: "A" }), acct({ name: "B" }), acct({ name: "C" })]);
    expect(three?.sentence).toBe("3 accounts are behind: A, B and C");
  });
});
