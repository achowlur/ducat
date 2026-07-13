import type {
  CashFlowTrendPayload,
  NetWorthGrowthPayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { prisma } from "../prisma";
import { granularityOfKey } from "../insights/periods";

export interface DonutSliceData {
  label: string;
  categoryId: string | null;
  value: number;
  share: number;
}

export interface CategoryRow {
  label: string;
  categoryId: string | null;
  spending: number;
  previousSpending: number | null;
  deltaPct: number | null;
  share: number;
}

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

  let donut: TrendsData["donut"] = null;
  const categories: CategoryRow[] = spending.categories.map((c) => ({
    label: c.categoryName ?? "Uncategorized",
    categoryId: c.categoryId,
    spending: c.spending,
    previousSpending: c.previousSpending,
    deltaPct: c.deltaPct,
    share: spending.totalSpending > 0 ? c.spending / spending.totalSpending : 0,
  }));
  if (spending.totalSpending > 0) {
    const top = categories.slice(0, 3);
    const rest = categories.slice(3);
    const slices: DonutSliceData[] = top.map((c) => ({
      label: c.label,
      categoryId: c.categoryId,
      value: c.spending,
      share: c.share,
    }));
    const restTotal = rest.reduce((sum, c) => sum + c.spending, 0);
    if (restTotal > 0) {
      slices.push({
        label: "Other",
        categoryId: null,
        value: restTotal,
        share: restTotal / spending.totalSpending,
      });
    }
    donut = { slices, total: spending.totalSpending };
  }

  const cashFlowAll = await monthlyInsights<CashFlowTrendPayload>("CASH_FLOW_TREND");
  const netWorthAll = await monthlyInsights<NetWorthGrowthPayload>("NET_WORTH_GROWTH");

  return {
    period,
    prevPeriod: idx > 0 ? available[idx - 1] : null,
    nextPeriod: idx < available.length - 1 ? available[idx + 1] : null,
    periodLabel: monthLabel(period),
    donut,
    categories,
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
