import { describe, expect, it } from "vitest";
import { annualisedTotal, mergeDetectedSubscriptions, nextChargeOf } from "../health/detectedSubscriptions";
import { upcomingCommitments } from "../health/commitments";
import { recurringAlerts } from "../ui/recurringAlerts";
import { decide, livePlans, NO_DECISIONS, parseDecisions } from "../ui/recurringDecisions";
import { nudgeCandidates, type NudgeSources } from "../ui/nextAction";
import { computePace } from "./pace";
import { detectRecurringCharges } from "./recurring";
import { sharedPlan, type PlanBill } from "./sharedPlans";
import { computeSpendingByCategory } from "./spendingByCategory";
import type { TxnData } from "./types";

// Every figure, name and date is invented: a $110 phone plan split three ways.
const BILL = 110;
const THIRD = 36.5;

const bill = (date: string, repaid = 0, amount = BILL): PlanBill => ({ id: date, date, amount, repaid });

describe("sharedPlan", () => {
  it("is shared at about a third once two bills in a row were repaid by two people", () => {
    const s = sharedPlan([bill("2026-08-04"), bill("2026-09-04", 2 * THIRD), bill("2026-10-04", 2 * THIRD)]);
    expect(s).toEqual({ share: 37, unsplit: null });
  });

  it("is not shared on one repaid month: a one-off reimbursement", () => {
    expect(sharedPlan([bill("2026-08-04"), bill("2026-09-04", 2 * THIRD), bill("2026-10-04")])).toBeNull();
    expect(sharedPlan([bill("2026-09-04"), bill("2026-10-04", 2 * THIRD)])).toBeNull();
  });

  it("keeps a new bill at the share while its repayments are waiting", () => {
    const s = sharedPlan([bill("2026-08-04", 2 * THIRD), bill("2026-09-04", 2 * THIRD), bill("2026-10-04")]);
    expect(s).toEqual({ share: 37, unsplit: null });
  });

  it("names the previous bill unsplit when the next arrives with nothing linked to it", () => {
    const s = sharedPlan([
      bill("2026-07-04", 2 * THIRD),
      bill("2026-08-04", 2 * THIRD),
      bill("2026-09-04"),
      bill("2026-10-04"),
    ]);
    expect(s).toEqual({ share: 37, unsplit: { date: "2026-09-04", amount: BILL, repaid: 0 } });
  });

  it("counts a part-repaid bill at full less what came back", () => {
    const s = sharedPlan([
      bill("2026-07-04", 2 * THIRD),
      bill("2026-08-04", 2 * THIRD),
      bill("2026-09-04", THIRD),
      bill("2026-10-04"),
    ]);
    expect(s?.unsplit).toEqual({ date: "2026-09-04", amount: BILL, repaid: THIRD });
    // The short bill never enters the share's sample.
    expect(s?.share).toBe(37);
  });

  it("tolerates a few cents short", () => {
    const s = sharedPlan([bill("2026-07-04", 73), bill("2026-08-04", 73), bill("2026-09-04", 72.9), bill("2026-10-04")]);
    expect(s?.unsplit).toBeNull();
  });

  it("goes back to full price, with nothing to answer, after two unsplit bills in a row", () => {
    const bills = [bill("2026-06-04", 2 * THIRD), bill("2026-07-04", 2 * THIRD), bill("2026-08-04"), bill("2026-09-04"), bill("2026-10-04")];
    expect(sharedPlan(bills)).toBeNull();
  });

  it("stays shared after one unsplit bill once the next is repaid, and the unsplit one stays news for that cycle", () => {
    const s = sharedPlan([bill("2026-07-04", 2 * THIRD), bill("2026-08-04", 2 * THIRD), bill("2026-09-04"), bill("2026-10-04", 2 * THIRD)]);
    expect(s).toEqual({ share: 37, unsplit: { date: "2026-09-04", amount: BILL, repaid: 0 } });
  });

  it("is the middle of the recent nets, never a mean, and between two the larger", () => {
    const s = sharedPlan([bill("2026-07-04", 2 * THIRD), bill("2026-08-04", 80), bill("2026-09-04", 2 * THIRD), bill("2026-10-04", 2 * THIRD)]);
    expect(s?.share).toBe(37);
    // Two settled so far, the newest half-repaid: the share does not shrink below what is owed.
    expect(sharedPlan([bill("2026-09-04", 2 * THIRD), bill("2026-10-04", THIRD)])?.share).toBe(73.5);
  });
});

// The detector, from transactions: a phone plan and the repayments linked to it.
let seq = 0;
function txn(over: Partial<TxnData> & { date: Date; amount: number }): TxnData {
  seq += 1;
  return {
    id: `t${seq}`,
    accountId: "acct-0001",
    description: "PARCEL MOBILE AUTOPAY",
    normalizedMerchant: "parcel mobile",
    flow: over.amount < 0 ? "OUTFLOW" : "INFLOW",
    categoryId: "cat-phone",
    categoryName: "Phone",
    categoryIsIncome: false,
    reimbursesId: null,
    ...over,
  };
}
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

/** Monthly $110 bills from May to October, each repaid by two people when `repaidMonths` says so. */
function phonePlan(repaidMonths: number[]): TxnData[] {
  const rows: TxnData[] = [];
  for (let m = 5; m <= 10; m++) {
    const b = txn({ date: utc(2026, m, 4), amount: -BILL });
    rows.push(b);
    if (repaidMonths.includes(m)) {
      for (const who of ["ALEX", "SAM"]) {
        rows.push(
          txn({
            date: utc(2026, m, 7),
            amount: THIRD,
            description: `ZELLE FROM ${who}`,
            normalizedMerchant: `zelle ${who.toLowerCase()}`,
            categoryId: null,
            categoryName: null,
            reimbursesId: b.id,
          }),
        );
      }
    }
  }
  return rows;
}

describe("detectRecurringCharges carries the share", () => {
  it("is shared from the links alone, with no setup", () => {
    const plan = detectRecurringCharges(phonePlan([8, 9, 10])).get("parcel mobile");
    expect(plan?.shared).toEqual({ share: 37, unsplit: null });
    expect(plan?.currentAmount).toBe(BILL);
  });

  it("history without links stays at full price: no backfill", () => {
    expect(detectRecurringCharges(phonePlan([])).get("parcel mobile")?.shared).toBeUndefined();
    expect(detectRecurringCharges(phonePlan([10])).get("parcel mobile")?.shared).toBeUndefined();
  });

  it("names the unsplit bill when the next arrives", () => {
    const plan = detectRecurringCharges(phonePlan([7, 8])).get("parcel mobile");
    expect(plan?.shared).toEqual({ share: 37, unsplit: { date: "2026-09-04", amount: BILL, repaid: 0 } });
  });

  it("leaves spending exactly as it was: linked repayments come off once, never twice", () => {
    const rows = phonePlan([8, 9, 10]);
    // Reading the share touches no row and no analyzer: spending is the same
    // bytes after the detector ran, and each repaid month nets to the bill
    // less the 73 linked to it, exactly once.
    const periods = ["2026-07", "2026-08", "2026-09", "2026-10"];
    const bytes = (m: Map<string, unknown>) => JSON.stringify([...m]);
    const before = bytes(computeSpendingByCategory(rows, periods, "MONTH"));
    const rowsBefore = JSON.stringify(rows);
    expect(detectRecurringCharges(rows).get("parcel mobile")?.shared?.share).toBe(37);
    expect(JSON.stringify(rows)).toBe(rowsBefore);
    const spending = computeSpendingByCategory(rows, periods, "MONTH");
    expect(bytes(spending)).toBe(before);
    expect(spending.get("2026-07")?.totalSpending).toBe(110);
    expect(spending.get("2026-09")?.totalSpending).toBe(37);
  });
});

describe("every subscription figure bills the share", () => {
  const NOW = utc(2026, 10, 18);
  const payload = detectRecurringCharges(phonePlan([8, 9, 10])).get("parcel mobile")!;
  const charge = { ...payload, accountThrough: "2026-10-18" };

  it("the /yr, the next charge and the commitments", () => {
    const [sub] = mergeDetectedSubscriptions([charge]);
    expect(sub.shared?.share).toBe(37);
    expect(annualisedTotal([sub])).toBe(444);
    expect(nextChargeOf(sub, NOW).amount).toBe(37);
    const window = upcomingCommitments([sub], [], NOW, 30);
    expect(window.items.map((i) => i.amount)).toEqual([37]);
    expect(window.total).toBe(37);
  });

  it("the pace call's committed spend", () => {
    const [sub] = mergeDetectedSubscriptions([charge]);
    // On the 29th the next bill (Nov 4) falls inside the week the pace counts.
    const now = utc(2026, 10, 29);
    const due = upcomingCommitments([sub], [], now, 7).total;
    const pace = computePace({ period: "2026-10", now, spentSoFar: 500, committedRemaining: due, priors: [] });
    expect(pace.committedRemaining).toBe(37);
  });
});

describe("the Not split alert", () => {
  const NOW = utc(2026, 10, 18);
  const charge = { ...detectRecurringCharges(phonePlan([7, 8])).get("parcel mobile")!, accountThrough: "2026-10-18" };

  it("reads as the operator agreed, with Link repayments and Not shared this month", () => {
    const { shown } = recurringAlerts(livePlans([charge], NO_DECISIONS, NOW), NO_DECISIONS, NOW);
    const alert = shown.find((a) => a.kind === "Not split");
    expect(alert?.text).toBe("Parcel Mobile's September bill hasn't been split; counting the full $110.00");
    expect(alert?.detail).toBe("Billed Sep 4, your share ~$37 of $110 as usual");
    expect(alert?.actions).toEqual([
      { label: "Link repayments", href: "/transactions?flow=INFLOW&period=2026-09..2026-10" },
      { label: "Not shared this month", choice: "unshared" },
    ]);
    expect(alert?.text).not.toContain("—");
  });

  it("says what came back on a part-repaid bill", () => {
    const rows = phonePlan([7, 8]);
    const sept = rows.find((t) => t.date.getTime() === utc(2026, 9, 4).getTime())!;
    rows.push(txn({ date: utc(2026, 9, 6), amount: THIRD, description: "ZELLE FROM ALEX", normalizedMerchant: "zelle alex", categoryId: null, categoryName: null, reimbursesId: sept.id }));
    const part = { ...detectRecurringCharges(rows).get("parcel mobile")!, accountThrough: "2026-10-18" };
    const { shown } = recurringAlerts(livePlans([part], NO_DECISIONS, NOW), NO_DECISIONS, NOW);
    expect(shown.find((a) => a.kind === "Not split")?.text).toBe(
      "Parcel Mobile's September bill hasn't been fully split; counting $73.50 of $110.00",
    );
  });

  it("Not shared this month records the bill, and the alert is gone", () => {
    const plans = livePlans([charge], NO_DECISIONS, NOW);
    const result = decide("unshared", "parcel mobile", plans, NO_DECISIONS, NOW);
    if (!result.ok) throw new Error(result.message);
    expect(result.decisions.unshared).toEqual([{ names: ["parcel mobile"], lastDate: "2026-10-04", bill: "2026-09-04" }]);
    // It survives the Setting's round trip.
    const stored = parseDecisions(JSON.stringify(result.decisions));
    expect(recurringAlerts(livePlans([charge], stored, NOW), stored, NOW).shown).toEqual([]);
    // And a second answer is refused in a sentence, never thrown.
    expect(decide("unshared", "parcel mobile", livePlans([charge], stored, NOW), stored, NOW)).toEqual({
      ok: false,
      message: expect.stringContaining("no longer waiting"),
    });
  });

  it("refuses Not shared this month on a plan with nothing unsplit", () => {
    const fine = { ...detectRecurringCharges(phonePlan([8, 9, 10])).get("parcel mobile")!, accountThrough: "2026-10-18" };
    expect(decide("unshared", "parcel mobile", livePlans([fine], NO_DECISIONS, NOW), NO_DECISIONS, NOW).ok).toBe(false);
  });

  it("two unsplit in a row: back to full price and no alert", () => {
    const gone = { ...detectRecurringCharges(phonePlan([6, 7])).get("parcel mobile")!, accountThrough: "2026-10-18" };
    expect(gone.shared).toBeUndefined();
    expect(recurringAlerts(livePlans([gone], NO_DECISIONS, NOW), NO_DECISIONS, NOW).shown).toEqual([]);
    expect(annualisedTotal(mergeDetectedSubscriptions([gone]))).toBe(1320);
  });

  it("ranks in Do this next as money at risk, after a price rise due this week", () => {
    const { shown, folded } = recurringAlerts(livePlans([charge], NO_DECISIONS, NOW), NO_DECISIONS, NOW);
    const none: NudgeSources = {
      recurring: [...shown, ...folded],
      savingsGoals: [],
      netWorthGoal: null,
      stale: null,
      uncategorized: { count: 3, newestImport: null },
      p2p: { count: 0, newestImport: null },
      accounts: [],
      fundIds: () => [],
    };
    const nudges = nudgeCandidates(none);
    const split = nudges.find((n) => n.key.startsWith("recurring:unsplit|"));
    expect(split?.text).toBe(
      "Parcel Mobile's September bill hasn't been split; counting the full $110.00: link the repayments, or mark it not shared",
    );
    expect(split?.kind).toBe("recurring");
    expect(split?.order).toBeGreaterThan(7);
  });
});
