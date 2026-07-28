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
  annualisedTotal,
  isActive,
  mergeDetectedSubscriptions,
  type DetectedCharge,
} from "../health/detectedSubscriptions";
import { upcomingCommitments, type UpcomingCommitments } from "../health/commitments";
import { getSubscriptionStatuses, matchesSubscription } from "../health/subscriptions";
import { computePace, isComparableBaseline, type Pace } from "../insights/pace";
import { computeDigest, type DigestItem } from "../insights/digest";
import { DEFAULT_RECURRING_OPTIONS } from "../insights/recurring";
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
  /**
   * Grouped in display order; empty groups omitted. `note` is a figure for the
   * group as a whole, right-aligned against its heading.
   */
  groups: { title: string; note: string | null; rows: InsightRow[] }[];
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
  /**
   * The few things worth leading with, ranked by what they cost over a year.
   * Empty is a real answer and gets said out loud, not hidden.
   */
  digest: DigestRow[];
}

export interface DigestRow {
  chip: string;
  tone: InsightRow["tone"];
  /** What changed. */
  text: string;
  /** The forward consequence — what earned it the slot. */
  consequence: string;
  stake: number;
}

function renderDigest(item: DigestItem): DigestRow {
  const perYear = `${money(item.stake)}/yr`;
  switch (item.kind) {
    case "CATEGORY_DRIFT":
      return {
        chip: "Trending up",
        tone: "neg",
        text: `${item.subject} ${money(item.amount)}, against ${money(item.baseline ?? 0)} in comparable months`,
        consequence: `${perYear} if it holds`,
        stake: item.stake,
      };
    case "PRICE_RISE":
      return {
        chip: "Price up",
        tone: "neg",
        text: `${titleCase(item.subject)} raised to ${money(item.amount)} from ${money(item.baseline ?? 0)}`,
        consequence: `${perYear} more than before`,
        stake: item.stake,
      };
    case "NEW_COMMITMENT":
      return {
        chip: "New",
        tone: "neutral",
        text: `${titleCase(item.subject)} ${money(item.amount)} — newly recognised as recurring`,
        consequence: `${perYear} committed`,
        stake: item.stake,
      };
    case "ONE_OFF":
      return {
        chip: "One-off",
        tone: "neutral",
        text: `${titleCase(item.subject)} ${money(item.amount)}, against ${money(item.baseline ?? 0)} typical`,
        // Deliberately NOT annualised: it happened once, so once is the cost.
        consequence: "one-off, not recurring",
        stake: item.stake,
      };
  }
}

function renderAnomaly(p: AnomalyPayload): InsightRow["text"] {
  return p.kind === "TRANSACTION"
    ? `${titleCase(p.description ?? "Transaction")} — ${money(p.amount)}, ${higherThan(p.percentileOfHistory, `your ${p.categoryName ?? "spending here"}`)} (median ${money(p.typicalAmount)})`
    : `${p.categoryName ?? "Category"} total ${money(p.amount)} — ${higherThan(p.percentileOfHistory, "prior months")} (median ${money(p.typicalAmount)})`;
}

function renderRecurring(p: RecurringChargePayload, tracked: boolean): InsightRow["text"] {
  const price = p.priceIncreased
    ? `raised to ${money(p.lastAmount)} (was ${money(p.previousAverageAmount ?? p.averageAmount)})`
    : `${money(p.averageAmount)} ${p.cadence.toLowerCase()}`;
  return `${titleCase(p.merchant)} — ${price} · ${p.occurrences} charges · last ${p.lastDate}${
    tracked ? " · registered" : ""
  }`;
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

/** Named because the annualised total is hung off this group by title. */
const RECURRING_TITLE = "Recurring charges";

const GROUPS: { type: InsightType; title: string }[] = [
  { type: "ANOMALY", title: "Anomalies" },
  { type: "RECURRING_CHARGE", title: RECURRING_TITLE },
  { type: "NET_WORTH_GROWTH", title: "Net worth" },
  { type: "CASH_FLOW_TREND", title: "Cash flow" },
  { type: "SPENDING_BY_CATEGORY", title: "Spending by category" },
];

const LAPSED_TITLE = "No longer charging";

function toRow(
  row: { id: string; type: string; payload: unknown; dismissed: boolean },
  isRegistered: (merchant: string) => boolean,
): InsightRow {
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
        text: renderRecurring(p, isRegistered(p.merchant)),
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
  const [insightRows, registered] = await Promise.all([
    prisma.insight.findMany(),
    getSubscriptionStatuses(prisma),
  ]);
  const monthly = monthlyRows(insightRows);
  if (monthly.length === 0) return null;
  // Same predicate the commitments fold uses, so a row cannot read "registered"
  // while the panel below bills it a second time as undetected.
  const isRegistered = (merchant: string) =>
    registered.some((s) => s.enabled && matchesSubscription(s.merchantPattern, merchant));

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
    note: null as string | null,
    rows: inPeriod
      .filter((r) => r.type === g.type && !lapsed(r))
      .map((r) => toRow(r, isRegistered))
      .sort((a, b) => Number(a.dismissed) - Number(b.dismissed)),
  }));
  groups.push({
    title: LAPSED_TITLE,
    note: null,
    rows: inPeriod
      .filter(lapsed)
      .map((r) => toRow(r, isRegistered))
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
    viewingCurrentPeriod && (detected.length > 0 || registered.length > 0)
      ? upcomingCommitments(detected, registered, now)
      : null;

  // What the live recurring set costs a year. It moved here when Overview
  // narrowed to state, and it is a PROJECTION — so it is gated to the period
  // being lived in, like the pace call and the commitments panel, rather than
  // printed under a historical heading where it would describe a year that is
  // partly already over.
  //
  // Totalled over the MERGED set while the rows below are per-insight: one
  // subscription reaching the analyzer under three merchant strings is three
  // rows but one bill, and the sum of the rows would be triple the truth. The
  // two agree on this database (2 active charges, 2 after merge) and the merge
  // is what keeps them agreeing when they stop.
  const activeThisPeriod = inPeriod
    .filter((r) => r.type === "RECURRING_CHARGE" && !lapsed(r))
    .map((r) => r.payload as unknown as DetectedCharge);
  const recurringGroup = groups.find((g) => g.title === RECURRING_TITLE);
  if (recurringGroup !== undefined && viewingCurrentPeriod && activeThisPeriod.length > 0) {
    recurringGroup.note = `${money(annualisedTotal(mergeDetectedSubscriptions(activeThisPeriod)))}/yr`;
  }

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

  // Same comparability gate as the pace call, from the same function: two
  // answers to "is this month comparable?" on one screen would be one too many.
  const comparablePriors = spendingRows
    .filter((r) => r.period < period)
    .filter((r) => {
      const c = coverageOf(r.period);
      return isComparableBaseline(c === null ? undefined : { covered: c.covered, total: c.total });
    })
    .map((r) => r.payload);

  const digest = computeDigest({
    spending: thisPeriod?.payload ?? null,
    priorSpending: comparablePriors,
    // Dismissed rows do not get to lead the page — dismissing one is a
    // statement that it does not need attention.
    recurring: inPeriod
      .filter((r) => r.type === "RECURRING_CHARGE" && !r.dismissed && !lapsed(r))
      .map((r) => r.payload as unknown as RecurringChargePayload),
    anomalies: inPeriod
      .filter((r) => r.type === "ANOMALY" && !r.dismissed)
      .map((r) => r.payload as unknown as AnomalyPayload),
    minOccurrences: DEFAULT_RECURRING_OPTIONS.minOccurrences,
  }).map(renderDigest);

  let pace: Pace | null = null;
  if (viewingCurrentPeriod && thisPeriod !== undefined) {
    // Committed to the END OF THIS MONTH, which is a different window from the
    // rolling 30 days above — it is the floor under this month's projection,
    // not the same question.
    const daysLeft = Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000));
    const dueBeforeMonthEnd = upcomingCommitments(detected, registered, now, daysLeft).total;
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
    digest,
  };
}
