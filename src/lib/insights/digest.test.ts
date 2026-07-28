import { describe, expect, it } from 'vitest';
import { computeDigest } from './digest';
import type {
  AnomalyPayload,
  RecurringChargePayload,
  SpendingByCategoryPayload,
} from '../../types/contracts';

function spending(cats: { name: string; spending: number }[]): SpendingByCategoryPayload {
  return {
    granularity: 'MONTH',
    totalSpending: cats.reduce((s, c) => s + c.spending, 0),
    previousTotalSpending: null,
    categories: cats.map((c) => ({
      categoryId: `cat-${c.name.toLowerCase()}`,
      categoryName: c.name,
      spending: c.spending,
      previousSpending: null,
      deltaPct: null,
    })),
  };
}

function recurring(p: Partial<RecurringChargePayload> & { merchant: string }): RecurringChargePayload {
  return {
    merchant: p.merchant,
    cadence: p.cadence ?? 'MONTHLY',
    averageAmount: p.averageAmount ?? 10,
    lastAmount: p.lastAmount ?? 10,
    lastDate: p.lastDate ?? '2026-07-01',
    occurrences: p.occurrences ?? 12,
    previousAverageAmount: p.previousAverageAmount ?? 10,
    priceIncreased: p.priceIncreased ?? false,
  };
}

function anomaly(p: Partial<AnomalyPayload> & { amount: number }): AnomalyPayload {
  return {
    kind: p.kind ?? 'TRANSACTION',
    granularity: 'MONTH',
    transactionId: 't1',
    categoryId: 'cat-dining',
    categoryName: p.categoryName ?? 'Dining',
    description: p.description ?? 'Fawn Den',
    amount: p.amount,
    typicalAmount: p.typicalAmount ?? 25,
    deviation: 4,
    percentileOfHistory: 0.98,
  };
}

const base = { spending: null, priorSpending: [], recurring: [], anomalies: [], minOccurrences: 3 };

describe('computeDigest', () => {
  it('ranks a recurring drift above a bigger one-off, because one repeats', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Dining', spending: 700 }]),
      priorSpending: [
        spending([{ name: 'Dining', spending: 480 }]),
        spending([{ name: 'Dining', spending: 480 }]),
      ],
      // A $1707.95 one-off is larger this month than the $570.18 drift…
      anomalies: [anomaly({ amount: 659 })],
    });
    // …but the drift is $6,842.17/yr if it holds, and the one-off is $1707.95, once.
    expect(items.map((i) => i.kind)).toEqual(['CATEGORY_DRIFT', 'ONE_OFF']);
    expect(items[0].stake).toBe(2640);
    expect(items[1].stake).toBe(659);
  });

  it('measures a category against the MEDIAN of its comparable periods', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Dining', spending: 700 }]),
      priorSpending: [
        spending([{ name: 'Dining', spending: 400 }]),
        spending([{ name: 'Dining', spending: 500 }]),
        spending([{ name: 'Dining', spending: 900 }]), // one loud month
      ],
      // Median 500, not the 600 mean — one loud month must not set the bar.
    });
    expect(items[0].baseline).toBe(500);
    expect(items[0].stake).toBe(2400);
  });

  it('needs enough prior periods before it will call something a drift', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Dining', spending: 700 }]),
      priorSpending: [spending([{ name: 'Dining', spending: 100 }])],
    });
    expect(items).toEqual([]);
  });

  it('ignores periods where the category had no spending, not counting them as zero', () => {
    // Counting empties as $0 is what made every ordinary month look infinite
    // in the anomaly pass; the same trap applies to a baseline median.
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Travel', spending: 900 }]),
      priorSpending: [
        spending([{ name: 'Travel', spending: 800 }]),
        spending([{ name: 'Travel', spending: 0 }]),
        spending([{ name: 'Travel', spending: 800 }]),
      ],
    });
    expect(items[0].baseline).toBe(800);
  });

  it('leaves a category that fell out — good news does not need attention', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Dining', spending: 200 }]),
      priorSpending: [
        spending([{ name: 'Dining', spending: 600 }]),
        spending([{ name: 'Dining', spending: 600 }]),
      ],
    });
    expect(items).toEqual([]);
  });

  it('annualises a price rise by its own cadence, not by the month', () => {
    const items = computeDigest({
      ...base,
      recurring: [
        recurring({
          merchant: 'insurance',
          cadence: 'QUARTERLY',
          lastAmount: 340,
          previousAverageAmount: 300,
          priceIncreased: true,
        }),
      ],
    });
    expect(items[0].kind).toBe('PRICE_RISE');
    expect(items[0].stake).toBe(160); // $40 x 4 quarters
  });

  it('surfaces a newly recognised commitment at its whole annual cost', () => {
    const items = computeDigest({
      ...base,
      recurring: [recurring({ merchant: 'coursera.org', averageAmount: 49, occurrences: 3 })],
    });
    expect(items[0].kind).toBe('NEW_COMMITMENT');
    expect(items[0].stake).toBe(588);
  });

  it('does not re-announce a commitment it has known about for a year', () => {
    const items = computeDigest({
      ...base,
      recurring: [recurring({ merchant: 'netflix', averageAmount: 49, occurrences: 14 })],
    });
    expect(items).toEqual([]);
  });

  it('drops findings too small to change a decision', () => {
    const items = computeDigest({
      ...base,
      recurring: [
        recurring({
          merchant: 'tiny',
          lastAmount: 10.2,
          previousAverageAmount: 10,
          priceIncreased: true,
        }),
      ],
    });
    expect(items).toEqual([]); // $0.20 x 12 = $2.40/yr
  });

  it('keeps a $95 annual fee, which an absolute $100 floor would have discarded', () => {
    const items = computeDigest({
      ...base,
      recurring: [
        recurring({ merchant: 'annual membership fee', cadence: 'YEARLY', averageAmount: 95, occurrences: 3 }),
      ],
    });
    expect(items[0].stake).toBe(95);
  });

  it('caps the list, however much qualifies', () => {
    const items = computeDigest({
      ...base,
      anomalies: [1000, 900, 800, 700, 600, 500].map((amount) => anomaly({ amount })),
    });
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.amount)).toEqual([1000, 900, 800, 700]);
  });

  it('leaves CATEGORY_TOTAL anomalies to the drift rule rather than double-counting', () => {
    const items = computeDigest({
      ...base,
      anomalies: [anomaly({ kind: 'CATEGORY_TOTAL', amount: 5000 })],
    });
    expect(items).toEqual([]);
  });

  it('says nothing when nothing qualifies', () => {
    expect(computeDigest(base)).toEqual([]);
  });
});
