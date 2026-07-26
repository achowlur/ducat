import { describe, expect, it } from 'vitest';
import {
  annualisedTotal,
  isActive,
  mergeDetectedSubscriptions,
  type DetectedCharge,
} from './detectedSubscriptions';

const charge = (partial: Partial<DetectedCharge> & { merchant: string }): DetectedCharge => ({
  cadence: 'MONTHLY',
  averageAmount: 10,
  lastAmount: 10,
  lastDate: '2026-07-01',
  occurrences: 3,
  priceIncreased: false,
  ...partial,
});

describe('mergeDetectedSubscriptions', () => {
  // Real case: the live feed says "verizon", the bank CSV says
  // "verizon paymentrec urring <name>" — one subscription, three detections.
  it('folds the same subscription seen under different merchant strings', () => {
    const merged = mergeDetectedSubscriptions([
      charge({ merchant: 'verizon', averageAmount: 109.99, occurrences: 3 }),
      charge({ merchant: 'verizon paymentrec urring jane doe', averageAmount: 109.99, occurrences: 4 }),
      charge({ merchant: 'verizon paymentrec urring first name last name', averageAmount: 109.99, occurrences: 8 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].merchant).toBe('verizon'); // cleanest name
    expect(merged[0].occurrences).toBe(8); // fullest history
  });

  it('keeps different products from the same brand apart', () => {
    const merged = mergeDetectedSubscriptions([
      charge({ merchant: 'amazon prime', averageAmount: 14.99 }),
      charge({ merchant: 'amazon', averageAmount: 50 }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('never loses a price increase to the duplicate that won', () => {
    const merged = mergeDetectedSubscriptions([
      charge({ merchant: 'netflix', averageAmount: 18, priceIncreased: false }),
      charge({ merchant: 'netflix recurring pmt', averageAmount: 18, priceIncreased: true }),
    ]);
    expect(merged[0].priceIncreased).toBe(true);
  });

  it('surfaces price changes first, then the most expensive', () => {
    const merged = mergeDetectedSubscriptions([
      charge({ merchant: 'cheap', averageAmount: 5 }),
      charge({ merchant: 'costly', averageAmount: 90 }),
      charge({ merchant: 'raised', averageAmount: 20, priceIncreased: true }),
    ]);
    expect(merged.map((m) => m.merchant)).toEqual(['raised', 'costly', 'cheap']);
  });

  it('marks charges already covered by a registered subscription', () => {
    const merged = mergeDetectedSubscriptions([charge({ merchant: 'netflix' })], ['Netflix']);
    expect(merged[0].tracked).toBe(true);
  });
});

describe('annualisedTotal', () => {
  it('scales each cadence to a year', () => {
    const subs = mergeDetectedSubscriptions([
      charge({ merchant: 'monthly', averageAmount: 10 }),
      charge({ merchant: 'yearly', averageAmount: 120, cadence: 'YEARLY' }),
    ]);
    expect(annualisedTotal(subs)).toBe(240); // 10*12 + 120
  });
});

describe('isActive', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  it('keeps a subscription charged within the last couple of cycles', () => {
    expect(isActive(charge({ merchant: 'netflix', lastDate: '2026-07-01' }), now)).toBe(true);
  });

  // The recurring detector scans all history with no recency bound, so a
  // cancelled service kept billing in the annualised total forever.
  it('drops one cancelled years ago', () => {
    expect(isActive(charge({ merchant: 'netflix', lastDate: '2023-12-01' }), now)).toBe(false);
  });

  it('allows a yearly subscription its longer cycle', () => {
    expect(isActive(charge({ merchant: 'domain', cadence: 'YEARLY', lastDate: '2025-09-01' }), now)).toBe(true);
  });
});
