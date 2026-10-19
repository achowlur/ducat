import type { RecurringCadence } from '../../types/contracts';
import { longestGapDays, priceNow } from '../insights/recurring';
import { projectNextPayment } from './subscriptions';

/**
 * Turns detected recurring charges into a subscription list.
 *
 * The recurring analyzer keys on the normalized merchant, and the same
 * subscription reaches us under several of those: a live feed reports
 * "verizon" while a bank CSV reports "verizon paymentrec urring jane doe" —
 * the account holder's name, with the bank's own wrapping mangled into it.
 * Listing all three as separate subscriptions is worse than useless, so
 * charges that agree on the leading word, cadence, and rounded amount are
 * folded together under the shortest (cleanest) name.
 */
export interface DetectedCharge {
  merchant: string;
  cadence: RecurringCadence;
  averageAmount: number;
  lastAmount: number;
  /** Today's price run (RecurringChargePayload.currentAmount); absent on older rows. */
  currentAmount?: number;
  /** The price before today's (RecurringChargePayload.previousAverageAmount). */
  previousAverageAmount?: number | null;
  lastDate: string;
  occurrences: number;
  priceIncreased: boolean;
  /** How far the charging account's records reach (RecurringChargePayload). */
  accountThrough?: string;
}

export interface DetectedSubscription extends DetectedCharge {
  /** True when a registered TrackedSubscription already covers this merchant. */
  tracked: boolean;
  /** Every merchant string folded into this plan (lowercased); absent on a hand-built one. */
  members?: string[];
}

/**
 * Leading word is the brand; the rest is the bank's payment-reference noise.
 *
 * Deliberately NOT the way a hand-registered subscription is matched to a
 * charge — "Coursera" and "coursera.org" share no first word, so that job
 * belongs to `matchesSubscription` and its explicit merchantPattern.
 */
function brandOf(merchant: string): string {
  return merchant.trim().toLowerCase().split(/[\s*]+/)[0] ?? merchant;
}

function dedupeKey(c: DetectedCharge): string {
  // Amount is part of the key so "amazon" ($129.59 order) and "amazon prime"
  // ($38.85/mo) don't collapse into one subscription.
  return `${brandOf(c.merchant)}|${c.cadence}|${Math.round(c.averageAmount)}`;
}

/** Cycles of grace before a charge counts as lapsed (billing dates wander). */
const LAPSED_AFTER_CYCLES = 2;

const CADENCE_DAYS: Record<RecurringCadence, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 31,
  QUARTERLY: 92,
  YEARLY: 366,
};

/**
 * Whether a detected charge is still live. The recurring detector scans all
 * history and has no recency bound, so a subscription cancelled years ago is
 * still emitted every period — and `annualisedTotal` happily bills it forever
 * (Netflix cancelled in 2023 quietly adding $497.30/yr to "what my
 * subscriptions cost"). The payload's own lastDate settles it.
 */
export function isActive(charge: DetectedCharge, now: Date): boolean {
  const last = new Date(`${charge.lastDate}T12:00:00Z`).getTime();
  if (Number.isNaN(last)) return true; // undated: don't silently drop it
  const grace = CADENCE_DAYS[charge.cadence] * LAPSED_AFTER_CYCLES * 86_400_000;
  return now.getTime() - last <= grace;
}

/**
 * The billing date a still-listed charge MISSED, or null while none has.
 *
 * Lapsing waits two cycles because billing dates wander, which left a
 * cancelled monthly plan reading as live for two months: six weeks after its
 * last charge the page still listed it as recurring, counted it among the
 * next 30 days' charges and billed it in the yearly total. Missed
 * is the step between. It needs no tolerance of its own: the charge is missed
 * once it has been absent for longer than the detector's own longest gap for
 * the cadence (35 days for monthly).
 *
 * Judged against how far the charging ACCOUNT's records reach, never against
 * the clock alone. A card imported from statements, or a feed that stopped
 * syncing, simply has no rows yet past the date, and absence of a charge from
 * records that stop is not evidence it was missed. Rows generated before
 * `accountThrough` existed are never called missed.
 */
export function missedCharge(charge: DetectedCharge, asOf: Date): Date | null {
  if (charge.accountThrough === undefined) return null;
  const last = new Date(`${charge.lastDate}T12:00:00Z`);
  const through = new Date(`${charge.accountThrough}T12:00:00Z`);
  if (Number.isNaN(last.getTime()) || Number.isNaN(through.getTime())) return null;
  const seen = Math.min(through.getTime(), asOf.getTime());
  if (seen - last.getTime() <= longestGapDays(charge.cadence) * 86_400_000) return null;
  // The first billing date after the last charge, stepped from it with the
  // same calendar arithmetic renewals use (a charge on the 31st is due on the
  // 30th of a 30-day month, not on the 1st after it).
  return projectNextPayment(last, charge.cadence, null, last);
}

/**
 * A live plan's next charge, as the commitments window projects it: from its
 * last real charge, stepped past the start of today (so a date already gone
 * by is never offered), at the raised price when the last charge raised it.
 * The caller decides whether the plan is live: a lapsed or MISSED one has no
 * next charge to promise.
 */
export function nextChargeOf(charge: DetectedCharge, now: Date): { date: Date; daysAway: number; amount: number } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const date = projectNextPayment(new Date(`${charge.lastDate}T12:00:00Z`), charge.cadence, null, new Date(today - 1));
  const dueDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return {
    date,
    daysAway: Math.max(0, Math.round((dueDay - today) / 86_400_000)),
    amount: Math.round(priceNow(charge) * 100) / 100,
  };
}

export function mergeDetectedSubscriptions(
  detected: DetectedCharge[],
  trackedNames: string[] = [],
): DetectedSubscription[] {
  const tracked = trackedNames.map((n) => brandOf(n));
  const byKey = new Map<string, DetectedCharge>();

  for (const charge of detected) {
    const key = dedupeKey(charge);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, charge);
      continue;
    }
    // Keep the cleanest name but the fullest history, and never lose a price
    // increase because the duplicate that won happened not to show one.
    byKey.set(key, {
      ...existing,
      merchant: charge.merchant.length < existing.merchant.length ? charge.merchant : existing.merchant,
      occurrences: Math.max(existing.occurrences, charge.occurrences),
      priceIncreased: existing.priceIncreased || charge.priceIncreased,
      // The newest charge's account is where the next one is expected.
      ...(charge.lastDate > existing.lastDate
        ? {
            lastDate: charge.lastDate,
            accountThrough: charge.accountThrough,
            currentAmount: charge.currentAmount,
            previousAverageAmount: charge.previousAverageAmount,
          }
        : {}),
    });
  }

  // Every string a plan was folded from, so a decision about the plan reaches
  // each of them (ui/recurringDecisions.ts) and not only the surviving name.
  const membersByKey = new Map<string, string[]>();
  for (const charge of detected) {
    const key = dedupeKey(charge);
    membersByKey.set(key, [...(membersByKey.get(key) ?? []), charge.merchant.trim().toLowerCase()]);
  }

  return [...byKey.entries()]
    .map(([key, c]) => ({ ...c, tracked: tracked.includes(brandOf(c.merchant)), members: [...new Set(membersByKey.get(key))] }))
    // Price changes first — they're the reason to look — then by cost.
    .sort((a, b) =>
      Number(b.priceIncreased) - Number(a.priceIncreased) || b.averageAmount - a.averageAmount,
    );
}

/**
 * Annualised cost of everything detected, for the section header, at what
 * each plan bills NOW: the median of all its history kept a plan that rose a
 * year ago at its old price in the total until most of its charges were new.
 */
export function annualisedTotal(subs: DetectedSubscription[]): number {
  const perYear: Record<RecurringCadence, number> = {
    WEEKLY: 52,
    BIWEEKLY: 26,
    MONTHLY: 12,
    QUARTERLY: 4,
    YEARLY: 1,
  };
  return Math.round(subs.reduce((sum, s) => sum + priceNow(s) * perYear[s.cadence], 0) * 100) / 100;
}
