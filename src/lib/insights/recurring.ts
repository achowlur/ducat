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
