import { describe, expect, it } from 'vitest';
import { anomalyDedupeKey, computeDigest } from './digest';
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
    // These three were hardcoded and silently ignored an override, which is
    // fine until a test needs to vary the identity or the rank.
    transactionId: p.transactionId ?? 't1',
    categoryId: p.categoryId ?? 'cat-dining',
    categoryName: p.categoryName ?? 'Dining',
    description: p.description ?? 'Fawn Den',
    amount: p.amount,
    typicalAmount: p.typicalAmount ?? 25,
    deviation: 4,
    percentileOfHistory: p.percentileOfHistory ?? 0.98,
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
      // (in ANOTHER category: a one-off inside Dining would explain Dining's
      // rise, and is then not a drift at all — see the block below)
      anomalies: [anomaly({ amount: 659, categoryId: 'cat-travel', categoryName: 'Travel' })],
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

describe('dedupeKey — what the streams below must not print twice', () => {
  /**
   * The digest and the anomaly stream read the SAME rows, so a promoted
   * finding appeared twice ~400px apart. The key is how the page matches one
   * against the other; both sides compute it through `anomalyDedupeKey`, so
   * these assertions are what stops the two drifting.
   */
  it('keys a promoted one-off to the transaction it came from', () => {
    const [item] = computeDigest({
      ...base,
      anomalies: [anomaly({ amount: 659.24, transactionId: 'txn-abc' })],
    });
    expect(item.kind).toBe('ONE_OFF');
    expect(item.dedupeKey).toBe('txn:txn-abc');
    expect(anomalyDedupeKey(anomaly({ amount: 1, transactionId: 'txn-abc' }))).toBe('txn:txn-abc');
  });

  it('keys a category drift to the category, matching a CATEGORY_TOTAL anomaly', () => {
    const [item] = computeDigest({
      ...base,
      spending: spending([{ name: 'Groceries', spending: 173.2 }]),
      priorSpending: [
        spending([{ name: 'Groceries', spending: 30 }]),
        spending([{ name: 'Groceries', spending: 40 }]),
      ],
    });
    expect(item.kind).toBe('CATEGORY_DRIFT');
    expect(item.dedupeKey).toBe('cat:cat-groceries');
    // The July contradiction: one category, two medians, 263px apart. The
    // anomaly row must resolve to the same key so it can be suppressed.
    expect(
      anomalyDedupeKey({
        kind: 'CATEGORY_TOTAL',
        transactionId: null,
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
      }),
    ).toBe('cat:cat-groceries');
  });

  /**
   * An uncategorized anomaly has no categoryId, so the key falls back to the
   * name — the same fallback the digest's own `keyOf` uses. If these two
   * disagreed, an uncategorized finding would print twice forever.
   */
  it('falls back to the name when a category has no id, on both sides', () => {
    const [item] = computeDigest({
      ...base,
      spending: { ...spending([]), categories: [{ categoryId: null, categoryName: null, spending: 200, previousSpending: null, deltaPct: null }] },
      priorSpending: [
        { ...spending([]), categories: [{ categoryId: null, categoryName: null, spending: 20, previousSpending: null, deltaPct: null }] },
        { ...spending([]), categories: [{ categoryId: null, categoryName: null, spending: 30, previousSpending: null, deltaPct: null }] },
      ],
    });
    expect(item.dedupeKey).toBe('cat:name:uncategorized');
    expect(
      anomalyDedupeKey({ kind: 'CATEGORY_TOTAL', transactionId: null, categoryId: null, categoryName: null }),
    ).toBe('cat:name:uncategorized');
  });

  /**
   * A price rise and a new commitment come from the recurring stream, which is
   * a separate question — suppressing rows there is not part of this fix, so
   * they must carry no key at all rather than a key that matches nothing.
   */
  it('gives recurring-sourced items no key', () => {
    const items = computeDigest({
      ...base,
      recurring: [recurring({ merchant: 'verizon', lastAmount: 40, previousAverageAmount: 20, priceIncreased: true })],
    });
    expect(items).not.toHaveLength(0);
    for (const i of items) expect(i.dedupeKey).toBeNull();
  });

  /**
   * The rank is the anomaly stream's whole contribution, and the promoted row
   * replaces that stream's row — so it has to travel with the item or the
   * page loses "higher than N%" entirely.
   */
  it('carries the rank forward so promotion drops nothing', () => {
    const [item] = computeDigest({
      ...base,
      anomalies: [anomaly({ amount: 659.24, categoryName: 'Shopping', percentileOfHistory: 0.9 })],
    });
    expect(item.rank).toEqual({ percentileOfHistory: 0.9, of: 'your Shopping' });
  });

  /**
   * An item the digest DROPS — below the stake floor, or past the four-item
   * cap — was never promoted, so its row must survive in the stream below.
   * The suppression keys off the RETURNED list for exactly this reason.
   */
  it('does not key an anomaly that never made the cut', () => {
    const items = computeDigest({
      ...base,
      anomalies: [anomaly({ amount: 12, transactionId: 'txn-small' })],
    });
    expect(items.map((i) => i.dedupeKey)).not.toContain('txn:txn-small');
  });
});

describe('computeDigest and P2P awaiting confirmation', () => {
  it('never reports the review backlog as a spending drift', () => {
    const p2p = (amount: number): SpendingByCategoryPayload => ({
      ...spending([]),
      totalSpending: amount,
      categories: [
        { categoryId: 'p2p-unreviewed', categoryName: 'P2P — Unreviewed', spending: amount, previousSpending: null, deltaPct: null },
      ],
    });
    const items = computeDigest({ ...base, spending: p2p(900), priorSpending: [p2p(100), p2p(120)] });
    expect(items).toEqual([]);
  });
});

describe('computeDigest and a one-off inside its own category', () => {
  const prior = [spending([{ name: 'Shopping', spending: 100 }]), spending([{ name: 'Shopping', spending: 110 }])];

  it('does not also report the purchase as its category trending up', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Shopping', spending: 1330 }]),
      priorSpending: prior,
      anomalies: [anomaly({ amount: 1249, categoryId: 'cat-shopping', categoryName: 'Shopping', transactionId: 't-laptop' })],
    });
    // Without the one-off, Shopping is $81 — below its $105 median, so no drift.
    expect(items.map((i) => i.kind)).toEqual(['ONE_OFF']);
  });

  it('still reports drift beyond the one-off, scored only on the part that could repeat', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Shopping', spending: 1649 }]),
      priorSpending: prior,
      anomalies: [anomaly({ amount: 1249, categoryId: 'cat-shopping', categoryName: 'Shopping', transactionId: 't-laptop' })],
    });
    const drift = items.find((i) => i.kind === 'CATEGORY_DRIFT');
    // $1,649 − $1,249 one-off = $400 against a $105 median: $295/mo, $3,540/yr.
    expect(drift?.stake).toBe(3540);
    expect(items.map((i) => i.kind)).toEqual(['CATEGORY_DRIFT', 'ONE_OFF']);
  });

  it('leaves drift in OTHER categories exactly as it was', () => {
    const items = computeDigest({
      ...base,
      spending: spending([{ name: 'Dining', spending: 700 }, { name: 'Shopping', spending: 1330 }]),
      priorSpending: [
        spending([{ name: 'Dining', spending: 480 }, { name: 'Shopping', spending: 100 }]),
        spending([{ name: 'Dining', spending: 480 }, { name: 'Shopping', spending: 110 }]),
      ],
      anomalies: [anomaly({ amount: 1249, categoryId: 'cat-shopping', categoryName: 'Shopping', transactionId: 't-laptop' })],
    });
    expect(items.find((i) => i.kind === 'CATEGORY_DRIFT')).toMatchObject({ subject: 'Dining', stake: 2640 });
  });
});
