import { describe, expect, it } from 'vitest';
import { RUNWAY_MIN_MONTHS, RUNWAY_MONTHS } from '../ui/liquidity';
import { GOAL_RATE_MIN_MONTHS, GOAL_RATE_MONTHS } from './goals';
import {
  assessReadiness,
  monthlyPiti,
  nonHousingSpending,
  parseReadiness,
  type ReadinessConfig,
} from './readiness';

/** The design's worked example (docs/backlog.md, 2026-08-01), verbatim. */
const BOOK: ReadinessConfig = {
  savingsFloor: 5183.46,
  ratePct: 6.5,
  termYears: 30,
  taxPctYr: 1.2,
  insurancePctYr: 0.5,
  pmiPctYr: 0.75,
  closingPct: 3,
  downPct: 20,
  asOf: '2026-08-01',
};

/** Six months whose residual is exactly the book's $6,465.61 budget. */
const INCOME = [18142.10, 18142.10, 18142.10, 18142.10, 18142.10, 18142.10];
const NON_HOUSING = [6493.03, 6493.03, 6493.03, 6493.03, 6493.03, 6493.03];

const assess = (over: Partial<Parameters<typeof assessReadiness>[0]> = {}) =>
  assessReadiness({
    config: BOOK,
    fund: 155_503.76,
    completeMonthlyIncome: INCOME,
    completeMonthlyNonHousing: NON_HOUSING,
    ...over,
  });

describe('rate window parity', () => {
  // Readiness averages the SAME window goals and runway do — imported from
  // goals directly, and pinned against runway here so all three stay one
  // notion of "recent complete months".
  it('uses the window computeRunway and assessGoals average over', () => {
    expect(GOAL_RATE_MONTHS).toBe(RUNWAY_MONTHS);
    expect(GOAL_RATE_MIN_MONTHS).toBe(RUNWAY_MIN_MONTHS);
  });
});

describe('adversarial-review regressions (2026-08-01)', () => {
  it('a budget inside the PMI jump returns a price whose PITI still fits', () => {
    // The jump spans PITI $4,376.55 → $4,714.64 at the fund-limited price;
    // $4,535.53 lands inside it, so no price solves exactly. The bisection
    // converges to the supremum, and rounding it UP crossed the discontinuity
    // — the returned price cost the full PMI increment more than the budget.
    // Floored, the contract holds: PITI at the returned price ≤ budget.
    const a = assess({
      completeMonthlyIncome: [18142.10, 18142.10, 18142.10, 18142.10, 18142.10, 18142.10],
      completeMonthlyNonHousing: [8423.12, 8423.12, 8423.12, 8423.12, 8423.12, 8423.12], // budget 4535.52
    });
    expect(a.refusal).toBeNull();
    expect(a.paymentLimitedPrice).not.toBeNull();
    expect(monthlyPiti(a.paymentLimitedPrice ?? 0, BOOK, 155_503.76)).toBeLessThanOrEqual(4535.52);
    // The jump sits AT the fund-limited price, so the fund binds here.
    expect(a.bindingConstraint).toBe('FUND');
  });

  it('refuses a series carrying a non-finite value rather than printing NaN', () => {
    // Unreachable from JSON-parsed payloads today (JSON cannot carry NaN) —
    // defense in depth against a malformed payload after schema drift, where
    // "NaN <= 0" dodging the floor refusal printed a NaN budget beside a $0
    // ceiling labelled PAYMENT-bound.
    const a = assess({ completeMonthlyIncome: [18142.10, NaN, 18142.10, 18142.10, 18142.10, 18142.10] });
    expect(a.refusal).toBe('TOO_FEW_MONTHS');
    expect(a.pitiBudget).toBeNull();
    expect(a.paymentLimitedPrice).toBeNull();
  });
});

describe('the book numbers — the design worked example must reproduce', () => {
  // The design entry records: PITI budget $6,465.61/mo; the $156k fund buys
  // ~$676k conventional with ~$2,100/mo of payment slack, ~$880k stretching
  // through PMI; balancing the two constraints wants ~$230k cash for ~$999k of
  // house. If the formulation cannot hit these, the formulation is wrong.
  const a = assess();

  it('computes the $6,465.61 PITI budget from the residual', () => {
    expect(a.pitiBudget).toBe(6465.61);
    expect(a.incomeMean).toBe(18142.10);
    expect(a.nonHousingMean).toBe(6493.03);
    expect(a.refusal).toBeNull();
  });

  it('fund-limited: the $156k fund caps at ~$676k (down + closing, no PMI)', () => {
    expect(a.fundLimitedPrice).toBe(676_103.30); // 155,503.76 / 23%
    expect(Math.abs(a.fundLimitedPrice - 676_441.36)).toBeLessThan(5183.46);
  });

  it('payment-limited: the budget stretches to ~$880k through PMI', () => {
    expect(Math.abs((a.paymentLimitedPrice ?? 0) - 881_187.97)).toBeLessThan(5183.46);
    expect(a.paymentLimitedPrice).toBeCloseTo(880_403.48, 0);
  });

  it('names the fund as the binding constraint', () => {
    expect(a.bindingConstraint).toBe('FUND');
  });

  it('balancing the two wants ~$230k cash for ~$999k of house', () => {
    expect(Math.abs((a.balancedPrice ?? 0) - 997_815.79)).toBeLessThan(5183.46);
    expect(Math.abs((a.cashNeededAtBalance ?? 0) - 230_663.91)).toBeLessThan(5183.46);
    expect(a.cashNeededAtBalance).toBeCloseTo((a.balancedPrice ?? 0) * 0.23, 1);
  });

  it('leaves ~$2,100/mo of payment slack at the fund-limited price', () => {
    const slack = (a.pitiBudget ?? 0) - monthlyPiti(a.fundLimitedPrice, BOOK, 155_503.76);
    expect(slack).toBeCloseTo(2089.05, 1);
  });

  it('solves the back-out to the budget: PITI at the ceiling IS the budget', () => {
    expect(monthlyPiti(a.paymentLimitedPrice ?? 0, BOOK, 155_503.76)).toBeCloseTo(6465.61, 2);
  });
});

describe('amortization mechanics', () => {
  it('charges PMI below the down threshold and not at it', () => {
    // At the fund-limited price the down fraction is exactly 20% — no PMI.
    // $25.92k beyond it the fund thins to ~19% down and PMI applies to the loan.
    const atThreshold = monthlyPiti(676_103.30, BOOK, 155_503.76);
    const beyond = monthlyPiti(702_020.59, BOOK, 155_503.76);
    const factor = (1 - Math.pow(1 + 0.065 / 12, -360)) / (0.065 / 12);
    const loanAt = 676_103.30 * 0.8;
    expect(atThreshold).toBeCloseTo(loanAt / factor + (676_103.30 * 0.017) / 12, 2);
    // The jump is bigger than the extra $25.92k of price alone explains — PMI.
    const closing = 702_020.59 * 0.03;
    const loanBeyond = 702_020.59 - (155_503.76 - closing);
    expect(beyond).toBeCloseTo(
      loanBeyond / factor + (702_020.59 * 0.017) / 12 + (loanBeyond * 0.0075) / 12,
      2,
    );
  });

  it('picks PAYMENT as binding when the budget is the lower ceiling', () => {
    const a = assess({
      completeMonthlyIncome: [10366.92, 10366.92, 10366.92, 10366.92, 10366.92, 10366.92],
      completeMonthlyNonHousing: [3887.59, 3887.59, 3887.59, 3887.59, 3887.59, 3887.59],
    });
    // Budget $1295.86/mo carries far less than the $156k fund could cover.
    expect(a.pitiBudget).toBe(1295.87);
    expect(a.bindingConstraint).toBe('PAYMENT');
    expect(a.paymentLimitedPrice ?? 0).toBeLessThan(a.fundLimitedPrice);
  });

  it('averages only the last six complete months, like the goal rate', () => {
    const a = assess({
      completeMonthlyIncome: [99_999, -99_999, ...INCOME],
      completeMonthlyNonHousing: [0, 0, ...NON_HOUSING],
    });
    expect(a.basisMonths).toBe(6);
    expect(a.incomeMean).toBe(18142.10);
    expect(a.pitiBudget).toBe(6465.61);
  });

  it('clamps an overdrawn fund to a $0 ceiling instead of a negative price', () => {
    const a = assess({ fund: -1295.86 });
    expect(a.fundLimitedPrice).toBe(0);
    expect(a.bindingConstraint).toBe('FUND');
  });
});

describe('refusals — the facts either side survive', () => {
  it('refuses under three complete months, keeping the fund-limited ceiling', () => {
    const a = assess({
      completeMonthlyIncome: [18142.10, 18142.10],
      completeMonthlyNonHousing: [6493.03, 6493.03],
    });
    expect(a.refusal).toBe('TOO_FEW_MONTHS');
    expect(a.basisMonths).toBe(2);
    expect(a.pitiBudget).toBeNull();
    expect(a.paymentLimitedPrice).toBeNull();
    // The fund-limited ceiling depends on nothing refused — it survives.
    expect(a.fundLimitedPrice).toBe(676_103.30);
  });

  it('computes from exactly the minimum months, like computeRunway', () => {
    const a = assess({
      completeMonthlyIncome: [18142.10, 18142.10, 18142.10],
      completeMonthlyNonHousing: [6493.03, 6493.03, 6493.03],
    });
    expect(a.refusal).toBeNull();
    expect(a.pitiBudget).toBe(6465.61);
  });

  it('refuses a floor at or above the residual, keeping the budget that refused', () => {
    const a = assess({
      config: { ...BOOK, savingsFloor: 11921.95 }, // residual is 11,649.07
    });
    expect(a.refusal).toBe('FLOOR_EXCEEDS_RESIDUAL');
    // The ≤0 budget is the reason there is no ceiling — visible, not hidden.
    expect(a.pitiBudget).toBe(-272.88);
    expect(a.incomeMean).toBe(18142.10);
    expect(a.nonHousingMean).toBe(6493.03);
    expect(a.paymentLimitedPrice).toBeNull();
    expect(a.fundLimitedPrice).toBe(676_103.30);
  });

  it('refuses a floor that exactly consumes the residual — zero is not a budget', () => {
    const a = assess({ config: { ...BOOK, savingsFloor: 11649.07 } });
    expect(a.refusal).toBe('FLOOR_EXCEEDS_RESIDUAL');
    expect(a.pitiBudget).toBe(0);
  });
});

describe('nonHousingSpending — the refund-proof subtraction', () => {
  it('subtracts Rent & Housing from the month total', () => {
    expect(
      nonHousingSpending({
        totalSpending: 4267,
        categories: [
          { categoryName: 'Rent & Housing', spending: 1799 },
          { categoryName: 'Dining', spending: 900 },
        ],
      }),
    ).toBe(2468);
  });

  it('pushes non-housing ABOVE the total in a refund month — June −$401.85', () => {
    // June 2026's Rent & Housing was net negative (a reimbursement). The
    // refund belongs to housing; the non-housing baseline must not absorb it.
    expect(
      nonHousingSpending({
        totalSpending: 3535.25,
        categories: [{ categoryName: 'Rent & Housing', spending: -401.85 }],
      }),
    ).toBeCloseTo(3937.10, 2);
  });

  it('treats an absent housing row as $0 housing that month', () => {
    expect(
      nonHousingSpending({
        totalSpending: 2000,
        categories: [{ categoryName: 'Dining', spending: 900 }],
      }),
    ).toBe(2000);
  });

  it('matches the category by name, case-insensitively, ignoring null names', () => {
    expect(
      nonHousingSpending({
        totalSpending: 3000,
        categories: [
          { categoryName: null, spending: 100 },
          { categoryName: 'rent & housing', spending: 1800 },
        ],
      }),
    ).toBe(1200);
  });
});

describe('parseReadiness', () => {
  it('round-trips a valid config', () => {
    expect(parseReadiness(JSON.stringify(BOOK))).toEqual(BOOK);
  });

  it('survives corruption rather than taking the page down', () => {
    expect(parseReadiness(null)).toBeNull();
    expect(parseReadiness('not json')).toBeNull();
    expect(parseReadiness('[]')).toBeNull();
    expect(parseReadiness('{"savingsFloor":5183.46}')).toBeNull();
  });

  it('rejects out-of-range values — no default rate ever fills in', () => {
    expect(parseReadiness(JSON.stringify({ ...BOOK, ratePct: 0 }))).toBeNull();
    expect(parseReadiness(JSON.stringify({ ...BOOK, ratePct: 45 }))).toBeNull();
    expect(parseReadiness(JSON.stringify({ ...BOOK, downPct: 0 }))).toBeNull();
    expect(parseReadiness(JSON.stringify({ ...BOOK, savingsFloor: -1 }))).toBeNull();
    expect(parseReadiness(JSON.stringify({ ...BOOK, termYears: 0 }))).toBeNull();
    expect(parseReadiness(JSON.stringify({ ...BOOK, asOf: 'August 2026' }))).toBeNull();
  });
});
