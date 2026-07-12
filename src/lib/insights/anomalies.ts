import type { AnomalyPayload, PeriodGranularity } from '../../types/contracts';
import { inPeriod, periodStart } from './periods';
import { median, robustZ, round2 } from './stats';
import type { TxnData } from './types';

export interface AnomalyOptions {
  /** Robust z-score at or above which a value is anomalous. */
  zThreshold: number;
  /** Minimum absolute amount — small blips are never worth an insight. */
  minAmount: number;
  /** Minimum historical data points before a comparison is meaningful. */
  minHistory: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  zThreshold: 3.5,
  minAmount: 50,
  minHistory: 5,
};

/**
 * Transaction-level anomalies for one period: each OUTFLOW in the period is
 * compared against the account-independent history (before the period start)
 * of its category — or its merchant when uncategorized. TRANSFERs excluded.
 */
export function detectTransactionAnomalies(
  txns: TxnData[],
  period: string,
  granularity: PeriodGranularity,
  options: AnomalyOptions = DEFAULT_ANOMALY_OPTIONS,
): AnomalyPayload[] {
  const start = periodStart(period).getTime();
  const outflows = txns.filter((t) => t.flow === 'OUTFLOW');
  const anomalies: AnomalyPayload[] = [];

  for (const t of outflows) {
    if (!inPeriod(t.date, period)) continue;
    const amount = -t.amount;
    if (amount < options.minAmount) continue;

    const history = outflows
      .filter((h) =>
        h.date.getTime() < start &&
        (t.categoryId !== null
          ? h.categoryId === t.categoryId
          : h.normalizedMerchant.toLowerCase() === t.normalizedMerchant.toLowerCase()),
      )
      .map((h) => -h.amount);
    if (history.length < options.minHistory) continue;

    const z = robustZ(amount, history);
    const typical = median(history);
    // A capped z from constant history still needs a real magnitude gap.
    if (z < options.zThreshold || amount < typical * 1.5) continue;

    anomalies.push({
      kind: 'TRANSACTION',
      granularity,
      transactionId: t.id,
      categoryId: t.categoryId,
      categoryName: t.categoryName,
      description: t.normalizedMerchant !== '' ? t.normalizedMerchant : t.description,
      amount: round2(amount),
      typicalAmount: round2(typical),
      deviation: round2(z),
    });
  }
  return anomalies;
}

/**
 * Category-total anomalies: a category's spending in the period compared
 * against that category's totals in every prior period.
 */
export function detectCategoryTotalAnomalies(
  txns: TxnData[],
  period: string,
  allPeriods: string[],
  granularity: PeriodGranularity,
  options: AnomalyOptions = DEFAULT_ANOMALY_OPTIONS,
): AnomalyPayload[] {
  const priorPeriods = allPeriods.filter(
    (p) => periodStart(p).getTime() < periodStart(period).getTime(),
  );
  if (priorPeriods.length < options.minHistory - 1) return [];

  const totals = new Map<string, { name: string | null; byPeriod: Map<string, number> }>();
  for (const t of txns) {
    if (t.flow !== 'OUTFLOW' || t.categoryId === null) continue;
    const entry = totals.get(t.categoryId) ?? { name: t.categoryName, byPeriod: new Map() };
    for (const p of [period, ...priorPeriods]) {
      if (inPeriod(t.date, p)) {
        entry.byPeriod.set(p, (entry.byPeriod.get(p) ?? 0) + -t.amount);
        break;
      }
    }
    totals.set(t.categoryId, entry);
  }

  const anomalies: AnomalyPayload[] = [];
  for (const [categoryId, { name, byPeriod }] of totals) {
    const current = byPeriod.get(period) ?? 0;
    if (current < options.minAmount) continue;
    // Prior periods with no spending in this category count as 0.
    const history = priorPeriods.map((p) => byPeriod.get(p) ?? 0);
    if (history.length < options.minHistory - 1) continue;

    const z = robustZ(current, history);
    const typical = median(history);
    if (z < options.zThreshold || current < typical * 1.5) continue;

    anomalies.push({
      kind: 'CATEGORY_TOTAL',
      granularity,
      transactionId: null,
      categoryId,
      categoryName: name,
      description: null,
      amount: round2(current),
      typicalAmount: round2(typical),
      deviation: round2(z),
    });
  }
  return anomalies;
}
