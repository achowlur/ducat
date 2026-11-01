import type { InsightPayloadMap, InsightType, PeriodGranularity } from '../../types/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { detectCategoryTotalAnomalies, detectTransactionAnomalies, DEFAULT_ANOMALY_OPTIONS, type AnomalyOptions } from './anomalies';
import { computeCashFlowTrend } from './cashFlow';
import { localDayKey } from '../displayZone';
import { pollsForBalances } from '../health/health';
import { computeNetWorthGrowth, marketDaySnapshots } from './netWorth';
import { enumeratePeriods, monthKeyBack } from './periods';
import { detectRecurringCharges, DEFAULT_RECURRING_OPTIONS, type RecurringOptions } from './recurring';
import { computeSpendingByCategory } from './spendingByCategory';
import type { AccountData, SnapshotData, TxnData } from './types';

/**
 * Months before an edit's own month that a scoped run still regenerates. An
 * analyzer reads across periods: the previous month (deltas), the paydays
 * around a deposit (oneOffPay judges 3 of 8, irregularIncome 7 months), so a
 * row edited in one month can change how a neighbour reads. Forward needs no
 * margin: every period after the edit is regenerated, since anomaly baselines
 * are the history before a period.
 */
export const SCOPE_LOOKBACK_MONTHS = 12;

export interface GenerateOptions {
  granularity?: PeriodGranularity;
  /**
   * Regenerate only what an edit to rows dated at or after this instant can
   * have changed: SCOPE_LOOKBACK_MONTHS before its month, through the latest
   * period. Every other period keeps its stored rows. MONTH granularity only;
   * sync, upgrade and scripts omit it and run in full.
   */
  since?: Date;
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
    // The feed's balance of a brokerage values the previous trading day's close.
    priorClose: a.type === 'INVESTMENT' && pollsForBalances(a.connectorType),
  }));
  const snapshots: SnapshotData[] = marketDaySnapshots(
    snapshotRows.map((s) => ({ accountId: s.accountId, date: s.date, balance: Number(s.balance) })),
    accounts,
    localDayKey,
  );
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
    categoryIsIncome: t.category?.isIncome ?? false,
    reimbursesId: t.reimbursesId,
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
  // The periods this run writes. Every analyzer below still sees the whole
  // history (baselines, pay judgement), so a scoped row is the row a full run
  // would write; only the writes are fewer.
  const scopeFrom =
    options.since !== undefined && granularity === 'MONTH' ? monthKeyBack(options.since, SCOPE_LOOKBACK_MONTHS) : null;
  const scope = scopeFrom === null ? periods : periods.filter((p) => p >= scopeFrom);
  const inScope = new Set(scope);

  const fresh: NewInsight[] = [];
  for (const [period, payload] of computeNetWorthGrowth(accounts, snapshots, txns, periods, granularity)) {
    fresh.push({ type: 'NET_WORTH_GROWTH', period, payload, identity: 'NET_WORTH_GROWTH' });
  }
  // One-off purchases first: the everyday spending the pace call projects
  // from leaves them out.
  const anomalyOptions = options.anomalyOptions ?? DEFAULT_ANOMALY_OPTIONS;
  const transactionAnomalies = new Map(periods.map((p) => [p, detectTransactionAnomalies(txns, p, granularity, anomalyOptions)]));
  const oneOffIds = new Set(
    [...transactionAnomalies.values()].flat().flatMap((a) => (a.transactionId === null ? [] : [a.transactionId])),
  );
  for (const [period, payload] of computeSpendingByCategory(txns, periods, granularity, oneOffIds)) {
    fresh.push({ type: 'SPENDING_BY_CATEGORY', period, payload, identity: 'SPENDING_BY_CATEGORY' });
  }
  for (const [period, payload] of computeCashFlowTrend(txns, periods, granularity)) {
    fresh.push({ type: 'CASH_FLOW_TREND', period, payload, identity: 'CASH_FLOW_TREND' });
  }
  const recurringOptions = options.recurringOptions ?? DEFAULT_RECURRING_OPTIONS;
  for (const [merchant, payload] of detectRecurringCharges(txns, recurringOptions)) {
    fresh.push({ type: 'RECURRING_CHARGE', period: latestPeriod, payload, identity: merchant });
  }
  for (const period of periods) {
    for (const payload of transactionAnomalies.get(period) ?? []) {
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
      where: { period: { in: scope } },
    });
    const dismissedByKey = new Map<string, boolean>();
    for (const row of existing) {
      const type = row.type as InsightType;
      dismissedByKey.set(`${type}|${row.period}|${identityOf(type, row.payload)}`, row.dismissed);
    }
    await tx.insight.deleteMany({ where: { period: { in: scope } } });
    await tx.insight.createMany({
      data: fresh.filter((i) => inScope.has(i.period)).map((i) => ({
        type: i.type,
        period: i.period,
        payload: i.payload as unknown as Prisma.InputJsonValue,
        dismissed: dismissedByKey.get(`${i.type}|${i.period}|${i.identity}`) ?? false,
      })),
    });
    // A full MONTH run also clears the strays: every screen reads months, and a
    // WEEK, QUARTER or YEAR row left by a one-off run of the script is read by
    // nothing (monthlyRows drops it) while every Insight read still pays for it.
    if (scopeFrom === null && granularity === 'MONTH') {
      await tx.insight.deleteMany({
        where: { OR: [{ period: { contains: '-W' } }, { period: { contains: '-Q' } }, { NOT: { period: { contains: '-' } } }] },
      });
    }
  });

  const byType = { ...emptyCounts };
  for (const i of fresh) if (inScope.has(i.period)) byType[i.type] += 1;
  return { granularity, periods: scope, created: fresh.filter((i) => inScope.has(i.period)).length, byType };
}
