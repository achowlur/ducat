import type { RecurringCadence } from '../../types/contracts';
import { round2 } from '../insights/stats';
import { isActive, type DetectedSubscription } from './detectedSubscriptions';
import { projectNextPayment } from './subscriptions';

/**
 * What is already spoken for: the recurring charges due in the next N days.
 *
 * The one forward-looking number the app can state with almost no assumption —
 * the cadence and the amount are both observed, so this projects nothing about
 * behaviour, only that a biller which has charged monthly three times will
 * charge again. That is why it is the first projection built: it is where the
 * conventions for how a forecast is worded and when it refuses get set, and it
 * is the hardest one to get wrong.
 *
 * The date arithmetic is `projectNextPayment`, deliberately, because it already
 * carries two fixes this would otherwise have to rediscover: clamping to a
 * short month (`Date.UTC` normalises "Feb 31" into March) and stepping from the
 * ORIGIN so a clamp never walks the billing day backwards.
 */

export interface Commitment {
  merchant: string;
  cadence: RecurringCadence;
  /** What the next charge is expected to cost. */
  amount: number;
  /** Projected charge date, UTC-pinned like every other date in the app. */
  dueDate: Date;
  /** Whole days from `now`; 0 means today. */
  daysAway: number;
  /**
   * The last charge came in above the prior median, so `amount` is that new
   * price rather than the median — a raised price is what you will pay next.
   */
  priceIncreased: boolean;
}

export interface UpcomingCommitments {
  items: Commitment[];
  /** Sum of `amount` across `items`. */
  total: number;
  windowDays: number;
}

const DAY_MS = 86_400_000;

/** Midnight UTC, so "days away" counts calendar days rather than hours elapsed. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Charges expected within `windowDays`, soonest first.
 *
 * Takes MERGED subscriptions: the same service reaches the detector under
 * several merchant strings ("verizon" and "verizon paymentrec urring …"), and
 * billing the window three times for one phone plan would be worse than
 * useless. Lapsed charges are excluded on the same rule the rest of the app
 * uses — a service cancelled last year is not a commitment.
 */
export function upcomingCommitments(
  subscriptions: DetectedSubscription[],
  now: Date,
  windowDays = 30,
): UpcomingCommitments {
  const today = startOfUtcDay(now);
  const horizon = today.getTime() + windowDays * DAY_MS;

  const items: Commitment[] = [];
  for (const sub of subscriptions) {
    if (!isActive(sub, now)) continue;

    const last = new Date(`${sub.lastDate}T12:00:00Z`);
    if (Number.isNaN(last.getTime())) continue;

    // Anchored on the last real charge, stepped until it lands after the start
    // of today — so a cycle that was missed projects the FOLLOWING one rather
    // than a date already in the past.
    const dueDate = projectNextPayment(last, sub.cadence, null, new Date(today.getTime() - 1));
    if (dueDate.getTime() > horizon) continue;

    items.push({
      merchant: sub.merchant,
      cadence: sub.cadence,
      // A price rise is the one case where the median is the wrong predictor:
      // the next charge will be the new price, not the average of the old ones.
      amount: round2(sub.priceIncreased ? sub.lastAmount : sub.averageAmount),
      dueDate,
      daysAway: Math.max(0, Math.round((startOfUtcDay(dueDate).getTime() - today.getTime()) / DAY_MS)),
      priceIncreased: sub.priceIncreased,
    });
  }

  items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || b.amount - a.amount);
  return {
    items,
    total: round2(items.reduce((sum, i) => sum + i.amount, 0)),
    windowDays,
  };
}
