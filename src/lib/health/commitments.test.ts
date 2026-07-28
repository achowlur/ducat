import { describe, expect, it } from 'vitest';
import { upcomingCommitments } from './commitments';
import type { DetectedSubscription } from './detectedSubscriptions';
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

describe('upcomingCommitments', () => {
  const now = utc(2026, 7, 10);

  it('projects the next charge from the last real one', () => {
    const { items, total } = upcomingCommitments([sub({ lastDate: '2026-06-20' })], now);
    expect(items).toHaveLength(1);
    expect(iso(items[0].dueDate)).toBe('2026-07-20');
    expect(items[0].daysAway).toBe(10);
    expect(total).toBe(15.99);
  });

  it('excludes charges beyond the window', () => {
    // Yearly, last charged in March — the next is eight months out.
    const yearly = sub({ merchant: 'annual fee', cadence: 'YEARLY', lastDate: '2026-03-01' });
    expect(upcomingCommitments([yearly], now).items).toHaveLength(0);
    // …but a wide enough window finds it.
    expect(upcomingCommitments([yearly], now, 300).items).toHaveLength(1);
  });

  it('excludes a lapsed charge — a cancelled service is not a commitment', () => {
    // Monthly, last seen in January: well past the two-cycle grace.
    expect(upcomingCommitments([sub({ lastDate: '2026-01-05' })], now).items).toHaveLength(0);
  });

  it('projects the FOLLOWING cycle when one was missed, never a past date', () => {
    // Monthly, last charged 2026-06-05, so 2026-07-05 has already passed
    // unbilled. Still inside the lapse grace, so it stays a commitment — but
    // the date offered has to be one that is still ahead.
    const { items } = upcomingCommitments([sub({ lastDate: '2026-06-05' })], now);
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
    const { items, total } = upcomingCommitments([raised], now);
    expect(items[0].amount).toBe(19.99);
    expect(items[0].priceIncreased).toBe(true);
    expect(total).toBe(19.99);
  });

  it('clamps a 31st billing day into a short month instead of skipping it', () => {
    // The Date.UTC trap: Jan 31 + 1 month normalises to "Feb 31" → Mar 3,
    // skipping February. Billers clamp, so this must land on Feb 28.
    const { items } = upcomingCommitments(
      [sub({ lastDate: '2026-01-31' })],
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
      now,
    );
    expect(items.map((i) => i.merchant)).toEqual(['soon', 'middle', 'late']);
    expect(total).toBe(75);
  });

  it('returns an empty window rather than inventing something to say', () => {
    const empty = upcomingCommitments([], now);
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
  });

  it('survives an unparseable lastDate instead of emitting an Invalid Date', () => {
    expect(upcomingCommitments([sub({ lastDate: 'not-a-date' })], now).items).toHaveLength(0);
  });

  it('counts a charge due today as 0 days away, not negative', () => {
    const { items } = upcomingCommitments([sub({ lastDate: '2026-06-10' })], now);
    expect(iso(items[0].dueDate)).toBe('2026-07-10');
    expect(items[0].daysAway).toBe(0);
  });
});
