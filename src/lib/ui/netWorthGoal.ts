import { round2 } from "../insights/stats";
import type { PayItem } from "../../types/contracts";
import type { PayChange, PayLevels, PendingPay } from "./payLevel";
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
 * target is buying power and the pace is held level in real terms.
 *
 * CASH earns what it measurably earns. Each cash account's yield is read
 * from the interest and dividends it was PAID (never its change in value,
 * which a deposit or a fund it once held would pass off as earnings): the
 * middle of its last three months, against the balance it started each month
 * with. Less the assumed inflation, a checking account that pays nothing
 * loses about 3% a year and a money market about breaks even. Cash HELD at
 * the month-end earns at where it sits then; NEW cash saving at where cash
 * sat on average over the pace window, since it waits in checking until it
 * moves in a lump. (One average for both read a balance moved into a money
 * market last month as two-thirds there, not nineteen-twentieths.) Both
 * dates use it: "saving alone" means no market return, not cash that stands
 * still in a world where prices rise.
 *
 * Money waiting in an account that pays nothing is where that loss lands, so
 * the panel says when checking holds more than a month of spending (the
 * middle of the last three) and what the best-paying cash account would earn
 * on the rest (idleCashAt). Money reaches that account in lumps, so there is
 * no monthly habit to keep up, only a balance to move.
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
 * The pace leaves out ONE-OFF pay (a bonus beside a paycheck, judged by
 * insights/oneOffPay.ts and carried on the CASH_FLOW_TREND rows): real
 * money, but averaged in it reads one bonus month as a monthly habit: two
 * bonuses in a six-month window raise its pace by a sixth of their total every
 * month. The panel names what it left out. And it projects from pay as it
 * is NOW (ui/payLevel.ts): six months after a raise most of the window still
 * holds the old paychecks, so each counts at today's amount.
 *
 * The operator can SET either monthly figure instead, to ask "what if": the
 * whole saving pace (`monthlyPace`) and the part of it invested
 * (`monthlyInvest`). Each means one thing: the saving is the total, the
 * investing only SPLITS it (withSaving). The first cut had a typed investing
 * amount change the total too ("investing more is saving more"), and an
 * investing field cleared to $0 read as saving the whole deposit less. Set back
 * to the measured figure, each clears and follows the data again.
 *
 * Today's dollars ASSUME the saving rises with inflation: a pace held level
 * in real terms is a deposit that grows in actual dollars every year. Left
 * at the same dollar amount it buys less each year and the dates slip, so
 * the panel compares the deposit with a year ago against an assumed 3%
 * (ASSUMED_INFLATION_PCT, keepingUp) and says when it has fallen behind.
 *
 * Dates are projected from the last COMPLETE month-end, never the live
 * balance, so they hold still through a month instead of moving with every
 * day's markets, and the shift since the month-end before compares like with
 * like. Progress is the live figure, Overview's headline.
 */

export const NET_WORTH_GOAL_KEY = "goals.netWorth";

/**
 * Six complete months: recent enough that this year's pay and spending set
 * it, not last year's, and long enough to smooth a big bill. A year was the
 * first window, chosen to smooth bonus months; with one-off pay left out
 * (oneOffPay) it only dragged in older months, cheaper ones whose card
 * spending had not been imported. Four is the least to project from.
 */
export const NET_WORTH_PACE_MONTHS = 6;
export const NET_WORTH_PACE_MIN_MONTHS = 4;

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
  /** Dollars saved a month in all, set by the operator in place of the measured pace. Absent: the measured pace. */
  monthlyPace?: number;
}

/**
 * The inflation the panel assumes when it says what today's dollars ask of
 * the operator, in percent a year. The dates do not use it (they are in
 * today's dollars); the note and the keeping-up check do, behind the ASSUMED
 * chip. Near the long-run US average.
 */
export const ASSUMED_INFLATION_PCT = 3;

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
    const pace = g.monthlyPace;
    const validPace = typeof pace === "number" && Number.isFinite(pace) && Math.abs(pace) <= MAX_MONTHLY_INVEST;
    if (pace !== undefined && !validPace) return null;
    return {
      target: g.target,
      ...(validPct ? { realReturnPct: pct as number } : {}),
      ...(typeof g.returnSetOn === "string" ? { returnSetOn: g.returnSetOn } : {}),
      ...(validInvest ? { monthlyInvest: invest as number } : {}),
      ...(validPace ? { monthlyPace: pace as number } : {}),
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
  /** Interest and dividends each account was paid; null or absent on rows stored before it was recorded. */
  interestByAccount?: Record<string, number> | null;
}

/** Cash waiting in accounts that pay nothing, beyond a month's spending. */
export interface IdleCash {
  /** Those accounts' live balances, summed. */
  held: number;
  /** A month of spending: the middle of the last three complete months. */
  buffer: number;
  /** `held` less `buffer`. */
  idle: number;
  /** The accounts it waits in. */
  from: string[];
  /** The best-paying cash account, and its measured yearly yield before inflation. */
  to: { name: string; nominalPct: number };
  /** What `idle` would earn there in a year. */
  yearly: number;
}

/** Below this, moving money is not worth a sentence. */
export const IDLE_CASH_MIN = 1000;

/**
 * Cash beyond a month's spending in the cash accounts that pay nothing, and
 * what the best-paying one would earn on it. A month of SPENDING, not what
 * leaves the account: a card payment and a lump moved to savings both leave
 * checking as transfers, and only the first is a need. Live balances, since
 * this asks for an action today. Null when no account pays anything, when the
 * spending cannot be measured, or when less than IDLE_CASH_MIN is idle.
 */
export function idleCashAt(
  cash: CashYield | null,
  live: readonly { id: string; balance: number }[],
  monthlySpending: readonly number[],
): IdleCash | null {
  if (cash === null || monthlySpending.length < DEPOSIT_MONTHS) return null;
  const best = cash.accounts.reduce<CashYield["accounts"][number] | null>(
    (top, a) => (a.nominalPct > 0 && (top === null || a.nominalPct > top.nominalPct) ? a : top),
    null,
  );
  const idleAccounts = cash.accounts.filter((a) => a.nominalPct === 0);
  if (best === null || idleAccounts.length === 0) return null;
  const recent = monthlySpending.slice(-DEPOSIT_MONTHS);
  const buffer = round2([...recent].sort((a, b) => a - b)[Math.floor(DEPOSIT_MONTHS / 2)]);
  const held = round2(
    idleAccounts.reduce((sum, a) => sum + Math.max(0, live.find((l) => l.id === a.id)?.balance ?? 0), 0),
  );
  const idle = round2(held - buffer);
  if (idle < IDLE_CASH_MIN) return null;
  return {
    held,
    buffer,
    idle,
    from: idleAccounts.map((a) => a.name),
    to: { name: best.name, nominalPct: best.nominalPct },
    yearly: round2(idle * (best.nominalPct / 100)),
  };
}

/**
 * The basis with `amount` moved from cash that pays nothing to an account
 * paying `nominalPct`: that share of the cash earns it from now on. What the
 * panel prices a move at, in months.
 */
export function withCashMoved(b: GoalBasis, amount: number, nominalPct: number): GoalBasis {
  if (b.cash <= 0 || amount <= 0) return b;
  const nominal = b.cashNominalPct + Math.min(1, amount / b.cash) * nominalPct;
  return { ...b, cashNominalPct: round2(nominal), cashRealPct: round2(((1 + nominal / 100) / (1 + ASSUMED_INFLATION_PCT / 100) - 1) * 100) };
}

/** Cash, as the projection treats it. */
export interface CashYield {
  /**
   * Each cash account: its measured yearly yield before inflation (percent),
   * its share of the cash held at the month-end, and its share of where cash
   * sat over the pace window.
   */
  accounts: { id: string; name: string; nominalPct: number; share: number; habitShare: number }[];
  /** Cash held: the mix at the month-end, before and after the assumed inflation, in percent a year. */
  nominalPct: number;
  realPct: number;
  /** New saving: the mix over the window, after the assumed inflation. */
  newRealPct: number;
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
  /** One-off pay inside the pace window, left out of it. */
  paceLeavesOut: PayItem[];
  /** Pay changes the pace projects across its window: earlier paychecks counted at the new amount. */
  payChanges: PayChange[];
  /** Paychecks at a new amount not yet repeated: counted as themselves; the panel asks. */
  payPending: PendingPay[];
  /** Invested money at the anchor, the part a return applies to; null when the row predates per-account values. */
  invested: number | null;
  /** The monthly deposit into invested money: the middle of the last three months; null without three months of flows. */
  contribution: number | null;
  /** The same deposit a year before the anchor, for the keeping-up check; null when it cannot be measured. */
  contributionYearAgo: number | null;
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
  /** What cash earns, measured; null on rows stored before interest was recorded, when cash is held level. */
  cash: CashYield | null;
  /** Cash beyond a month's spending sitting where it earns nothing; null when there is none worth moving. */
  idle: IdleCash | null;
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
function paceAt(months: readonly NetWorthMonth[], end: number, oneOffs: OneOffsByMonth, topUps: Readonly<Record<string, number>>) {
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
  // One-off pay in the months the window adds (each month after its base).
  const window = months.slice(base + 1, end + 1);
  const leftOut = window.flatMap((m) => oneOffs[m.period] ?? []);
  const extra = leftOut.reduce((sum, o) => sum + o.amount, 0);
  // Earlier paychecks counted at today's pay.
  const toppedUp = window.reduce((sum, m) => sum + (topUps[m.period] ?? 0), 0);
  return {
    base,
    months: span,
    perMonth: round2((growth.saved - extra + toppedUp) / span),
    uncertain: growth.uncertainMonths,
    leftOut,
  };
}

/** One-off pay by month ("2026-08"), as the CASH_FLOW_TREND rows carry it. */
export type OneOffsByMonth = Readonly<Record<string, readonly PayItem[]>>;

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

/**
 * What the cash earns as of `months[end]`. Each account's yield is the
 * middle of its last three months' interest against the balance it started
 * the month with, so a lump moved in one month cannot set it; its share is
 * its average month-end balance over the pace window, where cash SAT, since
 * money moves between the accounts in lumps. Null when a month in the window
 * predates recorded interest, or there is no cash to weigh.
 */
function cashYieldAt(
  months: readonly NetWorthMonth[],
  end: number,
  base: number,
  cashAccounts: readonly { id: string; name: string }[],
): (CashYield & { balance: number }) | null {
  if (cashAccounts.length === 0 || end < DEPOSIT_MONTHS) return null;
  for (let i = end - DEPOSIT_MONTHS + 1; i <= end; i += 1) {
    if (months[i].interestByAccount == null || months[i - 1].byAccount === null) return null;
  }
  const window = months.slice(base, end + 1);
  const sat = cashAccounts.map((a) => window.reduce((sum, m) => sum + Math.max(0, m.byAccount?.[a.id] ?? 0), 0) / window.length);
  const total = sat.reduce((sum, x) => sum + x, 0);
  if (total <= 0) return null;
  const held = cashAccounts.map((a) => Math.max(0, months[end].byAccount?.[a.id] ?? 0));
  const heldTotal = held.reduce((sum, x) => sum + x, 0);
  const accounts = cashAccounts.map((a, k) => {
    const rates: number[] = [];
    for (let i = end - DEPOSIT_MONTHS + 1; i <= end; i += 1) {
      const start = months[i - 1].byAccount?.[a.id] ?? 0;
      if (start > 0) rates.push((months[i].interestByAccount?.[a.id] ?? 0) / start);
    }
    const middle = rates.length === 0 ? 0 : [...rates].sort((x, y) => x - y)[Math.floor(rates.length / 2)];
    return {
      id: a.id,
      name: a.name,
      nominalPct: round2((Math.pow(1 + middle, 12) - 1) * 100),
      // No cash held at all: it would sit as it has.
      share: heldTotal > 0 ? held[k] / heldTotal : sat[k] / total,
      habitShare: sat[k] / total,
    };
  });
  const real = (nominal: number) => round2(((1 + nominal / 100) / (1 + ASSUMED_INFLATION_PCT / 100) - 1) * 100);
  const nominalPct = round2(accounts.reduce((sum, a) => sum + a.share * a.nominalPct, 0));
  const newNominalPct = round2(accounts.reduce((sum, a) => sum + a.habitShare * a.nominalPct, 0));
  return {
    accounts: accounts.filter((a) => a.share > 0 || a.habitShare > 0),
    nominalPct,
    realPct: real(nominalPct),
    newRealPct: real(newNominalPct),
    balance: round2(heldTotal),
  };
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
  const out = [b.netWorth];
  simulate(b, realReturnPct, months, (_t, value) => {
    out.push(value);
    return false;
  });
  return out;
}

/** A yearly percent as a monthly rate. */
const monthlyRate = (pct: number | undefined) => (pct === undefined || pct === 0 ? 0 : Math.pow(1 + pct / 100, 1 / 12) - 1);

/**
 * Net worth month by month from the basis, in three parts. Invested money
 * earns the real return (none: it keeps pace with prices) and takes the
 * monthly deposit. Cash earns its measured real yield while there is any and
 * takes the rest of the pace. Everything else (cards, loans) stands still.
 * `visit` sees each month's total and stops the run by returning true.
 */
function simulate(
  b: GoalBasis,
  realReturnPct: number | undefined,
  months: number,
  visit: (t: number, value: number) => boolean,
): void {
  const market = realReturnPct === undefined || realReturnPct <= 0 ? 0 : monthlyRate(realReturnPct);
  const heldRate = monthlyRate(b.cashRealPct);
  const newRate = monthlyRate(b.newCashRealPct);
  const known = b.invested !== null;
  const contribution = known ? (b.contribution ?? 0) : 0;
  let inv = known ? b.invested! : 0;
  // Cash held now earns where it sits; what is saved from here earns where
  // saved cash tends to sit.
  let held = b.cash;
  let saved = 0;
  const other = b.netWorth - inv - held;
  for (let t = 1; t <= months; t += 1) {
    held += held > 0 ? held * heldRate : 0;
    saved += saved > 0 ? saved * newRate : 0;
    // A deposit above the month's saving comes out of cash, and only cash
    // there is: once it runs out, investing is what is saved. Left uncapped,
    // cash went negative and the projection invested money borrowed at 0%.
    const deposit = Math.min(contribution, Math.max(0, held + saved + b.pace));
    inv = inv * (1 + market) + deposit;
    saved += b.pace - deposit;
    // What new saving cannot cover is drawn from the cash held.
    if (saved < 0 && held > 0) {
      const drawn = Math.min(held, -saved);
      held -= drawn;
      saved += drawn;
    }
    if (visit(t, inv + held + saved + other)) return;
  }
}

/** The first month, after the basis, that net worth reaches `target`; null beyond the horizon. */
function landing(b: GoalBasis, realReturnPct: number | undefined, target: number): string | null {
  if (b.netWorth >= target) return b.anchor;
  let lands: string | null = null;
  simulate(b, realReturnPct, NET_WORTH_HORIZON_MONTHS, (t, value) => {
    if (value < target) return false;
    lands = addMonths(b.anchor, t);
    return true;
  });
  return lands;
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
  /** Cash at the month-end, the part that earns `cashRealPct`; 0 when unmeasured. */
  cash: number;
  /** What the cash held earns a year after the assumed inflation, in percent; 0 (held level) when unmeasured. */
  cashRealPct: number;
  /** What new cash saving earns, the same way; 0 when unmeasured. */
  newCashRealPct: number;
  /** The same before inflation; 0 when unmeasured. */
  cashNominalPct: number;
}

/** The monthly figures the operator set in place of the measured ones; absent ones follow the data. */
export interface SavingOverrides {
  monthlyInvest?: number;
  monthlyPace?: number;
}

/**
 * The basis with the figures the operator SET. The pace is the whole of what
 * is saved and the deposit only its invested part: investing $500 more of
 * the same saving moves $500 a month from cash into the market, and saving
 * more is the pace's own field. Nothing set leaves the basis as measured.
 */
export function withSaving(b: GoalBasis, set: SavingOverrides): GoalBasis {
  const contribution = set.monthlyInvest ?? b.contribution;
  const pace = set.monthlyPace ?? b.pace;
  return pace === b.pace && contribution === b.contribution ? b : { ...b, pace, contribution };
}

/**
 * Has the monthly deposit kept up with inflation over the past year? What
 * today's dollars assume: a deposit at the same dollar amount buys less each
 * year, and a projection holding it level in real terms quietly counts on a
 * raise. `needed` is a year-old deposit grown by the assumed inflation.
 */
export function keepingUp(
  now: number,
  yearAgo: number,
  inflationPct: number = ASSUMED_INFLATION_PCT,
): { needed: number; changePct: number; behind: boolean } {
  const needed = round2(yearAgo * (1 + inflationPct / 100));
  const changePct = yearAgo === 0 ? 0 : Math.round(((now - yearAgo) / yearAgo) * 100);
  return { needed, changePct, behind: now < needed - 0.005 };
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
    saving: landing(b, undefined, target),
    markets:
      realReturnPct === undefined || realReturnPct <= 0 || b.invested === null ? undefined : landing(b, realReturnPct, target),
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
  input: { target: number; realReturnPct: number; monthlyInvest: number | null; monthlyPace: number | null },
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
  const pace = input.monthlyPace;
  if (pace !== null && (!Number.isFinite(pace) || Math.abs(pace) > MAX_MONTHLY_INVEST)) {
    return { ok: false, message: "The monthly saving has to be a dollar amount." };
  }
  const target = round2(input.target);
  const monthly = {
    ...(invest === null ? {} : { monthlyInvest: round2(invest) }),
    ...(pace === null ? {} : { monthlyPace: round2(pace) }),
  };
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
  /** The operator's cash definition, named for the panel; none holds cash level, as before interest was measured. */
  cashAccounts?: readonly { id: string; name: string }[];
  /** Those accounts' live balances, for the idle-cash line. */
  liveCash?: readonly { id: string; balance: number }[];
  /** Spending in each complete month, oldest first: a month of it is the buffer checking keeps. */
  monthlySpending?: readonly number[];
  /** One-off pay by month: left out of the pace. */
  oneOffs?: OneOffsByMonth;
  /** Pay as it is now: earlier paychecks in the window count at it. */
  pay?: PayLevels;
}): NetWorthGoalAssessment {
  const { goal, liveNetWorth, months, investedIds } = input;
  const cashAccounts = input.cashAccounts ?? [];
  const oneOffs = input.oneOffs ?? {};
  const topUps = input.pay?.topUps ?? {};
  const netWorth = round2(liveNetWorth);

  const investedAt = (m: NetWorthMonth): number | null =>
    m.byAccount === null
      ? null
      : round2([...investedIds].reduce((sum, id) => sum + (m.byAccount?.[id] ?? 0), 0));

  const basisAt = (end: number): GoalBasis | null => {
    if (end < 0) return null;
    const pace = paceAt(months, end, oneOffs, topUps);
    if (pace === null) return null;
    const cash = cashYieldAt(months, end, pace.base, cashAccounts);
    return {
      anchor: months[end].period,
      netWorth: months[end].value,
      pace: pace.perMonth,
      paceMonths: pace.months,
      paceUncertainMonths: pace.uncertain,
      invested: investedAt(months[end]),
      contribution: depositAt(months, end, investedIds),
      cash: cash?.balance ?? 0,
      cashRealPct: cash?.realPct ?? 0,
      newCashRealPct: cash?.newRealPct ?? 0,
      cashNominalPct: cash?.nominalPct ?? 0,
    };
  };
  const cashAt = (end: number) => {
    const pace = end < 0 ? null : paceAt(months, end, oneOffs, topUps);
    if (pace === null) return null;
    const c = cashYieldAt(months, end, pace.base, cashAccounts);
    return c === null ? null : { accounts: c.accounts, nominalPct: c.nominalPct, realPct: c.realPct, newRealPct: c.newRealPct };
  };

  // The basis is measured even for a goal already reached: the panel's
  // target control can raise the target past today's net worth.
  const end = months.length - 1;
  const basis = basisAt(end);
  const previousBasis = basis === null ? null : basisAt(end - 1);
  const reached = netWorth >= goal.target;
  // Monthly figures the operator set move both dates; the pace and deposit
  // reported stay the measured ones, which the panel prints beside them.
  const set: SavingOverrides = { monthlyInvest: goal.monthlyInvest, monthlyPace: goal.monthlyPace };
  const projection =
    basis === null || reached
      ? null
      : projectGoal(
          withSaving(basis, set),
          previousBasis === null ? null : withSaving(previousBasis, set),
          goal.target,
          goal.realReturnPct,
        );
  const latest = end < 0 ? null : depositIn(months[end], investedIds);
  const cash = cashAt(end);
  const paceNow = basis === null ? null : paceAt(months, end, oneOffs, topUps);

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
    paceLeavesOut: paceNow?.leftOut ?? [],
    // A change the window still holds paychecks from before: the pace counts them at the new amount.
    payChanges:
      paceNow === null ? [] : (input.pay?.changes ?? []).filter((c) => c.since.slice(0, 7) > months[paceNow.base].period),
    payPending: input.pay?.pending ?? [],
    invested: basis?.invested ?? null,
    contribution: basis?.contribution ?? null,
    contributionYearAgo: end - 12 < 0 ? null : depositAt(months, end - 12, investedIds),
    previousContribution: previousBasis?.contribution ?? null,
    unmatchedDeposit:
      latest === null || basis?.contribution == null || sameDeposit(latest, basis.contribution) ? null : latest,
    saving: projection?.saving ?? null,
    markets: projection?.markets ?? null,
    cash,
    idle: idleCashAt(cash, input.liveCash ?? [], input.monthlySpending ?? []),
    refusal: basis === null ? "TOO_FEW_MONTHS" : null,
    recent: months.slice(-GOAL_CHART_HISTORY_MONTHS).map((m) => ({ period: m.period, value: m.value })),
  };
}
