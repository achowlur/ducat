import { GOAL_RATE_MIN_MONTHS, GOAL_RATE_MONTHS } from './goals';
import { round2 } from './stats';

/**
 * House readiness: "am I close enough to start looking?" — a READINESS signal,
 * explicitly NOT lender math. Whether underwriting would approve is a question
 * this model deliberately does not answer, the same way the tax cost of
 * liquidating a brokerage is out of scope (docs/backlog.md records both, with
 * the rejected alternatives: gross-income DTI fails because bank inflows are
 * net of tax/401k, and mortgage-as-share-of-spending punishes frugality).
 *
 * The canonical form is the RESIDUAL:
 *
 *   PITI budget = observed net income − observed non-housing spending
 *                 − declared savings floor
 *
 * averaged over the same complete-month window runway and goals use. Non-housing
 * is total spending minus Rent & Housing PER MONTH, then averaged — which makes
 * the form REFUND-PROOF: June 2026's Rent & Housing was −$401.85 (a
 * reimbursement month), which distorts any "rent + savings rate" form and
 * cancels out of this one. That is why the residual is canonical and the
 * rent+rate form is only a derived identity.
 *
 * Everything typed (rate, term, tax, insurance, PMI, closing, down) renders
 * with its value and an ASSUMED chip; the one declared knob is the savings
 * floor — how much monthly saving must survive the purchase. NO DEFAULT RATE
 * LIVES IN CODE: absent config means the panel does not render, the same
 * opt-in shape as goals.
 *
 * Outputs are TWO price ceilings with the binding one NAMED:
 *  - FUND-LIMITED — the no-PMI path: the declared fund covers down% + closing%
 *    of the price, so ceiling = fund / (down% + closing%). Named FUND-limited,
 *    never "deposit-limited": the binding constraint is the DECLARED FUND, and
 *    phrasing it as incapacity is factually wrong for an operator holding a
 *    brokerage that could fund a deposit tomorrow. The model measures
 *    readiness OF THE DECLARED PLAN.
 *  - PAYMENT-LIMITED — the amortization back-out: the largest price whose
 *    monthly PITI fits the budget, with the fund paying closing first and the
 *    remainder going to down, and PMI (as %/yr of loan) added while the down
 *    fraction sits below the declared no-PMI threshold.
 *
 * Refusals inherited whole from goals/runway: fewer complete months than the
 * minimum, and a floor at or above income minus non-housing (the budget is
 * ≤ 0 and it says so, naming the floor as the reason). Every refusal keeps
 * the facts either side of it — the fund-limited ceiling depends on nothing
 * refused, so it survives both.
 */

export const HOUSE_READINESS_KEY = 'readiness.house';

/** The category the residual subtracts, matched by NAME in spending payloads. */
export const HOUSING_CATEGORY = 'Rent & Housing';

/** Bisection domain and depth: 5e6 / 2^60 resolves far below one cent. */
const PRICE_CAP = 5_000_000;
const BISECT_ITERATIONS = 60;

/**
 * Strictly-below-threshold PMI, with an epsilon so the fund-limited price —
 * where the down fraction is EXACTLY the threshold, by construction — never
 * picks up PMI through floating-point noise. 1e-6 and not smaller because the
 * price is round2'd: a half-cent of rounding moves the down fraction by ~4e-9,
 * and a full dollar by ~9e-7, both of which are "at the threshold" for a model
 * that is explicitly not lender math (1e-6 of down on a $673.85k house is 26
 * cents). Measured before choosing: at 1e-9 the rounded fund-limited price
 * itself picked up $336.92/mo of PMI it does not owe.
 */
const PMI_EPSILON = 1e-6;

export interface ReadinessConfig {
  /** Dollars/mo of saving that must survive the purchase — the declared knob. */
  savingsFloor: number;
  /** Typed yearly rate in percent (6.5 = 6.5%/yr). Never defaulted in code. */
  ratePct: number;
  termYears: number;
  /** Property tax as %/yr of price. */
  taxPctYr: number;
  /** Insurance as %/yr of price. */
  insurancePctYr: number;
  /** PMI as %/yr of LOAN, applied below the down threshold. */
  pmiPctYr: number;
  /** Closing costs as % of price, paid from the fund. */
  closingPct: number;
  /** Down payment target and no-PMI threshold, % of price. */
  downPct: number;
  /** Date the typed rate was read (YYYY-MM-DD) — rendered beside it. */
  asOf: string;
}

const AS_OF = /^\d{4}-\d{2}-\d{2}$/;

const inRange = (v: unknown, lo: number, hi: number, exclusiveLo = false): v is number =>
  typeof v === 'number' && Number.isFinite(v) && (exclusiveLo ? v > lo : v >= lo) && v <= hi;

/**
 * The one definition of a valid config, shared by the tolerant parser below
 * and `scripts/set-readiness.ts` — the script refuses loudly per flag, then
 * this decides what may be stored, so the two cannot drift.
 */
export function isReadinessConfig(v: unknown): v is ReadinessConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    inRange(c.savingsFloor, 0, 1_000_000) &&
    inRange(c.ratePct, 0, 30, true) &&
    inRange(c.termYears, 0, 100, true) &&
    inRange(c.taxPctYr, 0, 10) &&
    inRange(c.insurancePctYr, 0, 10) &&
    inRange(c.pmiPctYr, 0, 10) &&
    inRange(c.closingPct, 0, 25) &&
    inRange(c.downPct, 0, 100, true) &&
    typeof c.asOf === 'string' &&
    AS_OF.test(c.asOf)
  );
}

/** The stored Setting value → config; tolerant the way parseGoals is. */
export function parseReadiness(raw: string | null): ReadinessConfig | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReadinessConfig(parsed) ? parsed : null;
  } catch {
    return null; // a corrupted setting must not take the page down
  }
}

/**
 * One month's non-housing spending from a SPENDING_BY_CATEGORY payload:
 * total minus Rent & Housing. A month with no Rent & Housing row subtracts
 * zero, which is correct arithmetic, and a NEGATIVE housing month (June's
 * −$401.85 refund) correctly pushes non-housing ABOVE the total — the refund
 * belongs to housing and must not flatter the non-housing baseline.
 */
export function nonHousingSpending(payload: {
  totalSpending: number;
  categories: readonly { categoryName: string | null; spending: number }[];
}): number {
  const housing = payload.categories
    .filter((c) => c.categoryName !== null && c.categoryName.toLowerCase() === HOUSING_CATEGORY.toLowerCase())
    .reduce((s, c) => s + c.spending, 0);
  return payload.totalSpending - housing;
}

export type ReadinessRefusal = 'TOO_FEW_MONTHS' | 'FLOOR_EXCEEDS_RESIDUAL';

export interface ReadinessAssessment {
  config: ReadinessConfig;
  /** The declared fund's assessed balance — the first savings goal's `saved`. */
  fund: number;
  /** Complete months the means are drawn from (0–GOAL_RATE_MONTHS). */
  basisMonths: number;
  incomeMean: number | null;
  nonHousingMean: number | null;
  /** The estimated mortgage budget per month; kept ≤ 0 under the floor refusal. */
  pitiBudget: number | null;
  /**
   * fund / (down% + closing%) — the no-PMI path. Depends on nothing refused,
   * so it survives every refusal. Clamped at 0 for an overdrawn fund.
   */
  fundLimitedPrice: number;
  /** Largest price whose monthly PITI fits the budget; null without a budget. */
  paymentLimitedPrice: number | null;
  /** Which ceiling is lower — the one that actually constrains the purchase. */
  bindingConstraint: 'FUND' | 'PAYMENT' | null;
  /** Price where the two ceilings meet — what the plan supports once the fund
   * catches up to the payment budget. */
  balancedPrice: number | null;
  /** (down% + closing%) of the balanced price — the cash that balance needs. */
  cashNeededAtBalance: number | null;
  refusal: ReadinessRefusal | null;
}

/** (1 − (1+i)^−n) / i — dollars of loan per dollar of monthly payment. */
function annuityFactor(ratePct: number, termYears: number): number {
  const i = ratePct / 100 / 12;
  const n = termYears * 12;
  return (1 - Math.pow(1 + i, -n)) / i;
}

/**
 * Monthly PITI at a price: the fund pays closing first, the remainder is the
 * down payment, and the loan carries PMI while the down fraction sits below
 * the declared threshold. Exported so tests can hold the solved prices to
 * account — the design's "~$2,100/mo of payment slack" at the fund-limited
 * ceiling is checked against this, not re-derived.
 */
export function monthlyPiti(price: number, config: ReadinessConfig, fund: number): number {
  if (price <= 0) return 0;
  const closing = (price * config.closingPct) / 100;
  const down = Math.max(0, fund - closing);
  const loan = Math.max(0, price - down);
  const piti =
    loan / annuityFactor(config.ratePct, config.termYears) +
    (price * (config.taxPctYr + config.insurancePctYr)) / 100 / 12;
  const belowThreshold = down / price < config.downPct / 100 - PMI_EPSILON;
  return belowThreshold ? piti + (loan * config.pmiPctYr) / 100 / 12 : piti;
}

/**
 * Largest price in [0, PRICE_CAP] whose PITI fits the budget. PITI is monotone
 * nondecreasing in price (loan, tax and insurance all grow with it, and the
 * PMI step only ever adds), so bisection converges even across the PMI jump —
 * no closed form has to fight the discontinuity.
 */
function paymentLimited(budget: number, config: ReadinessConfig, fund: number): number {
  if (monthlyPiti(PRICE_CAP, config, fund) <= budget) return PRICE_CAP;
  let lo = 0;
  let hi = PRICE_CAP;
  for (let k = 0; k < BISECT_ITERATIONS; k += 1) {
    const mid = (lo + hi) / 2;
    if (monthlyPiti(mid, config, fund) <= budget) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * @param completeMonthlyIncome / @param completeMonthlyNonHousing Aligned
 *   per-month series of COMPLETE months only, oldest first — the caller cuts
 *   the partial current month, exactly as it feeds assessGoals. Non-housing is
 *   built per month by `nonHousingSpending` BEFORE averaging (the refund-proof
 *   property lives in that order).
 */
export function assessReadiness(input: {
  config: ReadinessConfig;
  fund: number;
  completeMonthlyIncome: readonly number[];
  completeMonthlyNonHousing: readonly number[];
}): ReadinessAssessment {
  const { config, fund } = input;

  // Same window as the savings-goal rate and the runway — one notion of
  // "recent complete months" on the app (readiness.test.ts pins the parity).
  const months = Math.min(input.completeMonthlyIncome.length, input.completeMonthlyNonHousing.length);
  const income = input.completeMonthlyIncome.slice(0, months).slice(-GOAL_RATE_MONTHS);
  const nonHousing = input.completeMonthlyNonHousing.slice(0, months).slice(-GOAL_RATE_MONTHS);
  const basisMonths = income.length;

  const cashShare = (config.downPct + config.closingPct) / 100;
  const fundLimitedPrice = round2(Math.max(0, fund / cashShare));

  const base = {
    config,
    fund: round2(fund),
    basisMonths,
    incomeMean: null as number | null,
    nonHousingMean: null as number | null,
    pitiBudget: null as number | null,
    fundLimitedPrice,
    paymentLimitedPrice: null as number | null,
    bindingConstraint: null as 'FUND' | 'PAYMENT' | null,
    balancedPrice: null as number | null,
    cashNeededAtBalance: null as number | null,
    refusal: null as ReadinessRefusal | null,
  };

  if (basisMonths < GOAL_RATE_MIN_MONTHS) return { ...base, refusal: 'TOO_FEW_MONTHS' };

  const mean = (xs: readonly number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
  const incomeMean = mean(income);
  const nonHousingMean = mean(nonHousing);
  const pitiBudget = incomeMean - nonHousingMean - config.savingsFloor;
  const facts = {
    incomeMean: round2(incomeMean),
    nonHousingMean: round2(nonHousingMean),
    // + 0 folds the −0 a tiny negative residue rounds to back into +0, so a
    // floor that exactly consumes the residual never prints "−$0.00/mo".
    pitiBudget: round2(pitiBudget) + 0,
  };

  // The floor ate the whole residual. The budget that refused is a fact and
  // survives — "−$311.01/mo" is the reason there is no ceiling, and the reader
  // should see it beside the floor that caused it. Decided on the ROUNDED
  // figure, which is also the displayed one: deciding on the raw float lets a
  // 5e-11 residue print "$0.00/mo" while claiming a budget exists.
  if (facts.pitiBudget <= 0) return { ...base, ...facts, refusal: 'FLOOR_EXCEEDS_RESIDUAL' };

  const paymentLimitedPrice = round2(paymentLimited(facts.pitiBudget, config, fund));

  // Where the ceilings meet, the fund exactly covers down + closing — the down
  // fraction sits AT the threshold, so no PMI, and the price is linear in the
  // budget: budget = P × (loanShare/F + (tax+ins)/1200). Solved closed-form;
  // only the actual-fund back-out needs the bisection.
  const loanShare = 1 - config.downPct / 100;
  const carryPerDollar =
    loanShare / annuityFactor(config.ratePct, config.termYears) +
    (config.taxPctYr + config.insurancePctYr) / 100 / 12;
  const balancedPrice = carryPerDollar > 0 ? round2(facts.pitiBudget / carryPerDollar) : null;

  return {
    ...base,
    ...facts,
    paymentLimitedPrice,
    bindingConstraint: fundLimitedPrice <= paymentLimitedPrice ? 'FUND' : 'PAYMENT',
    balancedPrice,
    cashNeededAtBalance: balancedPrice === null ? null : round2(balancedPrice * cashShare),
  };
}
