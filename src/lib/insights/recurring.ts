import type { RecurringCadence, RecurringChargePayload } from '../../types/contracts';
import { median, round2 } from './stats';
import type { TxnData } from './types';

export interface RecurringOptions {
  /** Minimum occurrences before a merchant counts as recurring. */
  minOccurrences: number;
  /** Fraction of the median amount an occurrence may deviate and still match. */
  amountTolerance: number;
  /** Fraction of occurrences that must match cadence and amount checks. */
  matchRatio: number;
  /** Relative increase of the last charge over prior median that flags a price rise. */
  priceIncreaseThreshold: number;
}

export const DEFAULT_RECURRING_OPTIONS: RecurringOptions = {
  minOccurrences: 3,
  amountTolerance: 0.25,
  matchRatio: 0.8,
  priceIncreaseThreshold: 0.02,
};

const DAY_MS = 86_400_000;

/**
 * Recurring, but NOT subscriptions.
 *
 * Rent and taxes arrive on a cadence, in consistent amounts, from a stable
 * descriptor — the exact shape the detector hunts for — but nobody manages
 * them from a subscriptions list, and listing them buries the two or three
 * things actually worth cancelling.
 *
 * This is also what settles the rent PORTAL. Zego (formerly PayLease) billed
 * $7.88 every month, which has the shape of a subscription and the substance
 * of paying rent: it is the convenience fee on a rent payment, not a service
 * with a plan. Categorising it as Rent & Housing is right whether a portal
 * bills the fee (as here) or the whole rent (as it does for others) — and
 * excluding the category is what stops it being reported as something you
 * could cancel.
 */
export const NOT_SUBSCRIPTION_CATEGORIES = new Set(['Rent & Housing', 'Taxes']);

const CADENCE_BANDS: { cadence: RecurringCadence; min: number; max: number }[] = [
  { cadence: 'WEEKLY', min: 5.5, max: 8.5 },
  { cadence: 'BIWEEKLY', min: 12, max: 16 },
  { cadence: 'MONTHLY', min: 26, max: 35 },
  { cadence: 'QUARTERLY', min: 80, max: 100 },
  { cadence: 'YEARLY', min: 330, max: 400 },
];

function cadenceOf(medianGapDays: number): RecurringCadence | null {
  const band = CADENCE_BANDS.find((b) => medianGapDays >= b.min && medianGapDays <= b.max);
  return band?.cadence ?? null;
}

/**
 * Detects merchants charged on a regular cadence with consistent amounts.
 * Only OUTFLOW transactions participate (transfers and income never do).
 * Returns one payload per recurring merchant, keyed by lowercased merchant.
 */
export function detectRecurringCharges(
  txns: TxnData[],
  options: RecurringOptions = DEFAULT_RECURRING_OPTIONS,
): Map<string, RecurringChargePayload> {
  const byMerchant = new Map<string, TxnData[]>();
  for (const t of txns) {
    if (t.flow !== 'OUTFLOW') continue;
    if (t.categoryName !== null && NOT_SUBSCRIPTION_CATEGORIES.has(t.categoryName)) continue;
    const merchant = t.normalizedMerchant.trim().toLowerCase();
    if (merchant === '') continue;
    const list = byMerchant.get(merchant) ?? [];
    list.push(t);
    byMerchant.set(merchant, list);
  }

  const result = new Map<string, RecurringChargePayload>();
  for (const [merchant, list] of byMerchant) {
    if (list.length < options.minOccurrences) continue;
    const sorted = [...list].sort((a, b) => a.date.getTime() - b.date.getTime());

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / DAY_MS);
    }
    const medianGap = median(gaps);
    const cadence = cadenceOf(medianGap);
    if (cadence === null) continue;

    const required = Math.ceil(options.matchRatio * gaps.length);
    const regularGaps = gaps.filter((g) => Math.abs(g - medianGap) <= medianGap * 0.45).length;
    if (regularGaps < required) continue;

    const amounts = sorted.map((t) => -t.amount);
    const medianAmount = median(amounts);
    if (medianAmount <= 0) continue;
    const consistent = amounts.filter(
      (a) => Math.abs(a - medianAmount) <= medianAmount * options.amountTolerance,
    ).length;
    if (consistent < Math.ceil(options.matchRatio * amounts.length)) continue;

    const last = sorted[sorted.length - 1];
    const lastAmount = -last.amount;
    const previousAverage = median(amounts.slice(0, -1));
    result.set(merchant, {
      merchant,
      cadence,
      averageAmount: round2(medianAmount),
      lastAmount: round2(lastAmount),
      lastDate: last.date.toISOString().slice(0, 10),
      occurrences: sorted.length,
      previousAverageAmount: round2(previousAverage),
      priceIncreased: lastAmount > previousAverage * (1 + options.priceIncreaseThreshold),
    });
  }
  return result;
}
