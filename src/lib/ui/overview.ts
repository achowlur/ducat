import type {
  AnomalyPayload,
  CashFlowTrendPayload,
  NetWorthGrowthPayload,
  RecurringChargePayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { prisma } from "../prisma";
import { getProviderHealth } from "../health/health";
import { getSubscriptionStatuses } from "../health/subscriptions";
import {
  annualisedTotal,
  isActive,
  mergeDetectedSubscriptions,
  type DetectedCharge,
  type DetectedSubscription,
} from "../health/detectedSubscriptions";
import type { ProviderHealth, SubscriptionStatus } from "../health/types";
import { granularityOfKey } from "../insights/periods";
import { money, monthLabel, pct, shortDate, titleCase } from "./format";
import { spendingBreakdown, type DonutSliceData } from "./spendingBreakdown";

export interface AccountRow {
  id: string;
  name: string;
  institution: string;
  type: string;
  balance: number;
  snapshotBacked: boolean;
  snapshotDate: string | null;
}

export interface Signal {
  chip: "Anomaly" | "Gain" | "Trend" | "Recurring";
  tone: "neg" | "pos" | "neutral";
  text: string;
}

export interface OverviewData {
  period: string; // e.g. "2026-07"
  periodLabel: string; // "July 2026"
  netWorth: NetWorthGrowthPayload | null;
  accounts: AccountRow[];
  estimatedCount: number;
  donut: { slices: DonutSliceData[]; total: number } | null;
  signals: Signal[];
  subscriptions: SubscriptionStatus[];
  /** Every recurring charge the engine found, deduped — not just registered ones. */
  detectedSubscriptions: DetectedSubscription[];
  /** What the detected set costs per year. */
  subscriptionsAnnual: number;
  health: ProviderHealth[];
  lastSyncAt: Date | null;
  /**
   * Non-transfer transactions with no category and no reimbursement link.
   * The single loudest signal on launch: spending analytics are incomplete
   * until this is zero.
   */
  uncategorizedCount: number;
}

const TYPE_ORDER: Record<string, number> = { DEPOSITORY: 0, INVESTMENT: 1, CREDIT: 2, LOAN: 3 };

/** Latest MONTH-granularity insights of one type, newest period first. */
async function monthlyInsights<T>(type: string): Promise<{ period: string; payload: T; dismissed: boolean }[]> {
  const rows = await prisma.insight.findMany({ where: { type } });
  return rows
    .filter((r) => {
      try {
        return granularityOfKey(r.period) === "MONTH";
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .map((r) => ({ period: r.period, payload: r.payload as T, dismissed: r.dismissed }));
}

/**
 * Recurring charges from the most recent period that has any, deduped and
 * flagged against what's registered. Independent of the net-worth period so
 * the list survives months where net worth can't be computed.
 */
async function detectedSubscriptions(): Promise<DetectedSubscription[]> {
  const rows = await monthlyInsights<DetectedCharge>("RECURRING_CHARGE");
  if (rows.length === 0) return [];
  const newest = rows[0].period;
  const tracked = await prisma.trackedSubscription.findMany({ select: { name: true } });
  const now = new Date();
  return mergeDetectedSubscriptions(
    rows
      .filter((r) => r.period === newest)
      .map((r) => r.payload)
      // Drop anything whose last charge is long past — a cancelled service
      // would otherwise keep billing in the annualised total forever.
      .filter((c) => isActive(c, now)),
    tracked.map((t) => t.name),
  );
}

export async function getOverviewData(): Promise<OverviewData> {
  const netWorthAll = await monthlyInsights<NetWorthGrowthPayload>("NET_WORTH_GROWTH");
  const latest = netWorthAll[0] ?? null;
  const period = latest?.period ?? null;
  const detected = await detectedSubscriptions();

  const uncategorizedCount = await prisma.transaction.count({
    where: { categoryId: null, flow: { not: "TRANSFER" }, reimbursesId: null },
  });

  const accountRows = await prisma.account.findMany();
  const snapshots = await prisma.balanceSnapshot.groupBy({
    by: ["accountId"],
    _max: { date: true },
  });
  const snapshotByAccount = new Map(snapshots.map((s) => [s.accountId, s._max.date]));
  const accounts: AccountRow[] = accountRows
    .map((a) => {
      const snapDate = snapshotByAccount.get(a.id) ?? null;
      return {
        id: a.id,
        name: a.name,
        institution: a.institution,
        type: a.type,
        balance: Number(a.balance),
        snapshotBacked: snapDate !== null,
        snapshotDate: snapDate === null ? null : shortDate(snapDate),
      };
    })
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || b.balance - a.balance);

  if (period === null) {
    return {
      period: "",
      periodLabel: "No data yet",
      netWorth: null,
      accounts,
      estimatedCount: 0,
      donut: null,
      signals: [],
      subscriptions: await getSubscriptionStatuses(prisma),
      detectedSubscriptions: detected,
      subscriptionsAnnual: annualisedTotal(detected),
      health: await getProviderHealth(prisma),
      lastSyncAt: null,
      uncategorizedCount,
    };
  }

  const spendingAll = await monthlyInsights<SpendingByCategoryPayload>("SPENDING_BY_CATEGORY");
  const spending = spendingAll.find((s) => s.period === period)?.payload ?? null;
  const donut = spending === null ? null : spendingBreakdown(spending).donut;

  const signals: Signal[] = [];
  const anomalies = await prisma.insight.findMany({ where: { type: "ANOMALY", period, dismissed: false } });
  for (const row of anomalies) {
    const p = row.payload as unknown as AnomalyPayload;
    signals.push({
      chip: "Anomaly",
      tone: "neg",
      text:
        p.kind === "TRANSACTION"
          ? `${titleCase(p.description ?? "transaction")} — ${money(p.amount)}, vs ${money(p.typicalAmount)} typical for ${p.categoryName ?? "this category"}`
          : `${p.categoryName ?? "Category"} total ${money(p.amount)} this month — vs ${money(p.typicalAmount)} in a typical month`,
    });
  }

  let streak = 0;
  for (const row of netWorthAll) {
    if (row.payload.growthRate !== null && row.payload.growthRate > 0) streak++;
    else break;
  }
  if (latest !== null && latest.payload.growthRate !== null && latest.payload.growthRate > 0 && latest.payload.previousNetWorth !== null) {
    const gained = latest.payload.netWorth - latest.payload.previousNetWorth;
    signals.push({
      chip: "Gain",
      tone: "pos",
      text: `Net worth up ${money(gained)} this month${streak > 1 ? ` — ${streak} straight monthly gains` : ""}`,
    });
  }

  const trendAll = await monthlyInsights<CashFlowTrendPayload>("CASH_FLOW_TREND");
  const trend = trendAll.find((t) => t.period === period)?.payload ?? null;
  if (trend !== null && trend.spendingDeltaPct !== null) {
    const dir = trend.spendingDeltaPct >= 0 ? "up" : "down";
    signals.push({
      chip: "Trend",
      tone: "neutral",
      text: `Spending ${money(trend.spending)}, ${dir} ${pct(trend.spendingDeltaPct).slice(1)} vs last month; income ${trend.incomeDeltaPct !== null && Math.abs(trend.incomeDeltaPct) < 0.02 ? "flat" : money(trend.income)}`,
    });
  }

  const recurringAll = await prisma.insight.findMany({ where: { type: "RECURRING_CHARGE", period, dismissed: false } });
  const increased = recurringAll
    .map((r) => r.payload as unknown as RecurringChargePayload)
    .filter((p) => p.priceIncreased);
  for (const p of increased) {
    signals.push({
      chip: "Recurring",
      tone: "neg",
      text: `${titleCase(p.merchant)} raised to ${money(p.lastAmount)} (was ${money(p.previousAverageAmount ?? p.averageAmount)})`,
    });
  }
  if (recurringAll.length > 0 && increased.length === 0) {
    signals.push({ chip: "Recurring", tone: "neutral", text: `${recurringAll.length} recurring charges detected, all at expected prices` });
  }

  const lastOk = await prisma.syncLog.findFirst({ where: { ok: true }, orderBy: { finishedAt: "desc" } });

  return {
    period,
    periodLabel: monthLabel(period),
    netWorth: latest.payload,
    accounts,
    estimatedCount: latest.payload.estimatedAccountIds.length,
    donut,
    signals,
    subscriptions: await getSubscriptionStatuses(prisma),
    detectedSubscriptions: detected,
    subscriptionsAnnual: annualisedTotal(detected),
    health: await getProviderHealth(prisma),
    lastSyncAt: lastOk?.finishedAt ?? null,
    uncategorizedCount,
  };
}
