import type { RecurringChargePayload, SpendingByCategoryPayload } from "../../types/contracts";
import { prisma } from "../prisma";
import { upcomingCommitments } from "../health/commitments";
import { mergeDetectedSubscriptions, type DetectedCharge } from "../health/detectedSubscriptions";
import { getSubscriptionStatuses } from "../health/subscriptions";
import type { PeriodCoverage } from "../insights/coverage";
import { periodCoverage } from "../insights/coverage";
import { computePace, type Pace, type PriorPeriod } from "../insights/pace";
import { periodEndExclusive, periodKey } from "../insights/periods";
import { getAccountCoverage } from "./coverage";
import { monthlyRows, ofType, type MonthlyInsight } from "./insightRows";

/**
 * The pace call's baseline from the stored spending rows, each carrying how
 * many of today's accounts reached back into it. ONE definition for
 * /insights and /trends: two answers to "what is a typical month?" would be
 * one too many.
 */
export function priorPeriods(
  spendingRows: MonthlyInsight<SpendingByCategoryPayload>[],
  period: string,
  coverageOf: (period: string) => PeriodCoverage | null,
): PriorPeriod[] {
  return spendingRows
    .filter((r) => r.period < period)
    .map((r) => {
      const c = coverageOf(r.period);
      return {
        period: r.period,
        total: r.payload.totalSpending,
        coverage: c === null ? undefined : { covered: c.covered, total: c.total },
        everydayAfterDay: r.payload.everydayAfterDay,
      };
    });
}

/**
 * The month being lived in, projected the way /insights projects it, for a
 * page that has no insight rows of its own (/trends). Null when the month has
 * no spending row yet, as on /insights.
 */
export async function getCurrentPace(now: Date): Promise<Pace | null> {
  const period = periodKey(now, "MONTH");
  const [rows, registered, accountCoverage] = await Promise.all([
    prisma.insight.findMany({
      // Only what the pace draws: every month's spending, and this month's recurring charges.
      where: { OR: [{ type: "SPENDING_BY_CATEGORY" }, { type: "RECURRING_CHARGE", period }] },
      select: { type: true, period: true, payload: true, dismissed: true },
    }),
    getSubscriptionStatuses(prisma),
    getAccountCoverage(),
  ]);
  const monthly = monthlyRows(rows);
  const spending = ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY");
  const thisPeriod = spending.find((r) => r.period === period);
  if (thisPeriod === undefined) return null;
  const coverageOf = (p: string): PeriodCoverage | null => {
    if (accountCoverage.length === 0) return null;
    try {
      return periodCoverage(p, accountCoverage);
    } catch {
      return null;
    }
  };
  const detected = mergeDetectedSubscriptions(
    ofType<DetectedCharge & RecurringChargePayload>(monthly, "RECURRING_CHARGE")
      .filter((r) => r.period === period)
      .map((r) => r.payload),
  );
  const daysLeft = Math.max(0, Math.ceil((periodEndExclusive(period).getTime() - now.getTime()) / 86_400_000));
  const due = upcomingCommitments(detected, registered, now, daysLeft).total;
  return computePace({
    period,
    now,
    spentSoFar: thisPeriod.payload.totalSpending,
    committedRemaining: due,
    priors: priorPeriods(spending, period, coverageOf),
  });
}
