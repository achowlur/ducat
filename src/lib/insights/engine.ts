import type { InsightPayloadMap, InsightType, PeriodGranularity } from '../../types/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { detectCategoryTotalAnomalies, detectTransactionAnomalies, DEFAULT_ANOMALY_OPTIONS, type AnomalyOptions } from './anomalies';
import { computeCashFlowTrend } from './cashFlow';
import { computeNetWorthGrowth } from './netWorth';
import { enumeratePeriods } from './periods';
import { detectRecurringCharges, DEFAULT_RECURRING_OPTIONS, type RecurringOptions } from './recurring';
import { computeSpendingByCategory } from './spendingByCategory';
import type { AccountData, SnapshotData, TxnData } from './types';

export interface GenerateOptions {
  granularity?: PeriodGranularity;
  anomalyOptions?: AnomalyOptions;
  recurringOptions?: RecurringOptions;
}

export interface GenerateResult {
  granularity: PeriodGranularity;
  periods: string[];
  created: number;
  byType: Record<InsightType, number>;
}

interface NewInsight {
  type: InsightType;
  period: string;
  payload: InsightPayloadMap[InsightType];
  /** Stable key within (type, period) used to carry dismissals across regeneration. */
  identity: string;
}

function identityOf(type: InsightType, payload: Prisma.JsonValue): string {
  if (type === 'RECURRING_CHARGE' || type === 'ANOMALY') {
    const p = payload as Record<string, unknown>;
    if (type === 'RECURRING_CHARGE') return String(p.merchant);
    return p.transactionId !== null
      ? String(p.transactionId)
      : `CATEGORY_TOTAL:${String(p.categoryId)}`;
  }
  // Single insight per (type, period) for the aggregate types.
  return type;
}

/**
 * Runs every analyzer over the full transaction history and persists the
 * results. Regeneration replaces existing insights of the same (type, period)
 * but carries the dismissed flag forward for insights with the same identity.
 */
export async function generateInsights(
  prisma: PrismaClient,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const granularity = options.granularity ?? 'MONTH';

  const [accountRows, snapshotRows, txnRows] = await Promise.all([
    prisma.account.findMany(),
    prisma.balanceSnapshot.findMany(),
    prisma.transaction.findMany({ include: { category: true } }),
  ]);

  const accounts: AccountData[] = accountRows.map((a) => ({
    id: a.id,
    type: a.type,
    balance: Number(a.balance),
    balanceDate: a.balanceDate,
  }));
  const snapshots: SnapshotData[] = snapshotRows.map((s) => ({
    accountId: s.accountId,
    date: s.date,
    balance: Number(s.balance),
  }));
  const txns: TxnData[] = txnRows.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amount: Number(t.amount),
    description: t.description,
    normalizedMerchant: t.normalizedMerchant,
    flow: t.flow,
    categoryId: t.categoryId,
    categoryName: t.category?.name ?? null,
  }));

  const emptyCounts: Record<InsightType, number> = {
    NET_WORTH_GROWTH: 0,
    SPENDING_BY_CATEGORY: 0,
    CASH_FLOW_TREND: 0,
    RECURRING_CHARGE: 0,
    ANOMALY: 0,
  };
  if (txns.length === 0) {
    return { granularity, periods: [], created: 0, byType: emptyCounts };
  }

  const dates = txns.map((t) => t.date.getTime());
  const periods = enumeratePeriods(new Date(Math.min(...dates)), new Date(Math.max(...dates)), granularity);
  const latestPeriod = periods[periods.length - 1];

  const fresh: NewInsight[] = [];
  for (const [period, payload] of computeNetWorthGrowth(accounts, snapshots, txns, periods, granularity)) {
    fresh.push({ type: 'NET_WORTH_GROWTH', period, payload, identity: 'NET_WORTH_GROWTH' });
  }
  for (const [period, payload] of computeSpendingByCategory(txns, periods, granularity)) {
    fresh.push({ type: 'SPENDING_BY_CATEGORY', period, payload, identity: 'SPENDING_BY_CATEGORY' });
  }
  for (const [period, payload] of computeCashFlowTrend(txns, periods, granularity)) {
    fresh.push({ type: 'CASH_FLOW_TREND', period, payload, identity: 'CASH_FLOW_TREND' });
  }
  const recurringOptions = options.recurringOptions ?? DEFAULT_RECURRING_OPTIONS;
  for (const [merchant, payload] of detectRecurringCharges(txns, recurringOptions)) {
    fresh.push({ type: 'RECURRING_CHARGE', period: latestPeriod, payload, identity: merchant });
  }
  const anomalyOptions = options.anomalyOptions ?? DEFAULT_ANOMALY_OPTIONS;
  for (const period of periods) {
    for (const payload of detectTransactionAnomalies(txns, period, granularity, anomalyOptions)) {
      fresh.push({ type: 'ANOMALY', period, payload, identity: String(payload.transactionId) });
    }
    for (const payload of detectCategoryTotalAnomalies(txns, period, periods, granularity, anomalyOptions)) {
      fresh.push({ type: 'ANOMALY', period, payload, identity: `CATEGORY_TOTAL:${String(payload.categoryId)}` });
    }
  }

  await prisma.$transaction(async (tx) => {
    // Every (type, period) in scope is replaced wholesale — stale insights for
    // periods that no longer produce one must not survive a regeneration.
    const existing = await tx.insight.findMany({
      where: { period: { in: periods } },
    });
    const dismissedByKey = new Map<string, boolean>();
    for (const row of existing) {
      const type = row.type as InsightType;
      dismissedByKey.set(`${type}|${row.period}|${identityOf(type, row.payload)}`, row.dismissed);
    }
    await tx.insight.deleteMany({ where: { period: { in: periods } } });
    await tx.insight.createMany({
      data: fresh.map((i) => ({
        type: i.type,
        period: i.period,
        payload: i.payload as unknown as Prisma.InputJsonValue,
        dismissed: dismissedByKey.get(`${i.type}|${i.period}|${i.identity}`) ?? false,
      })),
    });
  });

  const byType = { ...emptyCounts };
  for (const i of fresh) byType[i.type] += 1;
  return { granularity, periods, created: fresh.length, byType };
}
