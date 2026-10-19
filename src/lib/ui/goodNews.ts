/**
 * The one line under "All clear" in Overview's "Do this next" slot when
 * nothing asks for an action: the strongest piece of good news that is TRUE
 * now, in about eight words with one figure. Never praise for its own sake:
 * every candidate is a figure another screen already computes, read here and
 * never measured again.
 *
 * Ranked strongest first:
 * 1. This month heading under a typical one: the pace call /insights prints
 *    (computePace), only when it does not refuse and its baseline reaches
 *    every account (a baseline missing accounts is understated, and being
 *    told you are under when you are not is the reassuring kind of wrong).
 * 2. The net worth goal landing sooner than it did from the month-end
 *    before: its saving projection's shift, as /insights and the recap say it.
 * 3. Last month's saving above the middle of the months before it: the
 *    "saved" part of the /trends net worth split (growthBetween), only for a
 *    month nothing in it is estimated or left out.
 * Failing all three, the main goal's progress (the net worth goal, else the
 * first savings goal), and with no goal, nothing: "All clear." alone.
 */
import type { GoalAssessment } from "../insights/goals";
import type { Pace } from "../insights/pace";
import { previousPeriodKey } from "../insights/periods";
import { median, round2 } from "../insights/stats";
import { monthLabel, shortMonthLabel } from "./format";
import type { NetWorthGoalAssessment } from "./netWorthGoal";
import { growthBetween, type NetWorthPoint } from "./netWorthGrowth";

export type GoodNewsKind = "underTypical" | "goalSooner" | "savedAboveUsual" | "goalProgress";

/** A line in three parts, so the figure can wear the money face. */
export interface GoodNews {
  kind: GoodNewsKind;
  before: string;
  figure: string;
  after: string;
}

/** The pace fields read: the stable ones (Task A may change how `typical` is drawn, never what it is). */
export type PaceRead = Pick<Pace, "period" | "refusal" | "projected" | "typical" | "basisMissingAccounts">;

/** Last month's saving against the middle of the months before it. */
export interface SavedVsUsual {
  period: string;
  saved: number;
  usual: number;
}

/** Months before last month whose saving makes "usual", at most. */
export const SAVED_USUAL_MONTHS = 6;
/** And at least, or there is no usual to be above. */
export const SAVED_USUAL_MIN_MONTHS = 3;

const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const uncertain = (p: NetWorthPoint) => p.estimated || p.leftOut.length > 0;

/**
 * The "saved" /trends prints for each month, last month against the middle of
 * up to six before it. Null when last month is not the latest complete one,
 * when it or its base is estimated or leaves an account out, or with fewer
 * than three months to call usual. `months` are complete month-ends, oldest
 * first (goalInputs.netWorthMonths).
 */
export function savedVsUsual(months: readonly NetWorthPoint[], currentPeriod: string): SavedVsUsual | null {
  const points = [...months];
  const last = points.length - 1;
  const lastMonth = previousPeriodKey(currentPeriod);
  const contiguous = (i: number) => i > 0 && points[i - 1].period === previousPeriodKey(points[i].period);
  if (last < 1 || points[last].period !== lastMonth || !contiguous(last)) return null;
  if (uncertain(points[last]) || uncertain(points[last - 1])) return null;
  const saved = growthBetween(points, last - 1, last).saved;
  const earlier: number[] = [];
  for (let i = last - 1; i > 0 && earlier.length < SAVED_USUAL_MONTHS; i -= 1) {
    if (!contiguous(i)) break;
    if (uncertain(points[i]) || uncertain(points[i - 1])) continue;
    earlier.push(growthBetween(points, i - 1, i).saved);
  }
  if (earlier.length < SAVED_USUAL_MIN_MONTHS) return null;
  return { period: lastMonth, saved, usual: round2(median(earlier)) };
}

export interface GoodNewsSources {
  pace: PaceRead | null;
  netWorthGoal: NetWorthGoalAssessment | null;
  savingsGoals: readonly GoalAssessment[];
  saved: SavedVsUsual | null;
}

const monthsWord = (n: number) => (n === 1 ? "a month" : `${n} months`);

/** Whole percent, never rounded up to a goal not yet reached. */
const percentThere = (progress: number) => Math.floor(progress * 100);

function goalProgress(s: GoodNewsSources): GoodNews | null {
  const nw = s.netWorthGoal;
  if (nw !== null) {
    if (nw.reached) return { kind: "goalProgress", before: "Net worth goal", figure: "", after: "reached" };
    const pct = percentThere(nw.progress);
    if (pct < 1) return null;
    const lands = nw.saving?.lands ?? null;
    return { kind: "goalProgress", before: "Net worth goal", figure: `${pct}%`, after: lands === null ? "there" : `there · ${shortMonthLabel(lands)}` };
  }
  const first = s.savingsGoals[0];
  if (first === undefined) return null;
  if (first.reached) return { kind: "goalProgress", before: first.goal.name, figure: "", after: "reached" };
  const pct = percentThere(first.progress);
  if (pct < 1) return null;
  const lands = first.refusal === null ? first.landsMonth : null;
  return { kind: "goalProgress", before: first.goal.name, figure: `${pct}%`, after: lands === null ? "there" : `there · ${shortMonthLabel(lands)}` };
}

export function goodNews(s: GoodNewsSources): GoodNews | null {
  const p = s.pace;
  if (p !== null && p.refusal === null && p.projected !== null && p.typical !== null && p.basisMissingAccounts === 0) {
    const under = Math.round(p.typical - p.projected);
    if (under >= 1) {
      return { kind: "underTypical", before: `${monthLabel(p.period).split(" ")[0]} is`, figure: whole.format(under), after: "under a typical month" };
    }
  }

  const nw = s.netWorthGoal;
  const shift = nw === null || nw.reached ? null : (nw.saving?.shift ?? null);
  if (shift !== null && shift < 0 && nw?.saving?.lands != null) {
    return { kind: "goalSooner", before: "Net worth goal lands", figure: monthsWord(-shift), after: "sooner" };
  }

  const saved = s.saved;
  if (saved !== null && saved.saved > 0 && saved.saved > saved.usual) {
    return { kind: "savedAboveUsual", before: "Saved", figure: whole.format(Math.round(saved.saved)), after: "last month, above usual" };
  }

  return goalProgress(s);
}

/** The line as one string: what a test counts words in. */
export function goodNewsText(n: GoodNews): string {
  return [n.before, n.figure, n.after].filter((x) => x !== "").join(" ");
}
