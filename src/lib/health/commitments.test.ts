import { describe, expect, it } from 'vitest';
import { upcomingCommitments } from './commitments';
import type { DetectedSubscription } from './detectedSubscriptions';
import type { SubscriptionStatus } from './types';
import type { RecurringCadence } from '../../types/contracts';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
const iso = (d: Date) => d.toISOString().slice(0, 10);

function sub(partial: Partial<DetectedSubscription> & { lastDate: string }): DetectedSubscription {
  return {
    merchant: partial.merchant ?? 'netflix',
    cadence: (partial.cadence ?? 'MONTHLY') as RecurringCadence,
    averageAmount: partial.averageAmount ?? 15.99,
    lastAmount: partial.lastAmount ?? 15.99,
    occurrences: partial.occurrences ?? 4,
    priceIncreased: partial.priceIncreased ?? false,
    tracked: partial.tracked ?? false,
    ...partial,
  };
}

function registered(partial: Partial<SubscriptionStatus> & { nextPaymentDate: Date }): SubscriptionStatus {
  return {
    id: partial.id ?? 'sub-1',
    name: partial.name ?? 'link.com',
    merchantPattern: partial.merchantPattern ?? partial.name ?? 'link.com',
    enabled: partial.enabled ?? true,
    expectedAmount: partial.expectedAmount ?? 1.5,
    cadence: (partial.cadence ?? 'MONTHLY') as RecurringCadence,
    daysUntilNextPayment: partial.daysUntilNextPayment ?? 0,
    lastCharge: partial.lastCharge ?? null,
    priceDrift: partial.priceDrift ?? null,
    ...partial,
  };
}

describe('upcomingCommitments', () => {
  const now = utc(2026, 7, 10);

  it('projects the next charge from the last real one', () => {
    const { items, total } = upcomingCommitments([sub({ lastDate: '2026-06-20' })], [], now);
    expect(items).toHaveLength(1);
    expect(iso(items[0].dueDate)).toBe('2026-07-20');
    expect(items[0].daysAway).toBe(10);
    expect(total).toBe(15.99);
  });

  it('excludes charges beyond the window', () => {
    // Yearly, last charged in March — the next is eight months out.
    const yearly = sub({ merchant: 'annual fee', cadence: 'YEARLY', lastDate: '2026-03-01' });
    expect(upcomingCommitments([yearly], [], now).items).toHaveLength(0);
    // …but a wide enough window finds it.
    expect(upcomingCommitments([yearly], [], now, 300).items).toHaveLength(1);
  });

  it('excludes a lapsed charge — a cancelled service is not a commitment', () => {
    // Monthly, last seen in January: well past the two-cycle grace.
    expect(upcomingCommitments([sub({ lastDate: '2026-01-05' })], [], now).items).toHaveLength(0);
  });

  it('projects the FOLLOWING cycle when one was missed, never a past date', () => {
    // Monthly, last charged 2026-06-05, so 2026-07-05 has already passed
    // unbilled. Still inside the lapse grace, so it stays a commitment — but
    // the date offered has to be one that is still ahead.
    const { items } = upcomingCommitments([sub({ lastDate: '2026-06-05' })], [], now);
    expect(items).toHaveLength(1);
    expect(items[0].dueDate.getTime()).toBeGreaterThanOrEqual(utc(2026, 7, 10).getTime() - 86_400_000);
    expect(iso(items[0].dueDate)).toBe('2026-08-05');
  });

  it('quotes the RAISED price, since that is what the next charge costs', () => {
    const raised = sub({
      lastDate: '2026-06-20',
      averageAmount: 15.99,
      lastAmount: 19.99,
      priceIncreased: true,
    });
    const { items, total } = upcomingCommitments([raised], [], now);
    expect(items[0].amount).toBe(19.99);
    expect(items[0].priceIncreased).toBe(true);
    expect(total).toBe(19.99);
  });

  it('clamps a 31st billing day into a short month instead of skipping it', () => {
    // The Date.UTC trap: Jan 31 + 1 month normalises to "Feb 31" → Mar 3,
    // skipping February. Billers clamp, so this must land on Feb 28.
    const { items } = upcomingCommitments(
      [sub({ lastDate: '2026-01-31' })],
      [],
      utc(2026, 2, 1),
    );
    expect(iso(items[0].dueDate)).toBe('2026-02-28');
  });

  it('sorts soonest first and totals the window', () => {
    const { items, total } = upcomingCommitments(
      [
        sub({ merchant: 'late', lastDate: '2026-06-28', averageAmount: 10 }),
        sub({ merchant: 'soon', lastDate: '2026-06-12', averageAmount: 40 }),
        sub({ merchant: 'middle', lastDate: '2026-06-18', averageAmount: 25 }),
      ],
      [],
      now,
    );
    expect(items.map((i) => i.merchant)).toEqual(['soon', 'middle', 'late']);
    expect(total).toBe(75);
  });

  it('returns an empty window rather than inventing something to say', () => {
    const empty = upcomingCommitments([], [], now);
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
  });

  it('survives an unparseable lastDate instead of emitting an Invalid Date', () => {
    expect(upcomingCommitments([sub({ lastDate: 'not-a-date' })], [], now).items).toHaveLength(0);
  });

  it('counts a charge due today as 0 days away, not negative', () => {
    const { items } = upcomingCommitments([sub({ lastDate: '2026-06-10' })], [], now);
    expect(iso(items[0].dueDate)).toBe('2026-07-10');
    expect(items[0].daysAway).toBe(0);
  });

  // A subscription can be REGISTERED by hand and never detected — too few
  // charges, or a descriptor that shifts every month. Real instance: link.com
  // at $3.89/mo was registered and undetected, and narrowing Overview to state
  // made it committed money that appeared nowhere in the app.
  describe('registered subscriptions', () => {
    it('includes one the detector has never seen', () => {
      const { items, total } = upcomingCommitments(
        [],
        [registered({ nextPaymentDate: utc(2026, 7, 25) })],
        now,
      );
      expect(items).toHaveLength(1);
      expect(items[0].merchant).toBe('link.com');
      expect(items[0].source).toBe('REGISTERED');
      expect(items[0].daysAway).toBe(15);
      expect(total).toBe(1.5);
    });

    it('does not double-count one the detector already found', () => {
      // Declared "Coursera" by hand; the bank writes "coursera.org". No
      // first-word fold relates those, which is why the merchantPattern is what
      // decides — and the OBSERVED charge is the one that survives.
      const { items, total } = upcomingCommitments(
        [sub({ merchant: 'coursera.org', averageAmount: 49, lastDate: '2026-07-01' })],
        [
          registered({
            name: 'Coursera',
            merchantPattern: 'coursera',
            expectedAmount: 40,
            nextPaymentDate: utc(2026, 8, 1),
          }),
        ],
        now,
      );
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('DETECTED');
      expect(total).toBe(49);
    });

    it('excludes a disabled one', () => {
      const off = registered({ enabled: false, nextPaymentDate: utc(2026, 7, 25) });
      expect(upcomingCommitments([], [off], now).items).toHaveLength(0);
    });

    it('excludes one due beyond the window', () => {
      const far = registered({ nextPaymentDate: utc(2026, 9, 25) });
      expect(upcomingCommitments([], [far], now).items).toHaveLength(0);
      expect(upcomingCommitments([], [far], now, 120).items).toHaveLength(1);
    });

    it('quotes the drifted price, not the one on file', () => {
      const { items } = upcomingCommitments(
        [],
        [
          registered({
            expectedAmount: 1.5,
            nextPaymentDate: utc(2026, 7, 25),
            priceDrift: { expected: 1.5, actual: 2.5, deltaPct: 0.6667 },
          }),
        ],
        now,
      );
      expect(items[0].amount).toBe(2.5);
      expect(items[0].priceIncreased).toBe(true);
    });

    it('keeps the price on file when the drift was a DISCOUNT', () => {
      // A one-off cheaper charge does not mean the next one is cheaper.
      const { items } = upcomingCommitments(
        [],
        [
          registered({
            expectedAmount: 1.5,
            nextPaymentDate: utc(2026, 7, 25),
            priceDrift: { expected: 1.5, actual: 0.5, deltaPct: -0.6667 },
          }),
        ],
        now,
      );
      expect(items[0].amount).toBe(1.5);
      expect(items[0].priceIncreased).toBe(false);
    });

    it('sorts into the same date order as detected ones', () => {
      const { items, total } = upcomingCommitments(
        [sub({ merchant: 'verizon', averageAmount: 109.99, lastDate: '2026-06-20' })],
        [registered({ name: 'link.com', nextPaymentDate: utc(2026, 7, 12) })],
        now,
      );
      expect(items.map((i) => i.merchant)).toEqual(['link.com', 'verizon']);
      expect(total).toBe(111.49);
    });
  });
});
