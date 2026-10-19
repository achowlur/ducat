import { describe, expect, it } from "vitest";
import type { GoalAssessment } from "../insights/goals";
import {
  DUE_WITHIN_DAYS,
  isHidden,
  markDone,
  nextAction,
  nudgeCandidates,
  parseDone,
  rankNudges,
  type Nudge,
  type NudgeKind,
  type NudgeSources,
} from "./nextAction";
import type { NetWorthGoalAssessment } from "./netWorthGoal";
import type { RecurringAlert } from "./recurringAlerts";

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

const nudge = (kind: NudgeKind, over: Partial<Nudge> = {}): Nudge => ({
  key: kind,
  kind,
  text: kind,
  short: kind,
  href: "/",
  asOf: day("2026-10-10"),
  order: 0,
  ...over,
});

describe("rankNudges", () => {
  it("puts a deadline first, then idle money, then tidying", () => {
    const ranked = rankNudges([
      nudge("stale"),
      nudge("p2p"),
      nudge("uncategorized"),
      nudge("keepUp"),
      nudge("idle"),
      nudge("goal"),
      nudge("recurring"),
    ]);
    expect(ranked.map((n) => n.kind)).toEqual(["recurring", "goal", "idle", "keepUp", "uncategorized", "p2p", "stale"]);
  });

  it("orders within a kind: the sooner renewal and the larger shortfall first", () => {
    const ranked = rankNudges([
      nudge("recurring", { key: "r5", order: 5 }),
      nudge("goal", { key: "small", order: -40 }),
      nudge("recurring", { key: "r1", order: 1 }),
      nudge("goal", { key: "large", order: -900 }),
    ]);
    expect(ranked.map((n) => n.key)).toEqual(["r1", "r5", "large", "small"]);
  });
});

describe("Mark done", () => {
  const clicked = new Date("2026-10-12T15:00:00Z");
  const idle = nudge("idle", { key: "idle-cash", asOf: day("2026-10-11") });

  it("hides the nudge while its data is no newer than the click", () => {
    const r = markDone([], "idle-cash", clicked, [idle]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.done).toEqual([{ key: "idle-cash", at: clicked.toISOString() }]);
    // The next sync brings a balance dated the day before the click: SimpleFIN lags, so still hidden.
    expect(nextAction([{ ...idle, asOf: day("2026-10-12") - 1 }], r.done).lead).toBeNull();
    expect(nextAction([idle], r.done).waiting).toBe(1);
  });

  it("shows it again once a newer balance still says it", () => {
    const done = [{ key: "idle-cash", at: clicked.toISOString() }];
    const newer = { ...idle, asOf: day("2026-10-13") };
    expect(isHidden(newer, done)).toBe(false);
    expect(nextAction([newer], done).lead?.key).toBe("idle-cash");
  });

  it("drops the entry once the nudge is resolved, or once newer data has arrived", () => {
    const done = [
      { key: "idle-cash", at: clicked.toISOString() },
      { key: "keep-up", at: clicked.toISOString() },
      { key: "uncategorized", at: clicked.toISOString() },
    ];
    const keepUp = nudge("keepUp", { key: "keep-up", asOf: day("2026-10-01") });
    // idle-cash resolved (no candidate); uncategorized has a newer import; keep-up still waits.
    const p2p = nudge("p2p", { key: "p2p", asOf: day("2026-10-01") });
    const uncategorized = nudge("uncategorized", { key: "uncategorized", asOf: day("2026-10-14") });
    const r = markDone(done, "p2p", new Date("2026-10-15T09:00:00Z"), [keepUp, p2p, uncategorized]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.done.map((d) => d.key)).toEqual(["keep-up", "p2p"]);
  });

  it("refuses a nudge that is not on the list now, or already marked done", () => {
    const r = markDone([], "goal:gone", clicked, [idle]);
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Reload") });
    const again = markDone([{ key: "idle-cash", at: clicked.toISOString() }], "idle-cash", clicked, [idle]);
    expect(again.ok).toBe(false);
  });

  it("reads an unreadable Setting as nothing marked done", () => {
    expect(parseDone(null)).toEqual([]);
    expect(parseDone("not json")).toEqual([]);
    expect(parseDone('[{"key":"x","at":"never"},{"key":"y","at":"2026-10-01T00:00:00.000Z"},5]')).toEqual([
      { key: "y", at: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("leads with the next nudge when the first is hidden, and says how many wait", () => {
    const done = [{ key: "goal", at: clicked.toISOString() }];
    const r = nextAction([nudge("goal"), nudge("idle"), nudge("uncategorized"), nudge("stale")], done);
    expect(r.lead?.kind).toBe("idle");
    expect(r.then.map((n) => n.kind)).toEqual(["uncategorized", "stale"]);
    expect(r.waiting).toBe(1);
  });
});

describe("nudgeCandidates", () => {
  const empty: NudgeSources = {
    recurring: [],
    savingsGoals: [],
    netWorthGoal: null,
    stale: null,
    uncategorized: { count: 0, newestImport: null },
    p2p: { count: 0, newestImport: null },
    accounts: [
      { id: "a1", name: "Everyday Checking ...0001", balanceDate: new Date("2026-10-10T00:00:00Z") },
      { id: "a2", name: "High-Yield Savings ...0002", balanceDate: new Date("2026-10-11T00:00:00Z") },
    ],
    fundIds: () => ["a2"],
  };
  const alert = (daysAway: number | null, kind: RecurringAlert["kind"] = "Price up"): RecurringAlert => ({
    id: `rise|streamflix|17.99|${daysAway}`,
    plan: "streamflix",
    kind,
    text: "Streamflix rose 16% to $17.99",
    detail: "",
    actions: [],
    stake: 215.88,
    daysAway,
    lastDate: "2026-09-20",
  });

  it("is empty when nothing asks for anything", () => {
    expect(nudgeCandidates(empty)).toEqual([]);
  });

  it("takes a recurring decision only when its charge lands within a week", () => {
    const c = nudgeCandidates({
      ...empty,
      recurring: [alert(DUE_WITHIN_DAYS), alert(DUE_WITHIN_DAYS + 1), alert(null, "Not charging")],
    });
    expect(c.map((n) => n.text)).toEqual([`Streamflix rose 16% to $17.99 and renews in ${DUE_WITHIN_DAYS} days`]);
    expect(c[0].asOf).toBe(day("2026-09-20"));
  });

  it("names a goal behind with the card's own figure, waiting on its fund's balance", () => {
    const goal = {
      goal: { id: "house-deposit", name: "House deposit", target: 60_000, targetMonth: "2027-08", accountIds: ["a2"] },
      reached: false,
      refusal: null,
      measuredRate: 500,
      paceSet: null,
      remaining: 40_000,
      nowMs: Date.parse("2026-10-18T12:00:00Z"),
    } as unknown as GoalAssessment;
    const [n] = nudgeCandidates({ ...empty, savingsGoals: [goal] });
    expect(n.kind).toBe("goal");
    expect(n.text).toMatch(/^Save ~\$[\d,]+\/mo more for House deposit to land by August 2027$/);
    expect(n.href).toBe("/insights#goal-house-deposit");
    expect(n.asOf).toBe(Date.parse("2026-10-11T00:00:00Z"));
  });

  it("says what idle cash would earn and never that Ducat moves it", () => {
    const nw = {
      goal: { target: 1_000_000 },
      reached: false,
      anchor: "2026-09",
      contribution: null,
      contributionYearAgo: null,
      idle: {
        held: 50_000,
        buffer: 4_000,
        idle: 46_000,
        from: ["Everyday Checking ...0001"],
        fromIds: ["a1"],
        to: { name: "High-Yield Savings ...0002", nominalPct: 4.2 },
        yearly: 1_932,
      },
    } as unknown as NetWorthGoalAssessment;
    const [n] = nudgeCandidates({ ...empty, netWorthGoal: nw });
    expect(n.text).toBe(
      "$46,000 in Everyday Checking ...0001 earns nothing past a month of spending; in High-Yield Savings ...0002 it would earn ~$1,932/yr",
    );
    expect(n.text).not.toMatch(/\b(we|Ducat) (will )?move/i);
    expect(n.asOf).toBe(Date.parse("2026-10-10T00:00:00Z"));
  });

  it("asks to keep investing up with inflation only while the deposit follows the data", () => {
    const nw = {
      goal: { target: 1_000_000 },
      reached: false,
      anchor: "2026-09",
      contribution: 500,
      contributionYearAgo: 500,
      idle: null,
    } as unknown as NetWorthGoalAssessment;
    const [n] = nudgeCandidates({ ...empty, netWorthGoal: nw });
    expect(n.text).toBe("Invest ~$515/mo, not $500, to keep up with 3% inflation");
    // The next complete month-end is the new data.
    expect(n.asOf).toBe(Date.parse("2026-10-01T00:00:00Z"));
    const typed = { ...nw, goal: { target: 1_000_000, monthlyInvest: 500 } } as unknown as NetWorthGoalAssessment;
    expect(nudgeCandidates({ ...empty, netWorthGoal: typed })).toEqual([]);
  });

  it("carries the review items and a stale feed as tidying", () => {
    const c = nudgeCandidates({
      ...empty,
      uncategorized: { count: 3, newestImport: new Date("2026-10-15T00:00:00Z") },
      p2p: { count: 1, newestImport: new Date("2026-10-14T00:00:00Z") },
      stale: { sentence: "Everyday Checking ...0001 is 5 days behind", href: "https://bridge.simplefin.org", names: ["Everyday Checking ...0001"] },
    });
    expect(rankNudges(c).map((n) => n.text)).toEqual([
      "Categorize 3 transactions: spending totals are incomplete until then",
      "Confirm 1 P2P payment: Zelle and Venmo wait for you",
      "Everyday Checking ...0001 is 5 days behind: reconnect it at SimpleFIN",
    ]);
    expect(c.find((n) => n.kind === "stale")?.asOf).toBe(Date.parse("2026-10-10T00:00:00Z"));
  });
});
