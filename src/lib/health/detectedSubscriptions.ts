import type { RecurringCadence } from '../../types/contracts';

/**
 * Turns detected recurring charges into a subscription list.
 *
 * The recurring analyzer keys on the normalized merchant, and the same
 * subscription reaches us under several of those: a live feed reports
 * "verizon" while a bank CSV reports "verizon paymentrec urring marlowe
 * brennan". Listing all three as separate subscriptions is worse than useless,
 * so charges that agree on the leading word, cadence, and rounded amount are
 * folded together under the shortest (cleanest) name.
 */
export interface DetectedCharge {
  merchant: string;
  cadence: RecurringCadence;
  averageAmount: number;
  lastAmount: number;
  lastDate: string;
  occurrences: number;
  priceIncreased: boolean;
}

export interface DetectedSubscription extends DetectedCharge {
  /** True when a registered TrackedSubscription already covers this merchant. */
  tracked: boolean;
}

/** Leading word is the brand; the rest is the bank's payment-reference noise. */
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
      lastDate: charge.lastDate > existing.lastDate ? charge.lastDate : existing.lastDate,
    });
  }

  return [...byKey.values()]
    .map((c) => ({ ...c, tracked: tracked.includes(brandOf(c.merchant)) }))
    // Price changes first — they're the reason to look — then by cost.
    .sort((a, b) =>
      Number(b.priceIncreased) - Number(a.priceIncreased) || b.averageAmount - a.averageAmount,
    );
}

/** Annualised cost of everything detected, for the section header. */
export function annualisedTotal(subs: DetectedSubscription[]): number {
  const perYear: Record<RecurringCadence, number> = {
    WEEKLY: 52,
    BIWEEKLY: 26,
    MONTHLY: 12,
    QUARTERLY: 4,
    YEARLY: 1,
  };
  return Math.round(subs.reduce((sum, s) => sum + s.averageAmount * perYear[s.cadence], 0) * 100) / 100;
}
