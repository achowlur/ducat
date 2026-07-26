import type {
  CashFlowTrendPayload,
  NetWorthGrowthPayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { prisma } from "../prisma";
import { granularityOfKey } from "../insights/periods";
import { spendingBreakdown, type CategoryRow, type DonutSliceData } from "./spendingBreakdown";

export type { CategoryRow, DonutSliceData };

export interface MonthPoint {
  period: string; // "2026-07"
  label: string; // "Jul"
}

export interface TrendsData {
  /** Selected spending period and the ones available for prev/next nav. */
  period: string;
  prevPeriod: string | null;
  nextPeriod: string | null;
  periodLabel: string;
  donut: { slices: DonutSliceData[]; total: number } | null;
  categories: CategoryRow[];
  /** Sum of the categories with net spending — what every share divides by. */
  drawable: number;
  /** Drawn spending a credit elsewhere cancels; 0 unless a category ended the period negative. */
  credited: number;
  cashFlow: (MonthPoint & { income: number; spending: number; net: number })[];
  netWorth: (MonthPoint & { value: number; estimated: boolean; marketGains: number | null })[];
}

function shortMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function monthlyInsights<T>(type: string): Promise<{ period: string; payload: T }[]> {
  const rows = await prisma.insight.findMany({ where: { type } });
  return rows
    .filter((r) => {
      try {
        return granularityOfKey(r.period) === "MONTH";
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((r) => ({ period: r.period, payload: r.payload as T }));
}

export async function getTrendsData(requestedPeriod?: string): Promise<TrendsData | null> {
  const spendingAll = await monthlyInsights<SpendingByCategoryPayload>("SPENDING_BY_CATEGORY");
  if (spendingAll.length === 0) return null;

  const available = spendingAll.map((s) => s.period);
  const period =
    requestedPeriod !== undefined && available.includes(requestedPeriod)
      ? requestedPeriod
      : available[available.length - 1];
  const idx = available.indexOf(period);
  const spending = spendingAll[idx].payload;

  const breakdown = spendingBreakdown(spending);

  const cashFlowAll = await monthlyInsights<CashFlowTrendPayload>("CASH_FLOW_TREND");
  const netWorthAll = await monthlyInsights<NetWorthGrowthPayload>("NET_WORTH_GROWTH");

  return {
    period,
    prevPeriod: idx > 0 ? available[idx - 1] : null,
    nextPeriod: idx < available.length - 1 ? available[idx + 1] : null,
    periodLabel: monthLabel(period),
    donut: breakdown.donut,
    categories: breakdown.categories,
    drawable: breakdown.drawable,
    credited: breakdown.credited,
    cashFlow: cashFlowAll.map(({ period: p, payload }) => ({
      period: p,
      label: shortMonth(p),
      income: payload.income,
      spending: payload.spending,
      net: payload.net,
    })),
    netWorth: netWorthAll.map(({ period: p, payload }) => ({
      period: p,
      label: shortMonth(p),
      value: payload.netWorth,
      estimated: payload.estimatedAccountIds.length > 0,
      marketGains: payload.marketGains ?? null,
    })),
  };
}
