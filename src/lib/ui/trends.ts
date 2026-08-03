import type {
  CashFlowTrendPayload,
  NetWorthGrowthPayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { monthLabel } from "./format";
import { prisma } from "../prisma";
import { monthlyRows, ofType } from "./insightRows";
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
  /** A `?period=` that had no row and was refused; null when honoured or absent. */
  clampedFrom: string | null;
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

export async function getTrendsData(requestedPeriod?: string): Promise<TrendsData | null> {
  // One read for all three series: this page plots spending, cash flow and net
  // worth, and each used to scan the whole Insight table for itself.
  const monthly = monthlyRows(await prisma.insight.findMany());
  const spendingAll = ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY");
  if (spendingAll.length === 0) return null;

  const available = spendingAll.map((s) => s.period);
  const asked = requestedPeriod === undefined || requestedPeriod === "" ? null : requestedPeriod;
  const honoured = asked !== null && available.includes(asked);
  const period = honoured ? asked : available[available.length - 1];
  // The clamp is right — this page plots stored rows and cannot invent a month
  // it has none for. What was wrong is that it happened in SILENCE: the URL
  // still read `?period=2026-08` while the stepper said July and nothing on the
  // page mentioned the substitution. Overview already refuses to LINK here for
  // exactly this reason; the page causing it should say so itself.
  const clampedFrom = asked !== null && !honoured ? asked : null;
  const idx = available.indexOf(period);
  const spending = spendingAll[idx].payload;

  const breakdown = spendingBreakdown(spending);

  const cashFlowAll = ofType<CashFlowTrendPayload>(monthly, "CASH_FLOW_TREND");
  const netWorthAll = ofType<NetWorthGrowthPayload>(monthly, "NET_WORTH_GROWTH");

  return {
    period,
    prevPeriod: idx > 0 ? available[idx - 1] : null,
    nextPeriod: idx < available.length - 1 ? available[idx + 1] : null,
    periodLabel: monthLabel(period),
    clampedFrom,
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
