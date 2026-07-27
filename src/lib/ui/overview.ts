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
import { higherThan, money, monthLabel, pct, shortDate, titleCase } from "./format";
import { monthlyRows, ofType, type MonthlyInsight } from "./insightRows";
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

/**
 * Recurring charges from the most recent period that has any, deduped and
 * flagged against what's registered. Independent of the net-worth period so
 * the list survives months where net worth can't be computed.
 */
function detectedSubscriptions(
  recurring: MonthlyInsight<DetectedCharge>[],
  trackedNames: string[],
): DetectedSubscription[] {
  if (recurring.length === 0) return [];
  const newest = recurring[recurring.length - 1].period;
  const now = new Date();
  return mergeDetectedSubscriptions(
    recurring
      .filter((r) => r.period === newest)
      .map((r) => r.payload)
      // Drop anything whose last charge is long past — a cancelled service
      // would otherwise keep billing in the annualised total forever.
      .filter((c) => isActive(c, now)),
    trackedNames,
  );
}

export async function getOverviewData(): Promise<OverviewData> {
  // Everything this page needs, read once and in parallel. It used to issue
  // its queries one after another — four of them full scans of the Insight
  // table, with RECURRING_CHARGE fetched twice over.
  const [insightRows, accountRows, snapshots, uncategorizedCount, trackedRows, lastOk, subscriptions, health] =
    await Promise.all([
      prisma.insight.findMany(),
      prisma.account.findMany(),
      prisma.balanceSnapshot.groupBy({ by: ["accountId"], _max: { date: true } }),
      prisma.transaction.count({
        where: { categoryId: null, flow: { not: "TRANSFER" }, reimbursesId: null },
      }),
      prisma.trackedSubscription.findMany({ select: { name: true } }),
      prisma.syncLog.findFirst({ where: { ok: true }, orderBy: { finishedAt: "desc" } }),
      getSubscriptionStatuses(prisma),
      getProviderHealth(prisma),
    ]);

  const monthly = monthlyRows(insightRows);
  // ofType is oldest-first, the order charts plot in. This page reads the
  // LATEST month, so it takes from the end rather than flipping the shared
  // default out from under Trends.
  const netWorthAll = ofType<NetWorthGrowthPayload>(monthly, "NET_WORTH_GROWTH");
  const latest = netWorthAll[netWorthAll.length - 1] ?? null;
  const period = latest?.period ?? null;
  const detected = detectedSubscriptions(
    ofType<DetectedCharge>(monthly, "RECURRING_CHARGE"),
    trackedRows.map((t) => t.name),
  );
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
      subscriptions,
      detectedSubscriptions: detected,
      subscriptionsAnnual: annualisedTotal(detected),
      health,
      lastSyncAt: null,
      uncategorizedCount,
    };
  }

  const spending =
    ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY").find((s) => s.period === period)?.payload ??
    null;
  const donut = spending === null ? null : spendingBreakdown(spending).donut;

  const signals: Signal[] = [];
  const anomalies = monthly.filter((r) => r.type === "ANOMALY" && r.period === period && !r.dismissed);
  for (const row of anomalies) {
    const p = row.payload as unknown as AnomalyPayload;
    signals.push({
      chip: "Anomaly",
      tone: "neg",
      text:
        p.kind === "TRANSACTION"
          ? `${titleCase(p.description ?? "transaction")} — ${money(p.amount)}, ${higherThan(p.percentileOfHistory, `your ${p.categoryName ?? "spending here"}`)}`
          : `${p.categoryName ?? "Category"} total ${money(p.amount)} this month — ${higherThan(p.percentileOfHistory, "prior months")}`,
    });
  }

  let streak = 0;
  for (const row of [...netWorthAll].reverse()) {
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

  const trend =
    ofType<CashFlowTrendPayload>(monthly, "CASH_FLOW_TREND").find((t) => t.period === period)?.payload ?? null;
  if (trend !== null && trend.spendingDeltaPct !== null) {
    const dir = trend.spendingDeltaPct >= 0 ? "up" : "down";
    signals.push({
      chip: "Trend",
      tone: "neutral",
      text: `Spending ${money(trend.spending)}, ${dir} ${pct(trend.spendingDeltaPct).slice(1)} vs last month; income ${trend.incomeDeltaPct !== null && Math.abs(trend.incomeDeltaPct) < 0.02 ? "flat" : money(trend.income)}`,
    });
  }

  const recurringAll = monthly.filter((r) => r.type === "RECURRING_CHARGE" && r.period === period && !r.dismissed);
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

  return {
    period,
    periodLabel: monthLabel(period),
    netWorth: latest.payload,
    accounts,
    estimatedCount: latest.payload.estimatedAccountIds.length,
    donut,
    signals,
    subscriptions,
    detectedSubscriptions: detected,
    subscriptionsAnnual: annualisedTotal(detected),
    health,
    lastSyncAt: lastOk?.finishedAt ?? null,
    uncategorizedCount,
  };
}
