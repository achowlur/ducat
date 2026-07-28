import type {
  AnomalyPayload,
  CashFlowTrendPayload,
  InsightType,
  NetWorthGrowthPayload,
  RecurringChargePayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { prisma } from "../prisma";
import {
  isActive,
  mergeDetectedSubscriptions,
  type DetectedCharge,
} from "../health/detectedSubscriptions";
import { upcomingCommitments, type UpcomingCommitments } from "../health/commitments";
import { computePace, type Pace } from "../insights/pace";
import { periodCoverage, type PeriodCoverage } from "../insights/coverage";
import { periodEndExclusive, periodStart } from "../insights/periods";
import { getAccountCoverage } from "./coverage";
import { monthlyRows, ofType } from "./insightRows";
import { higherThan, money, monthLabel, pct, titleCase } from "./format";

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
  /**
   * What is already committed over the next 30 days — the one forward-looking
   * figure on the page.
   *
   * NULL when the question does not apply: browsing a past month, where "the
   * next 30 days" would be measured from now and answer nothing about the month
   * on screen, or a database with nothing recurring detected at all. Refusing
   * beats printing a number that means something other than it appears to.
   */
  commitments: UpcomingCommitments | null;
  /**
   * Where the month lands. Null for the same reason `commitments` is — it is a
   * question about the month you are living in — and carries its own refusal
   * when the month or the baseline is too thin to speak from.
   */
  pace: Pace | null;
  /** Fetched here so the page doesn't read account coverage a second time. */
  coverage: PeriodCoverage | null;
}

function renderAnomaly(p: AnomalyPayload): InsightRow["text"] {
  return p.kind === "TRANSACTION"
    ? `${titleCase(p.description ?? "Transaction")} — ${money(p.amount)}, ${higherThan(p.percentileOfHistory, `your ${p.categoryName ?? "spending here"}`)} (median ${money(p.typicalAmount)})`
    : `${p.categoryName ?? "Category"} total ${money(p.amount)} — ${higherThan(p.percentileOfHistory, "prior months")} (median ${money(p.typicalAmount)})`;
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
  const monthly = monthlyRows(await prisma.insight.findMany());
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

  // Commitments look FORWARD from now, so they only make sense while the period
  // on screen is the one we are living in. On June's page in July, "due in the
  // next 30 days" would be a July number under a June heading.
  const now = new Date();
  const periodEnd = periodEndExclusive(period);
  const viewingCurrentPeriod = now >= periodStart(period) && now < periodEnd;
  const detected = mergeDetectedSubscriptions(ofType<DetectedCharge>(monthly, "RECURRING_CHARGE").map((r) => r.payload));
  const commitments =
    viewingCurrentPeriod && detected.length > 0 ? upcomingCommitments(detected, now) : null;

  const accountCoverage = await getAccountCoverage();
  const coverageOf = (p: string): PeriodCoverage | null => {
    if (accountCoverage.length === 0) return null;
    try {
      return periodCoverage(p, accountCoverage);
    } catch {
      return null; // unparseable key — nothing useful to say
    }
  };
  const shown = coverageOf(period);

  // Baseline coverage travels WITH the number rather than filtering it out.
  // Excluding incomplete periods was the first instinct and it is wrong here:
  // the newest card was opened part-way through this very month, so every prior
  // period counts as incomplete and the pace call would go dark for months.
  const spendingRows = ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY");
  const thisPeriod = spendingRows.find((r) => r.period === period);
  const priors = spendingRows
    .filter((r) => r.period < period)
    .map((r) => {
      const c = coverageOf(r.period);
      return {
        period: r.period,
        total: r.payload.totalSpending,
        coverage: c === null ? undefined : { covered: c.covered, total: c.total },
      };
    });

  let pace: Pace | null = null;
  if (viewingCurrentPeriod && thisPeriod !== undefined) {
    // Committed to the END OF THIS MONTH, which is a different window from the
    // rolling 30 days above — it is the floor under this month's projection,
    // not the same question.
    const daysLeft = Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000));
    const dueBeforeMonthEnd =
      detected.length > 0 ? upcomingCommitments(detected, now, daysLeft).total : 0;
    pace = computePace({
      period,
      now,
      spentSoFar: thisPeriod.payload.totalSpending,
      committedRemaining: dueBeforeMonthEnd,
      priors,
    });
  }

  return {
    period,
    periodLabel: monthLabel(period),
    prevPeriod: idx > 0 ? available[idx - 1] : null,
    nextPeriod: idx < available.length - 1 ? available[idx + 1] : null,
    groups: groups.filter((g) => g.rows.length > 0),
    dismissedCount: inPeriod.filter((r) => r.dismissed).length,
    commitments,
    pace,
    coverage: shown !== null && !shown.complete ? shown : null,
  };
}
