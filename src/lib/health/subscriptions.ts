import type { RecurringCadence } from '../../types/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { round2, round4 } from '../insights/stats';
import type { SubscriptionCharge, SubscriptionStatus } from './types';

const DAY_MS = 86_400_000;

function stepForward(date: Date, cadence: RecurringCadence): Date {
  switch (cadence) {
    case 'WEEKLY':
      return new Date(date.getTime() + 7 * DAY_MS);
    case 'BIWEEKLY':
      return new Date(date.getTime() + 14 * DAY_MS);
    case 'MONTHLY':
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 12));
    case 'QUARTERLY':
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, date.getUTCDate(), 12));
    case 'YEARLY':
      return new Date(Date.UTC(date.getUTCFullYear() + 1, date.getUTCMonth(), date.getUTCDate(), 12));
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
  let next = lastChargeDate ?? anchor;
  let guard = 0;
  while (next.getTime() <= now.getTime()) {
    next = stepForward(next, cadence);
    if (++guard > 5000) throw new Error('projectNextPayment runaway');
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

  const lastCharge = charges.length > 0 ? charges[charges.length - 1] : null;
  const nextPaymentDate = projectNextPayment(sub.anchorDate, sub.cadence, lastCharge?.date ?? null, now);

  // Cent-exact comparison: any drift on the most recent charge is flagged
  // immediately — no waiting for the recurring detector's 3 occurrences.
  const priceDrift =
    lastCharge !== null && Math.round(lastCharge.amount * 100) !== Math.round(sub.expectedAmount * 100)
      ? {
          expected: sub.expectedAmount,
          actual: lastCharge.amount,
          deltaPct: round4((lastCharge.amount - sub.expectedAmount) / sub.expectedAmount),
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
