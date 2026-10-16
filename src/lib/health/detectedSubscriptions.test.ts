import { describe, expect, it } from 'vitest';
import {
  annualisedTotal,
  isActive,
  mergeDetectedSubscriptions,
  missedCharge,
  nextChargeOf,
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

  it("keeps the NEWEST charge's account coverage, where the next charge is expected", () => {
    const newer = charge({ merchant: 'verizon', lastDate: '2026-07-01', accountThrough: '2026-07-20' });
    const older = charge({ merchant: 'verizon paymentrec urring', lastDate: '2026-05-01', accountThrough: '2026-05-30' });
    for (const order of [[newer, older], [older, newer]]) {
      const [merged] = mergeDetectedSubscriptions(order);
      expect(merged).toMatchObject({ lastDate: '2026-07-01', accountThrough: '2026-07-20' });
    }
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

describe('missedCharge', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  const iso = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));

  it('names the billing date that passed once the account kept recording past it', () => {
    const missed = missedCharge(charge({ merchant: 'gym', lastDate: '2026-06-01', accountThrough: '2026-07-20' }), now);
    expect(iso(missed)).toBe('2026-07-01');
  });

  it("allows the detector's own longest monthly gap (35 days) before calling it missed", () => {
    expect(missedCharge(charge({ merchant: 'gym', lastDate: '2026-06-01', accountThrough: '2026-07-06' }), now)).toBeNull();
    expect(iso(missedCharge(charge({ merchant: 'gym', lastDate: '2026-06-01', accountThrough: '2026-07-07' }), now))).toBe('2026-07-01');
  });

  // A statement-imported card, or a feed that stopped syncing, has no rows past
  // the date yet. No charge in records that stop is not a missed charge.
  it('says nothing when the account records stop before the date could be judged', () => {
    expect(missedCharge(charge({ merchant: 'gym', lastDate: '2026-06-01', accountThrough: '2026-06-28' }), now)).toBeNull();
  });

  it('says nothing for a row generated before account coverage was recorded', () => {
    expect(missedCharge(charge({ merchant: 'gym', lastDate: '2026-01-01' }), now)).toBeNull();
  });

  it('judges a past month by its own end, not by records that came later', () => {
    const asOf = new Date('2026-06-30T23:59:59Z');
    expect(missedCharge(charge({ merchant: 'gym', lastDate: '2026-06-01', accountThrough: '2026-07-20' }), asOf)).toBeNull();
  });

  it('clamps a 31st billing day into a short month', () => {
    const missed = missedCharge(charge({ merchant: 'gym', lastDate: '2026-01-31', accountThrough: '2026-03-20' }), now);
    expect(iso(missed)).toBe('2026-02-28');
  });

  it('gives a yearly plan its longer tolerance', () => {
    const domain = (accountThrough: string) =>
      charge({ merchant: 'domain', cadence: 'YEARLY', lastDate: '2025-06-10', accountThrough });
    expect(missedCharge(domain('2026-07-14'), now)).toBeNull(); // 399 days
    expect(iso(missedCharge(domain('2026-07-16'), now))).toBe('2026-06-10');
  });
});

describe('nextChargeOf', () => {
  const now = new Date('2026-07-10T15:00:00Z');
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it('projects from the last real charge, in whole days from today', () => {
    const next = nextChargeOf(charge({ merchant: 'gym', lastDate: '2026-06-20', averageAmount: 29 }), now);
    expect(iso(next.date)).toBe('2026-07-20');
    expect(next.daysAway).toBe(10);
    expect(next.amount).toBe(29);
  });

  it('quotes the raised price, which is what the next charge costs', () => {
    const raised = charge({ merchant: 'gym', lastDate: '2026-06-20', averageAmount: 29, lastAmount: 34, priceIncreased: true });
    expect(nextChargeOf(raised, now).amount).toBe(34);
  });

  it('never offers a date already gone by, and clamps a 31st into a short month', () => {
    expect(iso(nextChargeOf(charge({ merchant: 'gym', lastDate: '2026-06-05' }), now).date)).toBe('2026-08-05');
    expect(iso(nextChargeOf(charge({ merchant: 'gym', lastDate: '2026-01-31' }), new Date('2026-02-10T12:00:00Z')).date)).toBe('2026-02-28');
  });
});
