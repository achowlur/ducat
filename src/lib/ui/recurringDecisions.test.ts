import { describe, expect, it } from "vitest";
import { annualisedTotal, type DetectedCharge, type DetectedSubscription } from "../health/detectedSubscriptions";
import { upcomingCommitments } from "../health/commitments";
import type { SubscriptionStatus } from "../health/types";
import { ALERTS_IN_VIEW, recurringAlerts } from "./recurringAlerts";
import { decide, isCancelled, livePlans, NO_DECISIONS, parseDecisions, type Choice, type Decisions } from "./recurringDecisions";

// All figures and names are invented.
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
const NOW = utc(2026, 10, 18);

function charge(over: Partial<DetectedCharge> & { merchant: string; lastDate: string }): DetectedCharge {
  return {
    cadence: "MONTHLY",
    averageAmount: 20,
    lastAmount: 20,
    occurrences: 12,
    priceIncreased: false,
    accountThrough: "2026-10-18",
    ...over,
  };
}

/** A plan whose price rose: 15.49 to 17.99, 16%. */
const streamflix = charge({
  merchant: "streamflix",
  averageAmount: 15.49,
  lastAmount: 17.99,
  currentAmount: 17.99,
  previousAverageAmount: 15.49,
  priceIncreased: true,
  lastDate: "2026-10-09",
});
/** A plan that stopped charging: last charge 40 days back, the account's records run on. */
const gym = charge({ merchant: "ironleaf fitness", averageAmount: 34.99, lastAmount: 34.99, lastDate: "2026-09-08" });
const internet = charge({
  merchant: "brightwave internet",
  averageAmount: 65,
  lastAmount: 80,
  currentAmount: 80,
  previousAverageAmount: 65,
  priceIncreased: true,
  lastDate: "2026-10-17",
});
const phone = charge({
  merchant: "parcel mobile",
  averageAmount: 40,
  lastAmount: 45,
  currentAmount: 45,
  previousAverageAmount: 40,
  priceIncreased: true,
  lastDate: "2026-10-14",
});
const steady = charge({ merchant: "citylight electric", averageAmount: 97.53, lastAmount: 97.53, lastDate: "2026-10-12" });

const plans = (cs: DetectedCharge[], d: Decisions = NO_DECISIONS, asOf = NOW) => livePlans(cs, d, asOf);

function applied(choice: Choice, plan: string, cs: DetectedCharge[], d: Decisions, now = NOW): Decisions {
  const next = decide(choice, plan, plans(cs, d, now), d, now);
  if (!next.ok) throw new Error(next.message);
  return next.decisions;
}

describe("which alerts show", () => {
  it("shows a price rise that is still news and a plan that stopped charging, in words", () => {
    const { shown, folded } = recurringAlerts(plans([streamflix, gym, steady]), NO_DECISIONS, NOW);
    expect(folded).toHaveLength(0);
    const rise = shown.find((a) => a.kind === "Price up");
    const missed = shown.find((a) => a.kind === "Not charging");
    expect(rise?.text).toBe("Streamflix rose 16% to $17.99");
    expect(rise?.detail).toBe("Renews in 22 days");
    expect(rise?.actions.map((a) => a.label)).toEqual(["Keep", "Cancelled"]);
    expect(missed?.text).toBe("Ironleaf Fitness has not charged since September");
    expect(missed?.detail).toBe("Last charge Sep 8");
    expect(missed?.actions.map((a) => a.label)).toEqual(["Still active", "Cancelled"]);
  });

  it("shows at most two, ranked by what the plan costs a year, and folds the rest", () => {
    const { shown, folded } = recurringAlerts(plans([streamflix, gym, internet, phone, steady]), NO_DECISIONS, NOW);
    expect(ALERTS_IN_VIEW).toBe(2);
    expect(shown.map((a) => a.plan)).toEqual(["brightwave internet", "parcel mobile"]);
    expect(folded.map((a) => a.plan)).toEqual(["ironleaf fitness", "streamflix"]);
  });

  it("shows nothing when nothing needs an answer, never a malformed alert", () => {
    expect(recurringAlerts(plans([steady]), NO_DECISIONS, NOW)).toEqual({ shown: [], folded: [] });
    expect(recurringAlerts([], NO_DECISIONS, NOW)).toEqual({ shown: [], folded: [] });
  });

  it("calls a plan missed once, never also a price rise", () => {
    const both = charge({ ...gym, priceIncreased: true, currentAmount: 40, previousAverageAmount: 34.99 });
    const { shown } = recurringAlerts(plans([both]), NO_DECISIONS, NOW);
    expect(shown.map((a) => a.kind)).toEqual(["Not charging"]);
  });

  it("names the year when the last charge was in an earlier one", () => {
    const old = charge({ merchant: "pocketbook", lastDate: "2025-12-20", cadence: "QUARTERLY", accountThrough: "2026-10-18" });
    const [alert] = recurringAlerts([{ ...old, tracked: false }], NO_DECISIONS, NOW).shown;
    expect(alert.text).toBe("Pocketbook has not charged since December 2025");
    expect(alert.detail).toBe("Last charge Dec 20, 2025");
  });
});

describe("Keep", () => {
  it("hides that rise, and changes no total", () => {
    const before = plans([streamflix, steady]);
    const d = applied("keep", "streamflix", [streamflix, steady], NO_DECISIONS);
    expect(recurringAlerts(plans([streamflix, steady], d), d, NOW).shown).toEqual([]);
    expect(annualisedTotal(plans([streamflix, steady], d))).toBe(annualisedTotal(before));
    expect(upcomingCommitments(plans([streamflix, steady], d), [], NOW).total).toBe(
      upcomingCommitments(before, [], NOW).total,
    );
  });

  it("shows the plan again when the price changes again", () => {
    const d = applied("keep", "streamflix", [streamflix], NO_DECISIONS);
    const raisedAgain = { ...streamflix, currentAmount: 19.99, lastAmount: 19.99, previousAverageAmount: 17.99 };
    const { shown } = recurringAlerts(plans([raisedAgain], d), d, NOW);
    expect(shown.map((a) => a.text)).toEqual(["Streamflix rose 11% to $19.99"]);
  });
});

describe("Still active", () => {
  const cs = [gym];

  it("hides the missed alert, and changes no total", () => {
    const d = applied("still", "ironleaf fitness", cs, NO_DECISIONS);
    expect(recurringAlerts(plans(cs, d), d, NOW).shown).toEqual([]);
    // Missed was already out of both figures and still is: the answer is not a charge.
    expect(annualisedTotal(plans(cs, d).filter((p) => p.lastDate > "2026-10-01"))).toBe(0);
  });

  it("holds while the next expected charge is still to come, then the plan lapses and the alert with it", () => {
    const d = applied("still", "ironleaf fitness", cs, NO_DECISIONS);
    // The next billing date after the answer is Nov 8, which is also two cycles
    // after the last charge: the day the detector lapses the plan on its own.
    const due = utc(2026, 11, 8);
    expect(recurringAlerts(plans(cs, d, due), d, due).shown).toEqual([]);
    expect(plans(cs, d, due)).toHaveLength(1);
    const passed = utc(2026, 11, 10);
    expect(plans(cs, d, passed)).toEqual([]);
    expect(recurringAlerts(plans(cs, d, passed), d, passed).shown).toEqual([]);
  });

  it("does not cover a later miss after the plan charged again", () => {
    const d = applied("still", "ironleaf fitness", cs, NO_DECISIONS);
    const charged = { ...gym, lastDate: "2026-11-08", accountThrough: "2026-12-20" };
    const later = utc(2026, 12, 20);
    expect(recurringAlerts(plans([charged], d, later), d, later).shown.map((a) => a.kind)).toEqual(["Not charging"]);
  });
});

describe("Cancelled", () => {
  const registered: SubscriptionStatus = {
    id: "reg-1",
    name: "Streamflix",
    merchantPattern: "streamflix",
    enabled: true,
    expectedAmount: 15.49,
    cadence: "MONTHLY",
    nextPaymentDate: utc(2026, 11, 9),
    daysUntilNextPayment: 22,
    lastCharge: null,
    priceDrift: null,
  };

  it("takes the plan out of the yearly total and the commitments, as a lapsed plan goes", () => {
    const all = [streamflix, steady];
    const d = applied("cancel", "streamflix", all, NO_DECISIONS);
    const live = plans(all, d);
    expect(live.map((p) => p.merchant)).toEqual(["citylight electric"]);
    expect(annualisedTotal(live)).toBe(Math.round(97.53 * 12 * 100) / 100);
    const merged = plans(all, NO_DECISIONS);
    const commitments = upcomingCommitments(merged, [], NOW, 30, (s) => isCancelled(s, d));
    expect(commitments.items.map((i) => i.merchant)).toEqual(["citylight electric"]);
    expect(commitments.total).toBe(97.53);
  });

  it("keeps a hand-declared twin from billing the window in the plan's place", () => {
    const d = applied("cancel", "streamflix", [streamflix], NO_DECISIONS);
    const merged = plans([streamflix], NO_DECISIONS);
    const items = upcomingCommitments(merged, [registered], NOW, 30, (s) => isCancelled(s, d)).items;
    expect(items).toEqual([]);
    // Without the decision the twin and the plan are both counted once.
    expect(upcomingCommitments(merged, [registered], NOW).items).toHaveLength(1);
  });

  it("takes a missed plan out too, and an alert never returns for it", () => {
    const d = applied("cancel", "ironleaf fitness", [gym], NO_DECISIONS);
    expect(plans([gym], d)).toEqual([]);
    expect(recurringAlerts(plans([gym], d), d, NOW).shown).toEqual([]);
  });

  it("brings the plan back when it charges again", () => {
    const d = applied("cancel", "streamflix", [streamflix], NO_DECISIONS);
    const chargedAgain = { ...streamflix, lastDate: "2026-11-09" };
    expect(isCancelled(chargedAgain, d)).toBe(false);
    expect(isCancelled(streamflix, d)).toBe(true);
  });

  it("reaches a plan under every name it was folded from", () => {
    const twin = charge({ merchant: "streamflix com", averageAmount: 15.49, lastAmount: 17.99, lastDate: "2026-10-09" });
    const merged = plans([streamflix, twin]);
    expect(merged).toHaveLength(1);
    const d = applied("cancel", "streamflix com", [streamflix, twin], NO_DECISIONS);
    expect(plans([streamflix, twin], d)).toEqual([]);
    expect(isCancelled(twin, d)).toBe(true);
  });

  it("only says what to show and count: the decision holds no transaction", () => {
    const d = applied("cancel", "streamflix", [streamflix], NO_DECISIONS);
    expect(Object.keys(d.cancelled[0]).sort()).toEqual(["lastDate", "names"]);
  });
});

describe("refusals", () => {
  it("refuses a plan that is no longer listed, in a sentence for the control", () => {
    const result = decide("keep", "gone plan", plans([streamflix]), NO_DECISIONS, NOW);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("no longer on the list") });
  });

  it("refuses to keep a rise that is not news, or was already kept", () => {
    const flat = decide("keep", "citylight electric", plans([steady]), NO_DECISIONS, NOW);
    expect(flat.ok).toBe(false);
    const d = applied("keep", "streamflix", [streamflix], NO_DECISIONS);
    expect(decide("keep", "streamflix", plans([streamflix], d), d, NOW).ok).toBe(false);
  });

  it("refuses 'still active' for a plan that has not missed a charge", () => {
    const result = decide("still", "citylight electric", plans([steady]), NO_DECISIONS, NOW);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("not missing a charge") });
  });

  it("refuses a plan a cancel already took off the list", () => {
    const d = applied("cancel", "streamflix", [streamflix], NO_DECISIONS);
    const again = decide("cancel", "streamflix", plans([streamflix], d), d, NOW);
    expect(again.ok).toBe(false);
  });

  it("is the same function the page's list is built from: a plan on the page can always be decided", () => {
    for (const choice of ["keep", "still", "cancel"] as const) {
      const cs = [streamflix, gym, steady];
      for (const alert of recurringAlerts(plans(cs), NO_DECISIONS, NOW).shown) {
        if (alert.actions.some((a) => a.choice === choice)) {
          expect(decide(choice, alert.plan, plans(cs), NO_DECISIONS, NOW).ok).toBe(true);
        }
      }
    }
  });
});

describe("the stored decisions", () => {
  it("survive a round trip and keep only the newest 40 of a kind", () => {
    let d = NO_DECISIONS;
    const many = Array.from({ length: 45 }, (_, i) =>
      charge({ ...streamflix, merchant: `plan ${i}`, averageAmount: 10 + i, lastAmount: 12 + i, currentAmount: 12 + i }),
    );
    for (const c of many) d = applied("cancel", c.merchant, many, d);
    expect(d.cancelled).toHaveLength(40);
    expect(parseDecisions(JSON.stringify(d))).toEqual(d);
  });

  it("read as none when absent or unreadable, never a failure", () => {
    expect(parseDecisions(null)).toEqual(NO_DECISIONS);
    expect(parseDecisions("not json")).toEqual(NO_DECISIONS);
    expect(parseDecisions('{"keep":"x","still":[{"names":[],"lastDate":"2026-10-01"}],"cancelled":[{"lastDate":1}]}')).toEqual(
      NO_DECISIONS,
    );
  });
});

describe("DetectedSubscription", () => {
  it("lists every merchant string a plan was folded from", () => {
    const [merged] = plans([streamflix, charge({ merchant: "streamflix com", averageAmount: 15.49, lastAmount: 17.99, lastDate: "2026-10-09" })]);
    expect((merged as DetectedSubscription).members?.sort()).toEqual(["streamflix", "streamflix com"]);
  });
});
