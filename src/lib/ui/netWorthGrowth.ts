import { pctDelta } from "../insights/stats";

/**
 * Net worth growth, and what drove it: the markets, or money kept. Read from
 * the monthly NET_WORTH_GROWTH rows /trends already draws, never a second
 * computation of net worth, so the figures here add up to the line above them.
 */

export interface NetWorthPoint {
  period: string; // "2026-07"
  value: number;
  estimated: boolean;
  leftOut: string[];
  /** The month's investment value change not explained by money in or out. */
  marketGains: number | null;
}

/** How net worth moved from one month-end to another, and what moved it. */
export interface Growth {
  /** The month measured FROM: its month-end value is the base. */
  from: string;
  to: string;
  start: number;
  end: number;
  change: number;
  /** change / start; null when there is no ratio to print (pctDelta's rule). */
  pct: number | null;
  /** The investment accounts' change that no money in or out explains. */
  markets: number;
  /**
   * Everything else: what income left after spending, interest included, as
   * the balances show it. The two always add up to `change` exactly.
   */
  saved: number;
  /** Months in the span (base included) that are partly estimated or leave an account out. */
  uncertainMonths: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const uncertain = (p: NetWorthPoint) => p.estimated || p.leftOut.length > 0;

/**
 * Growth from `points[from]` to `points[to]`. The markets' share is the sum of
 * each month's own figure after the base: a month whose investment values were
 * carried has none, and the movement it missed lands when a value returns, so
 * a span holding both still counts it once.
 */
export function growthBetween(points: NetWorthPoint[], from: number, to: number): Growth {
  const base = points[from];
  const last = points[to];
  const change = round2(last.value - base.value);
  const markets = round2(points.slice(from + 1, to + 1).reduce((sum, p) => sum + (p.marketGains ?? 0), 0));
  return {
    from: base.period,
    to: last.period,
    start: base.value,
    end: last.value,
    change,
    pct: pctDelta(last.value, base.value),
    markets,
    saved: round2(change - markets),
    uncertainMonths: points.slice(from, to + 1).filter(uncertain).length,
  };
}

export const NET_WORTH_RANGES = [
  { value: "1y", label: "1Y", months: 12 },
  { value: "3y", label: "3Y", months: 36 },
  { value: "5y", label: "5Y", months: 60 },
  { value: "all", label: "All", months: null },
] as const;

export type NetWorthRange = (typeof NET_WORTH_RANGES)[number]["value"];

/**
 * The ranges a history is long enough for. A range needs its base month too,
 * so a year is thirteen points; offering five years over two would draw All
 * under another name.
 */
export function rangesFor(count: number): (typeof NET_WORTH_RANGES)[number][] {
  return NET_WORTH_RANGES.filter((r) => r.months === null || count > r.months);
}

/** The points a range draws: its months and the base month before them. */
export function pointsIn<T>(points: T[], range: NetWorthRange): T[] {
  const months = NET_WORTH_RANGES.find((r) => r.value === range)?.months ?? null;
  return months === null || points.length <= months ? points : points.slice(points.length - months - 1);
}

export interface YearGrowth extends Growth {
  year: string;
  /** The year is not over: the history ends inside it. */
  soFar: boolean;
  /** The history begins inside the year, so its base is the year's first month, not last December. */
  fromInside: boolean;
}

/**
 * Each calendar year's growth, newest first: from the previous December's
 * month-end to the year's last month on record. A year with one month on
 * record and no December before it has nothing to measure and is left out.
 */
export function growthByYear(points: NetWorthPoint[]): YearGrowth[] {
  const years = [...new Set(points.map((p) => p.period.slice(0, 4)))];
  const rows: YearGrowth[] = [];
  for (const year of years) {
    const end = points.findLastIndex((p) => p.period.startsWith(year));
    const december = points.findIndex((p) => p.period === `${Number(year) - 1}-12`);
    const base = december >= 0 ? december : points.findIndex((p) => p.period.startsWith(year));
    if (base === end) continue;
    rows.push({
      ...growthBetween(points, base, end),
      year,
      soFar: points[end].period !== `${year}-12`,
      fromInside: december < 0,
    });
  }
  return rows.reverse();
}
