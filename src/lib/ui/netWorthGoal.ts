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
 * The operator can SET the monthly amount instead (`monthlyInvest`), to ask
 * what investing more or less would do. What they save in cash stays as
 * measured (the pace less the measured deposit) and the amount they set is
 * added to it, so both dates move: investing more is saving more
 * (withDeposit). Set to the measured amount, it clears, and the deposit
 * follows the data again.
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
  /** Dollars a month into invested money, set by the operator in place of the measured deposit. Absent: the measured deposit. */
  monthlyInvest?: number;
}

/** The largest monthly amount a save accepts: past it a projection is noise. */
export const MAX_MONTHLY_INVEST = 1e9;

/**
 * The highest real return the controls offer and a save accepts, in percent
 * a year. A hundred is not a forecast, it is the operator's wish to play
 * ("for fun"): the panel keeps saying where the evidence sits, and the slider
 * gives the realistic few percent most of its travel (sliderToReturn).
 */
export const MAX_REAL_RETURN_PCT = 100;

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
    const validPct = typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct <= MAX_REAL_RETURN_PCT;
    if (pct !== undefined && !validPct) return null;
    if (g.returnSetOn !== undefined && (typeof g.returnSetOn !== "string" || !DAY.test(g.returnSetOn))) return null;
    const invest = g.monthlyInvest;
    const validInvest = typeof invest === "number" && Number.isFinite(invest) && invest >= 0 && invest <= MAX_MONTHLY_INVEST;
    if (invest !== undefined && !validInvest) return null;
    return {
      target: g.target,
      ...(validPct ? { realReturnPct: pct as number } : {}),
      ...(typeof g.returnSetOn === "string" ? { returnSetOn: g.returnSetOn } : {}),
      ...(validInvest ? { monthlyInvest: invest as number } : {}),
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
  /** The month-end the dates come from, for the panel to re-project as its controls move; null when too little history. */
  basis: GoalBasis | null;
  /** The month-end before, for the shift; null when it cannot be measured. */
  previousBasis: GoalBasis | null;
  /** The last few years of month-end net worth, oldest first: the solid line the projections continue. */
  recent: { period: string; value: number }[];
}

/** Years of history the goal's chart draws before the projections take over. */
export const GOAL_CHART_HISTORY_MONTHS = 60;

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
 * Net worth month by month from the basis, `months` long (index 0 is the
 * month-end itself), by the arithmetic `landing` uses: invested money earns
 * the real return and takes the monthly deposit, the rest of the pace lands
 * in cash. What the goal's chart draws, so its line and the date beside it
 * can never disagree.
 */
export function goalPath(b: GoalBasis, realReturnPct: number | undefined, months: number): number[] {
  const monthly = realReturnPct === undefined || realReturnPct <= 0 ? 0 : Math.pow(1 + realReturnPct / 100, 1 / 12) - 1;
  const contribution = monthly === 0 ? 0 : (b.contribution ?? 0);
  let inv = monthly === 0 || b.invested === null ? 0 : b.invested;
  let rest = b.netWorth - inv;
  const out = [b.netWorth];
  for (let t = 1; t <= months; t += 1) {
    inv = inv * (1 + monthly) + contribution;
    rest += b.pace - contribution;
    out.push(inv + rest);
  }
  return out;
}

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

/**
 * What one month-end gives the projection. Plain data, so the panel can
 * re-project in the browser as its target and return controls move, with
 * the same arithmetic the server used (projectGoal).
 */
export interface GoalBasis {
  /** The month-end projected from ("2026-09"). */
  anchor: string;
  /** Net worth at that month-end. */
  netWorth: number;
  /** Saved per month over the pace window; may be negative. */
  pace: number;
  paceMonths: number;
  /** Months in the window partly estimated or leaving an account out. */
  paceUncertainMonths: number;
  /** Invested money at the month-end; null when the row predates per-account values. */
  invested: number | null;
  /** The monthly deposit into it (depositAt); null without three months of flows. */
  contribution: number | null;
}

/**
 * The basis with the monthly deposit the operator SET in place of the
 * measured one. What they save in cash (the pace less the measured deposit)
 * holds, and the amount set is added to it: investing $500 more a month is
 * saving $500 more. Undefined leaves the basis as measured.
 */
export function withDeposit(b: GoalBasis, monthlyInvest: number | undefined): GoalBasis {
  if (monthlyInvest === undefined) return b;
  return { ...b, pace: round2(b.pace - (b.contribution ?? 0) + monthlyInvest), contribution: monthlyInvest };
}

/** Months later (+) or sooner (−); null when either landing is missing. */
const shiftBetween = (now: string | null | undefined, before: string | null | undefined) =>
  now === null || now === undefined || before === null || before === undefined ? null : monthsFrom(before, now);

/**
 * Both dates for a target and a return, from `now`, each with how far it
 * moved against the same target and return from the month-end `before`: the
 * shift says what the DATA did, never what a control did. A return of zero
 * or none means no markets date.
 */
export function projectGoal(
  now: GoalBasis,
  before: GoalBasis | null,
  target: number,
  realReturnPct: number | undefined,
): { saving: Projection; markets: Projection | null } {
  const at = (b: GoalBasis) => ({
    saving: landing(b.anchor, b.netWorth, 0, b.pace, 0, 0, target),
    markets:
      realReturnPct === undefined || realReturnPct <= 0 || b.invested === null
        ? undefined
        : landing(b.anchor, b.netWorth, b.invested, b.pace, b.contribution ?? 0, realReturnPct, target),
  });
  const n = at(now);
  const p = before === null ? null : at(before);
  return {
    saving: { lands: n.saving, shift: shiftBetween(n.saving, p?.saving) },
    markets: n.markets === undefined ? null : { lands: n.markets, shift: shiftBetween(n.markets, p?.markets) },
  };
}

/** Positions on the slider, which runs 0..SLIDER_STEPS. */
export const SLIDER_STEPS = 1000;

/**
 * Slider position → return, on a SQUARE scale: a quarter of the travel
 * covers 0 to about 7%, where every forecast and a century of history sit,
 * and the rest runs on to 100%. Linear, 5% would sit a few pixels from the
 * left edge of a phone-width slider. Snapped to half a point below 20%,
 * whole points above, so a drag lands on numbers a person would type.
 */
export function sliderToReturn(position: number): number {
  const raw = MAX_REAL_RETURN_PCT * Math.pow(Math.min(SLIDER_STEPS, Math.max(0, position)) / SLIDER_STEPS, 2);
  return raw < 20 ? Math.round(raw * 2) / 2 : Math.round(raw);
}

/** Return → the slider position that shows it (the inverse of sliderToReturn, before snapping). */
export function returnToSlider(pct: number): number {
  return Math.round(SLIDER_STEPS * Math.sqrt(Math.min(MAX_REAL_RETURN_PCT, Math.max(0, pct)) / MAX_REAL_RETURN_PCT));
}

/**
 * What saving the panel's controls writes, or why it refuses. A return of
 * zero clears it (no markets date); a CHANGED return is dated today, an
 * unchanged one keeps the day it was set, so the as-of date means when the
 * assumption was made, not when the target last moved. A monthly amount of
 * null clears it, and the deposit follows the data again.
 */
export function nextNetWorthGoal(
  stored: NetWorthGoal | null,
  input: { target: number; realReturnPct: number; monthlyInvest: number | null },
  today: string,
): { ok: true; goal: NetWorthGoal } | { ok: false; message: string } {
  if (!Number.isFinite(input.target) || input.target <= 0) {
    return { ok: false, message: "The target has to be a dollar amount above zero." };
  }
  if (input.target > 1e12) return { ok: false, message: "That target is too large to project." };
  if (!Number.isFinite(input.realReturnPct) || input.realReturnPct < 0 || input.realReturnPct > MAX_REAL_RETURN_PCT) {
    return { ok: false, message: `The market return has to be between 0% and ${MAX_REAL_RETURN_PCT}% a year.` };
  }
  const invest = input.monthlyInvest;
  if (invest !== null && (!Number.isFinite(invest) || invest < 0 || invest > MAX_MONTHLY_INVEST)) {
    return { ok: false, message: "The monthly amount has to be a dollar amount of zero or more." };
  }
  const target = round2(input.target);
  const monthly = invest === null ? {} : { monthlyInvest: round2(invest) };
  if (input.realReturnPct === 0) return { ok: true, goal: { target, ...monthly } };
  const unchanged = stored?.realReturnPct === input.realReturnPct && stored.returnSetOn !== undefined;
  return {
    ok: true,
    goal: {
      target,
      realReturnPct: input.realReturnPct,
      returnSetOn: unchanged ? stored!.returnSetOn! : today,
      ...monthly,
    },
  };
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

  const investedAt = (m: NetWorthMonth): number | null =>
    m.byAccount === null
      ? null
      : round2([...investedIds].reduce((sum, id) => sum + (m.byAccount?.[id] ?? 0), 0));

  const basisAt = (end: number): GoalBasis | null => {
    if (end < 0) return null;
    const pace = paceAt(months, end);
    if (pace === null) return null;
    return {
      anchor: months[end].period,
      netWorth: months[end].value,
      pace: pace.perMonth,
      paceMonths: pace.months,
      paceUncertainMonths: pace.uncertain,
      invested: investedAt(months[end]),
      contribution: depositAt(months, end, investedIds),
    };
  };

  // The basis is measured even for a goal already reached: the panel's
  // target control can raise the target past today's net worth.
  const end = months.length - 1;
  const basis = basisAt(end);
  const previousBasis = basis === null ? null : basisAt(end - 1);
  const reached = netWorth >= goal.target;
  // A monthly amount the operator set moves both dates; the pace and deposit
  // reported stay the measured ones, which the panel prints beside it.
  const projection =
    basis === null || reached
      ? null
      : projectGoal(
          withDeposit(basis, goal.monthlyInvest),
          previousBasis === null ? null : withDeposit(previousBasis, goal.monthlyInvest),
          goal.target,
          goal.realReturnPct,
        );
  const latest = end < 0 ? null : depositIn(months[end], investedIds);

  return {
    goal,
    netWorth,
    progress: Math.min(1, Math.max(0, netWorth / goal.target)),
    reached,
    basis,
    previousBasis,
    anchor: basis?.anchor ?? null,
    pace: basis?.pace ?? null,
    previousPace: previousBasis?.pace ?? null,
    paceMonths: basis?.paceMonths ?? 0,
    paceUncertainMonths: basis?.paceUncertainMonths ?? 0,
    invested: basis?.invested ?? null,
    contribution: basis?.contribution ?? null,
    previousContribution: previousBasis?.contribution ?? null,
    unmatchedDeposit:
      latest === null || basis?.contribution == null || sameDeposit(latest, basis.contribution) ? null : latest,
    saving: projection?.saving ?? null,
    markets: projection?.markets ?? null,
    refusal: basis === null ? "TOO_FEW_MONTHS" : null,
    recent: months.slice(-GOAL_CHART_HISTORY_MONTHS).map((m) => ({ period: m.period, value: m.value })),
  };
}
