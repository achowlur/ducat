import type {
  AnomalyPayload,
  CashFlowTrendPayload,
  InsightType,
  NetWorthGrowthPayload,
  RecurringChargePayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { prisma } from "../prisma";
import { isActive } from "../health/detectedSubscriptions";
import { granularityOfKey, periodEndExclusive } from "../insights/periods";
import { money, pct, titleCase } from "./format";
import { monthLabel } from "./trends";

export interface InsightRow {
  id: string;
  type: InsightType;
  dismissed: boolean;
  chip: string;
  tone: "neg" | "pos" | "neutral";
  /** One-line human rendering of the payload. */
  text: string;
}

export interface InsightsPageData {
  period: string;
  periodLabel: string;
  prevPeriod: string | null;
  nextPeriod: string | null;
  /** Grouped in display order; empty groups omitted. */
  groups: { title: string; rows: InsightRow[] }[];
  dismissedCount: number;
}

function renderAnomaly(p: AnomalyPayload): InsightRow["text"] {
  const times =
    p.typicalAmount > 0 ? ` — ${(p.amount / p.typicalAmount).toFixed(p.amount / p.typicalAmount >= 10 ? 0 : 1)}× typical` : "";
  return p.kind === "TRANSACTION"
    ? `${titleCase(p.description ?? "Transaction")} — ${money(p.amount)}, vs ${money(p.typicalAmount)} typical for ${p.categoryName ?? "its category"}${times}`
    : `${p.categoryName ?? "Category"} total ${money(p.amount)}, vs ${money(p.typicalAmount)} in a typical month${times}`;
}

function renderRecurring(p: RecurringChargePayload): InsightRow["text"] {
  const price = p.priceIncreased
    ? `raised to ${money(p.lastAmount)} (was ${money(p.previousAverageAmount ?? p.averageAmount)})`
    : `${money(p.averageAmount)} ${p.cadence.toLowerCase()}`;
  return `${titleCase(p.merchant)} — ${price} · ${p.occurrences} charges · last ${p.lastDate}`;
}

function renderNetWorth(p: NetWorthGrowthPayload): InsightRow["text"] {
  const growth = p.growthRate === null ? "no prior month in scope" : `${pct(p.growthRate)} vs prior month`;
  const markets =
    p.marketGains !== null && p.marketGains !== 0 ? ` · markets ${money(p.marketGains)}` : "";
  return `Net worth ${money(p.netWorth)} — ${growth}${markets}`;
}

function renderSpending(p: SpendingByCategoryPayload): InsightRow["text"] {
  const top = p.categories.slice(0, 3).map((c) => `${c.categoryName ?? "Uncategorized"} ${money(c.spending)}`);
  return `Total ${money(p.totalSpending)}${p.previousTotalSpending !== null ? ` (prior ${money(p.previousTotalSpending)})` : ""} — top: ${top.join(", ")}`;
}

function renderCashFlow(p: CashFlowTrendPayload): InsightRow["text"] {
  return `Income ${money(p.income)} · spending ${money(p.spending)} · net ${money(p.net)}${
    p.spendingDeltaPct !== null ? ` — spending ${pct(p.spendingDeltaPct)} vs prior month` : ""
  }`;
}

const GROUPS: { type: InsightType; title: string }[] = [
  { type: "ANOMALY", title: "Anomalies" },
  { type: "RECURRING_CHARGE", title: "Recurring charges" },
  { type: "NET_WORTH_GROWTH", title: "Net worth" },
  { type: "CASH_FLOW_TREND", title: "Cash flow" },
  { type: "SPENDING_BY_CATEGORY", title: "Spending by category" },
];

const LAPSED_TITLE = "No longer charging";

function toRow(row: { id: string; type: string; payload: unknown; dismissed: boolean }): InsightRow {
  const type = row.type as InsightType;
  switch (type) {
    case "ANOMALY": {
      const p = row.payload as AnomalyPayload;
      return { id: row.id, type, dismissed: row.dismissed, chip: "Anomaly", tone: "neg", text: renderAnomaly(p) };
    }
    case "RECURRING_CHARGE": {
      const p = row.payload as RecurringChargePayload;
      return {
        id: row.id,
        type,
        dismissed: row.dismissed,
        chip: p.priceIncreased ? "Price up" : "Recurring",
        tone: p.priceIncreased ? "neg" : "neutral",
        text: renderRecurring(p),
      };
    }
    case "NET_WORTH_GROWTH": {
      const p = row.payload as NetWorthGrowthPayload;
      const tone = p.growthRate !== null && p.growthRate > 0 ? "pos" : p.growthRate !== null && p.growthRate < 0 ? "neg" : "neutral";
      return { id: row.id, type, dismissed: row.dismissed, chip: "Net worth", tone, text: renderNetWorth(p) };
    }
    case "CASH_FLOW_TREND": {
      const p = row.payload as CashFlowTrendPayload;
      return { id: row.id, type, dismissed: row.dismissed, chip: "Cash flow", tone: "neutral", text: renderCashFlow(p) };
    }
    case "SPENDING_BY_CATEGORY": {
      const p = row.payload as SpendingByCategoryPayload;
      return { id: row.id, type, dismissed: row.dismissed, chip: "Spending", tone: "neutral", text: renderSpending(p) };
    }
  }
}

export async function getInsightsPageData(requestedPeriod?: string): Promise<InsightsPageData | null> {
  const all = await prisma.insight.findMany();
  const monthly = all.filter((r) => {
    try {
      return granularityOfKey(r.period) === "MONTH";
    } catch {
      return false;
    }
  });
  if (monthly.length === 0) return null;

  const available = [...new Set(monthly.map((r) => r.period))].sort();
  const period =
    requestedPeriod !== undefined && available.includes(requestedPeriod)
      ? requestedPeriod
      : available[available.length - 1];
  const idx = available.indexOf(period);

  const inPeriod = monthly.filter((r) => r.period === period);

  // A cancelled service keeps being detected forever — the recurring analyzer
  // scans all history with no recency bound — so one Verizon line appeared
  // three times, two of them dead, indistinguishable from the live one.
  // Overview already applies this filter; /insights did not. Judged at the END
  // of the period being read (or now, whichever came first), so a historical
  // month answers "was this still charging then?" rather than "is it today?".
  const asOf = new Date(
    Math.min(periodEndExclusive(period).getTime() - 1, Date.now()),
  );
  const lapsed = (row: { type: string; payload: unknown }) =>
    row.type === "RECURRING_CHARGE" && !isActive(row.payload as RecurringChargePayload, asOf);

  const groups = GROUPS.map((g) => ({
    title: g.title,
    rows: inPeriod
      .filter((r) => r.type === g.type && !lapsed(r))
      .map(toRow)
      .sort((a, b) => Number(a.dismissed) - Number(b.dismissed)),
  }));
  groups.push({
    title: LAPSED_TITLE,
    rows: inPeriod
      .filter(lapsed)
      .map(toRow)
      .sort((a, b) => Number(a.dismissed) - Number(b.dismissed)),
  });

  return {
    period,
    periodLabel: monthLabel(period),
    prevPeriod: idx > 0 ? available[idx - 1] : null,
    nextPeriod: idx < available.length - 1 ? available[idx + 1] : null,
    groups: groups.filter((g) => g.rows.length > 0),
    dismissedCount: inPeriod.filter((r) => r.dismissed).length,
  };
}
