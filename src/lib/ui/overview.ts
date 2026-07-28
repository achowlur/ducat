/**
 * Overview answers WHERE THINGS STAND: what you hold, what it adds up to, and
 * what needs review. Trajectory — what changed, what it costs forward, what is
 * about to be charged — belongs to /insights, which now has a digest, a pace
 * call and a commitments panel built for exactly that.
 *
 * This page used to carry both. Its "signals" column and its subscriptions
 * block were the same findings the digest ranks, rendered a second way and
 * uncapped, so the two tabs answered one question twice and disagreed on
 * emphasis. The full recurring roster and its annualised total live on
 * /insights now; nothing was dropped.
 */
import type { NetWorthGrowthPayload, SpendingByCategoryPayload } from "../../types/contracts";
import { prisma } from "../prisma";
import { getProviderHealth } from "../health/health";
import type { ProviderHealth } from "../health/types";
import { monthLabel, shortDate } from "./format";
import { monthlyRows, ofType } from "./insightRows";
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

export interface OverviewData {
  period: string; // e.g. "2026-07"
  periodLabel: string; // "July 2026"
  netWorth: NetWorthGrowthPayload | null;
  accounts: AccountRow[];
  estimatedCount: number;
  donut: { slices: DonutSliceData[]; total: number } | null;
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

export async function getOverviewData(): Promise<OverviewData> {
  // Everything this page needs, read once and in parallel. It used to issue
  // its queries one after another — four of them full scans of the Insight
  // table, with RECURRING_CHARGE fetched twice over.
  const [insightRows, accountRows, snapshots, uncategorizedCount, lastOk, health] = await Promise.all([
    prisma.insight.findMany(),
    prisma.account.findMany(),
    prisma.balanceSnapshot.groupBy({ by: ["accountId"], _max: { date: true } }),
    prisma.transaction.count({
      where: { categoryId: null, flow: { not: "TRANSFER" }, reimbursesId: null },
    }),
    prisma.syncLog.findFirst({ where: { ok: true }, orderBy: { finishedAt: "desc" } }),
    getProviderHealth(prisma),
  ]);

  const monthly = monthlyRows(insightRows);
  // ofType is oldest-first, the order charts plot in. This page reads the
  // LATEST month, so it takes from the end rather than flipping the shared
  // default out from under Trends.
  const netWorthAll = ofType<NetWorthGrowthPayload>(monthly, "NET_WORTH_GROWTH");
  const latest = netWorthAll[netWorthAll.length - 1] ?? null;
  const period = latest?.period ?? null;
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
      health,
      lastSyncAt: null,
      uncategorizedCount,
    };
  }

  const spending =
    ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY").find((s) => s.period === period)?.payload ??
    null;
  const donut = spending === null ? null : spendingBreakdown(spending).donut;

  return {
    period,
    periodLabel: monthLabel(period),
    netWorth: latest.payload,
    accounts,
    estimatedCount: latest.payload.estimatedAccountIds.length,
    donut,
    health,
    lastSyncAt: lastOk?.finishedAt ?? null,
    uncategorizedCount,
  };
}
