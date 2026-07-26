import type { RecurringCadence } from '../../types/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { round2, round4 } from '../insights/stats';
import type { SubscriptionCharge, SubscriptionStatus } from './types';

const DAY_MS = 86_400_000;

/**
 * Adds months without overflowing past the end of a short month. Date.UTC
 * NORMALISES an impossible day instead of clamping, so a sub billed on the
 * 31st stepped Jan 31 -> "Feb 31" -> Mar 3: February skipped entirely, and the
 * anchor drifts a few days further every cycle. Billers clamp to the last day
 * of the month, so we do too.
 */
function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDayOfTarget), 12));
}

/** `cycles` counts from the origin so clamping never accumulates. */
function stepForward(date: Date, cadence: RecurringCadence, cycles = 1): Date {
  switch (cadence) {
    case 'WEEKLY':
      return new Date(date.getTime() + cycles * 7 * DAY_MS);
    case 'BIWEEKLY':
      return new Date(date.getTime() + cycles * 14 * DAY_MS);
    case 'MONTHLY':
      return addMonths(date, cycles);
    case 'QUARTERLY':
      return addMonths(date, 3 * cycles);
    case 'YEARLY':
      return addMonths(date, 12 * cycles);
  }
}

/**
 * Projects the next billing date: start from the most recent real charge
 * when one exists (the provider's actual cycle beats the registered
 * anchor), otherwise the anchor, and step by cadence until after `now`.
 */
export function projectNextPayment(
  anchor: Date,
  cadence: RecurringCadence,
  lastChargeDate: Date | null,
  now: Date,
): Date {
  const origin = lastChargeDate ?? anchor;
  // Step from the ORIGIN each time, never from the previously stepped date.
  // Iterating on the result lets a clamp stick: Jan 31 clamps to Feb 28, and
  // stepping from *that* gives Mar 28 — the billing day silently walks
  // backwards. A biller charges Feb 28 and then Mar 31 again.
  let cycles = 0;
  let next = origin;
  while (next.getTime() <= now.getTime()) {
    cycles += 1;
    next = stepForward(origin, cadence, cycles);
    if (cycles > 5000) throw new Error('projectNextPayment runaway');
  }
  return next;
}

interface TrackedSubLite {
  id: string;
  name: string;
  merchantPattern: string;
  expectedAmount: number;
  cadence: RecurringCadence;
  anchorDate: Date;
  enabled: boolean;
}

interface ChargeTxnLite {
  id: string;
  date: Date;
  amount: number; // signed
  normalizedMerchant: string;
  description: string;
}

/** Pure reconciliation of one subscription against candidate transactions. */
export function reconcileSubscription(
  sub: TrackedSubLite,
  txns: ChargeTxnLite[],
  now: Date,
): SubscriptionStatus {
  const pattern = sub.merchantPattern.toLowerCase();
  const charges: SubscriptionCharge[] = txns
    .filter(
      (t) =>
        t.amount < 0 &&
        (t.normalizedMerchant.toLowerCase().includes(pattern) ||
          t.description.toLowerCase().includes(pattern)),
    )
    .map((t) => ({ transactionId: t.id, date: t.date, amount: round2(-t.amount) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // Merchant matching is a substring, so a $647.93 monitor from Amazon matches a
  // tracked "Amazon Prime" just as well as the $38.85 renewal does. Taking the
  // newest match as THE charge then reports "charged $647.93 vs $38.85
  // expected (+1567%)" and projects the next renewal off the wrong date.
  // Prefer charges that look like the subscription; fall back to the raw
  // newest only when nothing plausible exists, so a genuine price change is
  // still caught.
  const plausible = charges.filter(
    (c) => Math.abs(c.amount - sub.expectedAmount) <= Math.max(sub.expectedAmount * 0.5, 1),
  );
  const pool = plausible.length > 0 ? plausible : charges;
  const lastCharge = pool.length > 0 ? pool[pool.length - 1] : null;
  const nextPaymentDate = projectNextPayment(sub.anchorDate, sub.cadence, lastCharge?.date ?? null, now);

  // Cent-exact comparison: any drift on the most recent charge is flagged
  // immediately — no waiting for the recurring detector's 3 occurrences.
  const priceDrift =
    lastCharge !== null && Math.round(lastCharge.amount * 100) !== Math.round(sub.expectedAmount * 100)
      ? {
          expected: sub.expectedAmount,
          actual: lastCharge.amount,
          // expectedAmount is an unvalidated Decimal; 0 would yield Infinity,
          // which JSON.stringify writes as null and the UI renders as a bogus
          // percentage.
          deltaPct:
            sub.expectedAmount === 0
              ? null
              : round4((lastCharge.amount - sub.expectedAmount) / sub.expectedAmount),
        }
      : null;

  return {
    id: sub.id,
    name: sub.name,
    enabled: sub.enabled,
    expectedAmount: sub.expectedAmount,
    cadence: sub.cadence,
    nextPaymentDate,
    daysUntilNextPayment: Math.ceil((nextPaymentDate.getTime() - now.getTime()) / DAY_MS),
    lastCharge,
    priceDrift,
  };
}

export async function getSubscriptionStatuses(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SubscriptionStatus[]> {
  const subs = await prisma.trackedSubscription.findMany({ where: { enabled: true } });
  if (subs.length === 0) return [];

  // TRANSFERs excluded: a subscription charge is real spending by definition.
  const txns = await prisma.transaction.findMany({
    where: { flow: 'OUTFLOW' },
    select: { id: true, date: true, amount: true, normalizedMerchant: true, description: true },
  });
  const txnsLite: ChargeTxnLite[] = txns.map((t) => ({
    id: t.id,
    date: t.date,
    amount: Number(t.amount),
    normalizedMerchant: t.normalizedMerchant,
    description: t.description,
  }));

  return subs
    .map((s) =>
      reconcileSubscription(
        {
          id: s.id,
          name: s.name,
          merchantPattern: s.merchantPattern,
          expectedAmount: Number(s.expectedAmount),
          cadence: s.cadence,
          anchorDate: s.anchorDate,
          enabled: s.enabled,
        },
        txnsLite,
        now,
      ),
    )
    .sort((a, b) => a.daysUntilNextPayment - b.daysUntilNextPayment);
}
