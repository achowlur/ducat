import type { AnomalyPayload, PeriodGranularity } from '../../types/contracts';
import { inPeriod, periodStart } from './periods';
import { reimbursementCredits } from './reimbursements';
import { fractionBelow, mad, median, robustZ, robustZFrom, round2, round4 } from './stats';
import type { TxnData } from './types';

export interface AnomalyOptions {
  /** Robust z-score at or above which a value is anomalous. */
  zThreshold: number;
  /** Minimum absolute amount — small blips are never worth an insight. */
  minAmount: number;
  /** Minimum historical data points before a comparison is meaningful. */
  minHistory: number;
  /**
   * Most transaction anomalies to report per baseline per period — one per
   * category, or per merchant for uncategorized rows.
   *
   * Without this the analyzer emitted every transaction over the threshold, and
   * on real data that meant six restaurant meals in a month: 44 of 51
   * transaction anomalies across 15 months were Dining. Simulating every
   * alternative statistic (higher z, p90, p95, absolute floors) left Dining at
   * 76-86% of output in ALL of them, because the composition is honest — 321 of
   * 470 outflows were Dining, so the most unusual outflows are mostly dinners.
   * The tighter thresholds only threw away the good findings: p95 dropped a
   * $1707.95 one-off purchase, and a $100 floor dropped both a $95 annual card fee
   * and a $186.6 advisory fee, the three most useful results in the whole set.
   *
   * So this is a ranking-and-cap problem, not a threshold one. `deviation`
   * decides which one survives; the threshold only decides eligibility.
   */
  maxPerBaseline: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  zThreshold: 3.5,
  minAmount: 50,
  minHistory: 5,
  maxPerBaseline: 1,
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

  // History is bucketed once rather than re-filtered per transaction. The
  // scan was O(transactions × outflows) and dominated a whole insight run:
  // at 10,000 transactions it cost 1.5s of a 1.6s total, ten times the four
  // other analyzers combined. Order within a bucket is irrelevant — median
  // and MAD sort — so the results are identical.
  const priorByCategory = new Map<string, number[]>();
  const priorByMerchant = new Map<string, number[]>();
  const push = (index: Map<string, number[]>, key: string, amount: number) => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [amount]);
    else bucket.push(amount);
  };
  for (const h of outflows) {
    if (h.date.getTime() >= start) continue;
    // A categorized transaction compares against its category; an
    // uncategorized one against its own merchant, whatever the category.
    if (h.categoryId !== null) push(priorByCategory, h.categoryId, -h.amount);
    push(priorByMerchant, h.normalizedMerchant.toLowerCase(), -h.amount);
  }

  // Every transaction in a category compares against the SAME history, and
  // median and MAD each sort it. Summarising a bucket once turns four sorts
  // per transaction into four per bucket.
  const summaries = new Map<string, { typical: number; spread: number }>();
  const summarise = (key: string, history: number[]) => {
    const cached = summaries.get(key);
    if (cached !== undefined) return cached;
    const computed = { typical: median(history), spread: mad(history) };
    summaries.set(key, computed);
    return computed;
  };

  // Keyed by baseline so the cap below can pick a winner per comparison group.
  const candidates = new Map<string, AnomalyPayload[]>();
  for (const t of outflows) {
    if (!inPeriod(t.date, period)) continue;
    const amount = -t.amount;
    if (amount < options.minAmount) continue;

    const key = t.categoryId !== null ? `c:${t.categoryId}` : `m:${t.normalizedMerchant.toLowerCase()}`;
    const history =
      t.categoryId !== null
        ? (priorByCategory.get(t.categoryId) ?? [])
        : (priorByMerchant.get(t.normalizedMerchant.toLowerCase()) ?? []);
    if (history.length < options.minHistory) continue;

    const { typical, spread } = summarise(key, history);
    const z = robustZFrom(amount, typical, spread);
    // A capped z from constant history still needs a real magnitude gap.
    if (z < options.zThreshold || amount < typical * 1.5) continue;

    const bucket = candidates.get(key) ?? [];
    bucket.push({
      kind: 'TRANSACTION',
      granularity,
      transactionId: t.id,
      categoryId: t.categoryId,
      categoryName: t.categoryName,
      description: t.normalizedMerchant !== '' ? t.normalizedMerchant : t.description,
      amount: round2(amount),
      typicalAmount: round2(typical),
      deviation: round2(z),
      percentileOfHistory: round4(fractionBelow(amount, history)),
    });
    candidates.set(key, bucket);
  }

  // Most unusual first, then the cap. Ties break on amount so the choice is
  // deterministic — a constant history caps every z at ROBUST_Z_CAP, which
  // would otherwise make "the most unusual Utilities bill" arbitrary.
  for (const bucket of candidates.values()) {
    bucket.sort((a, b) => b.deviation - a.deviation || b.amount - a.amount);
    anomalies.push(...bucket.slice(0, options.maxPerBaseline));
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

  // Subtract reimbursements the same way computeSpendingByCategory does.
  // Without this the two disagree on screen: front a $7,775.19 group trip, get
  // $6,220.15 back, and the donut says Travel $1555.04 while the signal beside it
  // shouts "Travel total $7,775.19 this month — vs $570.18 in a typical month".
  for (const credit of reimbursementCredits(txns)) {
    // Uncategorized credits have no category total to net against.
    if (credit.categoryId === null) continue;
    const entry = totals.get(credit.categoryId);
    if (entry === undefined) continue;
    for (const p of [period, ...priorPeriods]) {
      if (inPeriod(credit.date, p)) {
        entry.byPeriod.set(p, (entry.byPeriod.get(p) ?? 0) - credit.amount);
        break;
      }
    }
  }

  const anomalies: AnomalyPayload[] = [];
  for (const [categoryId, { name, byPeriod }] of totals) {
    const current = byPeriod.get(period) ?? 0;
    if (current < options.minAmount) continue;

    // Baseline only from periods where the category actually saw spending.
    // Counting empty periods as 0 makes the median 0 for anything that doesn't
    // appear in most months — including any category whose data starts partway
    // through history (a newly connected account, a CSV backfill that reaches
    // further for some accounts than others). Everything then reads as an
    // infinite anomaly "vs $0 in a typical month", and the most predictable
    // expense there is — rent — gets flagged every single month.
    const active = priorPeriods.map((p) => byPeriod.get(p) ?? 0).filter((v) => v > 0);
    if (active.length < options.minHistory - 1) continue;

    const z = robustZ(current, active);
    const typical = median(active);
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
      percentileOfHistory: round4(fractionBelow(current, active)),
    });
  }
  return anomalies;
}
