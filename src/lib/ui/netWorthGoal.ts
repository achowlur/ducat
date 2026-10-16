import { round2 } from "../insights/stats";
import { growthBetween, type NetWorthPoint } from "./netWorthGrowth";

/**
 * The net worth goal: "reach $1M, and when?", projected TWO ways and never
 * blended into one rate (docs/conventions/goals-and-insights.md).
 *
 * Net worth grows for two reasons. What the operator SAVES is a decision and
 * is observed: the "saved" part of the Trends split (growthBetween), so the
 * pace here is the figure /trends prints, never a second definition. What the
 * MARKETS add is a guess about the future. One rate learned from the past
 * would quietly assume a strong stretch repeats, and read as a promise. So:
 *
 * - BY SAVING ALONE: the observed pace, nothing else. The date the operator
 *   controls.
 * - WITH MARKETS: the same pace, plus a yearly return the OPERATOR TYPED,
 *   applied to invested money only (investment accounts outside the cash
 *   definition) and to what a TYPICAL month adds to it. No return lives in
 *   code: none typed, no markets date.
 *
 * Everything is in TODAY'S DOLLARS. The return is after inflation, so the
 * target is buying power, the pace is held level in real terms, and cash is
 * assumed to keep pace with inflation.
 *
 * The monthly CONTRIBUTION is the middle of the LAST THREE complete months
 * of money crossing into invested accounts. A real history mixes a steady
 * monthly deposit with lump sums (savings moved in from another bank, a
 * yearly IRA contribution, a reshuffle between accounts worth many months of
 * saving), and any average those touch reads as a habit nobody has; a fixed
 * cutoff ("leave out anything over $5,000") fails the reader whose ordinary
 * deposit is above it. A median needs no threshold. Over twelve months it
 * would also ignore a RAISE for half a year, saying nothing; over three, one
 * month is never the middle, so a lump sum cannot move it, and a new amount
 * counts the moment it repeats. Until then the panel names the month that
 * did not match, and once it counts, what it was before: the deposit never
 * changes silently. That much compounds with the invested balance; the rest
 * of the pace is counted as cash.
 *
 * Dates are projected from the last COMPLETE month-end, never the live
 * balance, so they hold still through a month instead of moving with every
 * day's markets, and the shift since the month-end before compares like with
 * like. Progress is the live figure, Overview's headline.
 */

export const NET_WORTH_GOAL_KEY = "goals.netWorth";

/** A year of months smooths a bonus month and a big bill; half of one is the least to project from. */
export const NET_WORTH_PACE_MONTHS = 12;
export const NET_WORTH_PACE_MIN_MONTHS = 6;

/** Beyond this a landing date is not worth printing: fifty years, as the savings goals say. */
export const NET_WORTH_HORIZON_MONTHS = 600;

export interface NetWorthGoal {
  /** Positive dollars, in today's money. */
  target: number;
  /** The real (after-inflation) yearly return the operator typed, in percent. Absent: no markets date. */
  realReturnPct?: number;
  /** Day ("2026-10-16") the return was typed: a typed assumption must never read current forever. */
  returnSetOn?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The stored Setting → the goal, or null. Tolerant: a corrupted value must not take the page down. */
export function parseNetWorthGoal(raw: string | null): NetWorthGoal | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const g = v as Record<string, unknown>;
    if (typeof g.target !== "number" || !Number.isFinite(g.target) || g.target <= 0) return null;
    const pct = g.realReturnPct;
    const validPct = typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct <= 15;
    if (pct !== undefined && !validPct) return null;
    if (g.returnSetOn !== undefined && (typeof g.returnSetOn !== "string" || !DAY.test(g.returnSetOn))) return null;
    return {
      target: g.target,
      ...(validPct ? { realReturnPct: pct as number } : {}),
      ...(typeof g.returnSetOn === "string" ? { returnSetOn: g.returnSetOn } : {}),
    };
  } catch {
    return null;
  }
}

/** A complete month-end, as the NET_WORTH_GROWTH row records it. */
export interface NetWorthMonth extends NetWorthPoint {
  /** Each account's month-end value; null on rows stored before it was recorded. */
  byAccount: Record<string, number> | null;
  /** Money crossing into (+) or out of (−) each investment account; null on rows stored before it was recorded. */
  flowsByAccount: Record<string, number> | null;
}

export interface Projection {
  /** Month key the target is reached in; null when the pace never gets there inside the horizon. */
  lands: string | null;
  /** Months later (+) or sooner (−) than the same projection from the month-end before; null when either is missing. */
  shift: number | null;
}

export interface NetWorthGoalAssessment {
  goal: NetWorthGoal;
  /** Live net worth: the signed sum of every balance, Overview's headline. */
  netWorth: number;
  /** netWorth / target, clamped to [0, 1]. */
  progress: number;
  reached: boolean;
  /** The month-end the dates are projected from; null when there is too little history. */
  anchor: string | null;
  /** Saved per month over the pace window ("saved" as /trends splits it); may be negative. */
  pace: number | null;
  /**
   * The same pace from the month-end before; null when that one could not be
   * measured. Against a far target a modest change in pace moves the date by
   * years (saving a tenth faster brings a twenty-year landing about two years nearer),
   * so a shifted date says what moved it.
   */
  previousPace: number | null;
  /** Months the pace is measured over (at most NET_WORTH_PACE_MONTHS). */
  paceMonths: number;
  /** Months in that window (its base included) partly estimated or leaving an account out. */
  paceUncertainMonths: number;
  /** Invested money at the anchor, the part a return applies to; null when the row predates per-account values. */
  invested: number | null;
  /** The monthly deposit into invested money: the middle of the last three months; null without three months of flows. */
  contribution: number | null;
  /** The same, a month earlier; null when it cannot be measured. */
  previousContribution: number | null;
  /**
   * The anchor month's own deposit when it does NOT match `contribution`: a
   * new amount, a lump sum or a missed month, which counts only once it
   * repeats. Null when it matches.
   */
  unmatchedDeposit: number | null;
  saving: Projection | null;
  /** Null when no return is typed, or `invested` is unknown. */
  markets: Projection | null;
  refusal: "TOO_FEW_MONTHS" | null;
}

/** "2026-09" moved by n months. */
export function addMonths(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Months from `a` to `b` ("2026-09" → "2026-12" is 3). */
function monthsFrom(a: string, b: string): number {
  const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  return index(b) - index(a);
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The pace ending at `months[end]`: up to a year back, and never across a
 * month that counts different accounts (an account entering the sum is not
 * saving). Null when fewer than NET_WORTH_PACE_MIN_MONTHS remain.
 */
function paceAt(months: readonly NetWorthMonth[], end: number) {
  let base = Math.max(0, end - NET_WORTH_PACE_MONTHS);
  for (let i = end; i >= base; i -= 1) {
    if (!sameSet(months[i].leftOut, months[end].leftOut)) {
      base = i + 1;
      break;
    }
  }
  const span = monthsFrom(months[base].period, months[end].period);
  if (span < NET_WORTH_PACE_MIN_MONTHS) return null;
  const growth = growthBetween([...months], base, end);
  return { base, months: span, perMonth: round2(growth.saved / span), uncertain: growth.uncertainMonths };
}

/** Months the deposit is read over: its middle is the monthly amount. */
export const DEPOSIT_MONTHS = 3;

/** Money into invested accounts in one month; null when the row predates per-account flows. */
function depositIn(m: NetWorthMonth, investedIds: ReadonlySet<string>): number | null {
  const flows = m.flowsByAccount;
  return flows === null ? null : round2([...investedIds].reduce((sum, id) => sum + (flows[id] ?? 0), 0));
}

/**
 * The monthly deposit as of `months[end]`: the middle of its last three
 * months, so one month (a lump sum, a missed deposit, a first month at a new
 * amount) never sets it, and two do. Null without three months of flows.
 */
function depositAt(months: readonly NetWorthMonth[], end: number, investedIds: ReadonlySet<string>): number | null {
  if (end < DEPOSIT_MONTHS - 1) return null;
  const recent: number[] = [];
  for (let i = end - DEPOSIT_MONTHS + 1; i <= end; i += 1) {
    const d = depositIn(months[i], investedIds);
    if (d === null) return null;
    recent.push(d);
  }
  return recent.sort((a, b) => a - b)[Math.floor(DEPOSIT_MONTHS / 2)];
}

/** Two deposits are the same amount within a cent or 2%: a transfer's amount is set, not estimated. */
const sameDeposit = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, 0.02 * Math.max(Math.abs(a), Math.abs(b)));

/**
 * The first month, after `anchor`, that net worth reaches `target`. Each
 * month the invested money earns the real return and takes the month's
 * `contribution`; the rest of the pace lands in cash, which stays level.
 * With no return the split cannot matter and net worth simply grows by the
 * pace. Null beyond the horizon.
 */
function landing(
  anchor: string,
  netWorth: number,
  invested: number,
  pace: number,
  contribution: number,
  realReturnPct: number,
  target: number,
): string | null {
  if (netWorth >= target) return anchor;
  const monthly = Math.pow(1 + realReturnPct / 100, 1 / 12) - 1;
  let inv = invested;
  let rest = netWorth - invested;
  for (let t = 1; t <= NET_WORTH_HORIZON_MONTHS; t += 1) {
    inv = inv * (1 + monthly) + contribution;
    rest += pace - contribution;
    if (inv + rest >= target) return addMonths(anchor, t);
  }
  return null;
}

export function assessNetWorthGoal(input: {
  goal: NetWorthGoal;
  liveNetWorth: number;
  /** COMPLETE months only, oldest first: the caller cuts the month being lived in. */
  months: readonly NetWorthMonth[];
  /** Investment accounts outside the operator's cash definition. */
  investedIds: ReadonlySet<string>;
}): NetWorthGoalAssessment {
  const { goal, liveNetWorth, months, investedIds } = input;
  const netWorth = round2(liveNetWorth);
  const base: NetWorthGoalAssessment = {
    goal,
    netWorth,
    progress: Math.min(1, Math.max(0, netWorth / goal.target)),
    reached: netWorth >= goal.target,
    anchor: null,
    pace: null,
    previousPace: null,
    paceMonths: 0,
    paceUncertainMonths: 0,
    invested: null,
    contribution: null,
    previousContribution: null,
    unmatchedDeposit: null,
    saving: null,
    markets: null,
    refusal: null,
  };
  // Reached is a fact, checked before any question of pace.
  if (base.reached) return base;

  const investedAt = (m: NetWorthMonth): number | null =>
    m.byAccount === null
      ? null
      : round2([...investedIds].reduce((sum, id) => sum + (m.byAccount?.[id] ?? 0), 0));

  /** Both projections from the month-end at `end`, or null with too little behind it. */
  const projectFrom = (end: number) => {
    if (end < 0) return null;
    const pace = paceAt(months, end);
    if (pace === null) return null;
    const m = months[end];
    const invested = investedAt(m);
    const contribution = depositAt(months, end, investedIds);
    return {
      pace,
      invested,
      contribution,
      saving: landing(m.period, m.value, 0, pace.perMonth, 0, 0, goal.target),
      markets:
        goal.realReturnPct === undefined || invested === null
          ? undefined
          : landing(m.period, m.value, invested, pace.perMonth, contribution ?? 0, goal.realReturnPct, goal.target),
    };
  };

  const end = months.length - 1;
  const now = projectFrom(end);
  if (now === null) return { ...base, refusal: "TOO_FEW_MONTHS" };
  const before = projectFrom(end - 1);
  const shift = (a: string | null | undefined, b: string | null | undefined) =>
    a === null || a === undefined || b === null || b === undefined ? null : monthsFrom(b, a);

  return {
    ...base,
    anchor: months[end].period,
    pace: now.pace.perMonth,
    previousPace: before?.pace.perMonth ?? null,
    paceMonths: now.pace.months,
    paceUncertainMonths: now.pace.uncertain,
    invested: now.invested,
    contribution: now.contribution,
    previousContribution: before?.contribution ?? null,
    unmatchedDeposit: (() => {
      const latest = depositIn(months[end], investedIds);
      return latest === null || now.contribution === null || sameDeposit(latest, now.contribution) ? null : latest;
    })(),
    saving: { lands: now.saving, shift: shift(now.saving, before?.saving) },
    markets: now.markets === undefined ? null : { lands: now.markets, shift: shift(now.markets, before?.markets) },
  };
}
