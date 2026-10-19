import { describe, expect, it } from "vitest";
import type { GoalAssessment } from "../insights/goals";
import { goodNews, goodNewsText, savedVsUsual, type GoodNewsSources, type PaceRead } from "./goodNews";
import type { NetWorthGoalAssessment } from "./netWorthGoal";
import type { NetWorthPoint } from "./netWorthGrowth";

// Invented figures throughout.
const pace = (over: Partial<PaceRead> = {}): PaceRead => ({
  period: "2026-10",
  refusal: null,
  projected: 3_790,
  typical: 4_000,
  basisMissingAccounts: 0,
  ...over,
});

const nwGoal = (over: Record<string, unknown> = {}) =>
  ({
    goal: { target: 500_000 },
    netWorth: 320_000,
    progress: 0.64,
    reached: false,
    saving: { lands: "2027-08", shift: 0 },
    ...over,
  }) as unknown as NetWorthGoalAssessment;

const savingsGoal = (over: Record<string, unknown> = {}) =>
  ({
    goal: { id: "g1", name: "House fund", target: 50_000 },
    progress: 0.64,
    reached: false,
    landsMonth: "2027-08",
    refusal: null,
    ...over,
  }) as unknown as GoalAssessment;

const none: GoodNewsSources = { pace: null, netWorthGoal: null, savingsGoals: [], saved: null };

/** Month-ends oldest first, each `step` above the one before. */
function months(values: number[], from = "2026-03"): NetWorthPoint[] {
  const [y, m] = from.split("-").map(Number);
  return values.map((value, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return {
      period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      value,
      estimated: false,
      leftOut: [],
      marketGains: 0,
    };
  });
}

describe("goodNews: each candidate alone", () => {
  it("this month under a typical one, from the pace call", () => {
    const n = goodNews({ ...none, pace: pace() });
    expect(n?.kind).toBe("underTypical");
    expect(goodNewsText(n!)).toBe("October is $210 under a typical month");
    expect(n?.figure).toBe("$210");
  });

  it("never when the pace call refuses, is over typical, or reads a baseline missing accounts", () => {
    expect(goodNews({ ...none, pace: pace({ refusal: "TOO_EARLY", projected: null, typical: null }) })).toBeNull();
    expect(goodNews({ ...none, pace: pace({ projected: 4_200 }) })).toBeNull();
    expect(goodNews({ ...none, pace: pace({ projected: 4_000 }) })).toBeNull();
    expect(goodNews({ ...none, pace: pace({ basisMissingAccounts: 1 }) })).toBeNull();
  });

  it("the net worth goal landing sooner than from the month-end before", () => {
    const one = goodNews({ ...none, netWorthGoal: nwGoal({ saving: { lands: "2027-07", shift: -1 } }) });
    expect(one?.kind).toBe("goalSooner");
    expect(goodNewsText(one!)).toBe("Net worth goal lands a month sooner");
    const three = goodNews({ ...none, netWorthGoal: nwGoal({ saving: { lands: "2027-05", shift: -3 } }) });
    expect(goodNewsText(three!)).toBe("Net worth goal lands 3 months sooner");
  });

  it("not when the date held or slipped: the goal's progress instead", () => {
    for (const shift of [0, 2, null]) {
      expect(goodNews({ ...none, netWorthGoal: nwGoal({ saving: { lands: "2027-08", shift } }) })?.kind).toBe("goalProgress");
    }
  });

  it("last month's saving above the middle of the months before it", () => {
    const n = goodNews({ ...none, saved: { period: "2026-09", saved: 1_900, usual: 1_200 } });
    expect(n?.kind).toBe("savedAboveUsual");
    expect(goodNewsText(n!)).toBe("Saved $1,900 last month, above usual");
  });

  it("not when it was at or below usual, or nothing was saved", () => {
    expect(goodNews({ ...none, saved: { period: "2026-09", saved: 1_200, usual: 1_200 } })).toBeNull();
    expect(goodNews({ ...none, saved: { period: "2026-09", saved: -300, usual: -900 } })).toBeNull();
  });
});

describe("goodNews: the ranking", () => {
  const all: GoodNewsSources = {
    pace: pace(),
    netWorthGoal: nwGoal({ saving: { lands: "2027-07", shift: -1 } }),
    savingsGoals: [savingsGoal()],
    saved: { period: "2026-09", saved: 1_900, usual: 1_200 },
  };

  it("under typical, then a goal sooner, then saved above usual", () => {
    expect(goodNews(all)?.kind).toBe("underTypical");
    expect(goodNews({ ...all, pace: null })?.kind).toBe("goalSooner");
    expect(goodNews({ ...all, pace: null, netWorthGoal: null })?.kind).toBe("savedAboveUsual");
  });
});

describe("goodNews: nothing true falls back", () => {
  it("to the main goal's progress: the net worth goal first", () => {
    const n = goodNews({ ...none, netWorthGoal: nwGoal(), savingsGoals: [savingsGoal()] });
    expect(goodNewsText(n!)).toBe("Net worth goal 64% there · Aug 2027");
  });

  it("else the first savings goal's", () => {
    const n = goodNews({ ...none, savingsGoals: [savingsGoal(), savingsGoal({ goal: { name: "Car" } })] });
    expect(goodNewsText(n!)).toBe("House fund 64% there · Aug 2027");
    expect(n?.figure).toBe("64%");
  });

  it("without a date when the goal gives none, and never rounds up to there", () => {
    expect(goodNewsText(goodNews({ ...none, savingsGoals: [savingsGoal({ refusal: "TOO_FEW_MONTHS", progress: 0.996 })] })!)).toBe(
      "House fund 99% there",
    );
    expect(goodNewsText(goodNews({ ...none, savingsGoals: [savingsGoal({ reached: true, progress: 1 })] })!)).toBe("House fund reached");
  });

  it("a goal with nothing saved is no news", () => {
    expect(goodNews({ ...none, savingsGoals: [savingsGoal({ progress: 0 })] })).toBeNull();
  });

  it("to nothing with no goals: the slot says All clear alone", () => {
    expect(goodNews(none)).toBeNull();
  });
});

describe("goodNews: the wording stays short", () => {
  const lines = [
    goodNews({ ...none, pace: pace({ period: "2026-09", typical: 12_345, projected: 1_000 }) }),
    goodNews({ ...none, netWorthGoal: nwGoal({ saving: { lands: "2027-01", shift: -11 } }) }),
    goodNews({ ...none, saved: { period: "2026-09", saved: 12_345, usual: 1_000 } }),
    goodNews({ ...none, netWorthGoal: nwGoal() }),
    goodNews({ ...none, savingsGoals: [savingsGoal()] }),
  ];

  it("about eight words, one figure, no em dash", () => {
    for (const n of lines) {
      expect(n).not.toBeNull();
      const text = goodNewsText(n!);
      expect(text.split(/\s+/).filter((w) => w !== "·").length).toBeLessThanOrEqual(8);
      expect(text).not.toContain("—");
      expect(n!.figure).not.toBe("");
      expect(text).toContain(n!.figure);
    }
  });
});

describe("savedVsUsual: the /trends saved, last month against the middle before it", () => {
  // Saved per month: 1000, 1200, 800, 1100, then 1900 last month.
  const series = months([10_000, 11_000, 12_200, 13_000, 14_100, 16_000]);

  it("reads last month's saving and the median of the months before", () => {
    expect(savedVsUsual(series, "2026-09")).toEqual({ period: "2026-08", saved: 1_900, usual: 1_050 });
  });

  it("leaves markets out of saved, as /trends splits it", () => {
    const withMarkets = series.map((p, i) => (i === series.length - 1 ? { ...p, marketGains: 400 } : p));
    expect(savedVsUsual(withMarkets, "2026-09")?.saved).toBe(1_500);
  });

  it("is null unless last month is the latest complete one", () => {
    expect(savedVsUsual(series, "2026-10")).toBeNull();
  });

  it("is null when last month is estimated or leaves an account out", () => {
    const estimated = series.map((p, i) => (i === series.length - 1 ? { ...p, estimated: true } : p));
    expect(savedVsUsual(estimated, "2026-09")).toBeNull();
    const leftOut = series.map((p, i) => (i === series.length - 1 ? { ...p, leftOut: ["acct-x"] } : p));
    expect(savedVsUsual(leftOut, "2026-09")).toBeNull();
  });

  it("is null with fewer than three months to call usual", () => {
    expect(savedVsUsual(months([10_000, 11_000, 12_200, 14_100], "2026-05"), "2026-09")).toBeNull();
  });
});
