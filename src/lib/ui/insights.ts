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
  missedCharge,
  nextChargeOf,
  type DetectedCharge,
} from "../health/detectedSubscriptions";
import { upcomingCommitments, type UpcomingCommitments } from "../health/commitments";
import { getSubscriptionStatuses, matchesSubscription } from "../health/subscriptions";
import { computePace, isComparableBaseline, type Pace } from "../insights/pace";
import { anomalyDedupeKey, computeDigest, explainedByOneOffs, type DigestItem } from "../insights/digest";
import { assessGoals, GOAL_RATE_MONTHS, parseGoals, SAVINGS_GOALS_KEY, type GoalAssessment } from "../insights/goals";
import {
  assessReadiness,
  HOUSE_READINESS_KEY,
  nonHousingSpending,
  parseReadiness,
  resolveReadinessRate,
  type ReadinessAssessment,
} from "../insights/readiness";
import { MORTGAGE_RATE_KEY, parseMortgageRate } from "../rates/mortgageRate";
import { DEFAULT_RECURRING_OPTIONS, priceNow } from "../insights/recurring";
import { periodCoverage, type PeriodCoverage } from "../insights/coverage";
import { recentMonths, type RecentMonths } from "../insights/recentMonths";
import { periodEndExclusive, periodKey, periodStart } from "../insights/periods";
import { tripsForPeriod, type TripRow } from "./trips";
import { countsAsCash, readCashAccountIds } from "./liquidity";
import { fundGrowthOver, fundHistory } from "./goalFunds";
import {
  assessNetWorthGoal,
  NET_WORTH_GOAL_KEY,
  parseNetWorthGoal,
  type NetWorthGoalAssessment,
} from "./netWorthGoal";
import { NEW_PAY_KEY, parseNewPay, payLevels } from "./payLevel";
import { getAccountCoverage, getPeriodCoverage } from "./coverage";
import { monthlyRows, ofType } from "./insightRows";
import { priorPeriods } from "./currentPace";
import { selectPeriod } from "./periodNav";
import { isCancelled, livePlans, parseDecisions, riseKept, RECURRING_DECISIONS_KEY, type Decisions } from "./recurringDecisions";
import { recurringAlerts, type RecurringAlert } from "./recurringAlerts";
import { higherThan, money, monthLabel, shortDate, shortDateYear, titleCase } from "./format";

export interface InsightRow {
  id: string;
  type: InsightType;
  dismissed: boolean;
  /**
   * Null when the group heading already says it: seven RECURRING chips under
   * "Recurring charges" told the reader nothing, and diluted the chips that
   * carry a fact (PRICE UP). The tone still colours the row's marker.
   */
  chip: string | null;
  tone: "neg" | "pos" | "neutral";
  /** What the row is about, as a sentence or a name. */
  text: string;
  /** The figures beside it, in reading order; the page sets them in a column. */
  facts: string[];
  /**
   * A live recurring plan's next charge, while the month on screen is the one
   * being lived in: projected from its last real charge, as the commitments
   * window projects it. Absent on every other row.
   */
  next?: { date: Date; daysAway: number; amount: number };
}

export interface InsightsPageData {
  period: string;
  periodLabel: string;
  prevPeriod: string | null;
  nextPeriod: string | null;
  /** A `?period=` the admission rule refused; null when honoured or absent. */
  clampedFrom: string | null;
  /** The month on screen is the one being lived in: the forward-looking panels speak only then. */
  isCurrentPeriod: boolean;
  /**
   * Grouped in display order; empty groups omitted. `note` is a figure for the
   * group as a whole, right-aligned against its heading.
   */
  groups: { title: string; note: string | null; rows: InsightRow[] }[];
  dismissedCount: number;
  /**
   * What on Recurring charges asks the reader to act (ui/recurringAlerts.ts):
   * the first two in view, the rest folded. Empty for a past month and when
   * nothing needs an answer, which is the usual state.
   */
  recurringAlerts: { shown: RecurringAlert[]; folded: RecurringAlert[] };
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
  /**
   * Declared savings goals against the observed savings rate. Empty when none
   * are declared — the section is opt-in config, not a health question every
   * instance has, so there is no quiet state to print. Gated to the current
   * period like pace and commitments: saved and the rate are measured from
   * now, and a projection under a historical heading would lie.
   */
  goals: GoalAssessment[];
  /**
   * House readiness: the PITI budget and the two price ceilings, computed
   * from the declared config (`readiness.house`) against the first savings
   * goal's fund. Null unless a config is declared AND a goal supplies the
   * fund AND the period on screen is the one being lived in — the same
   * opt-in-and-current gate as `goals`, because the means are measured from
   * now and the fund is a live balance.
   */
  readiness: ReadinessAssessment | null;
  /**
   * The declared net worth target, its live progress and two landing dates
   * (ui/netWorthGoal.ts). Null unless declared AND the period on screen is
   * the one being lived in: the same opt-in-and-current gate as `goals`.
   */
  netWorthGoal: NetWorthGoalAssessment | null;
  /**
   * The complete months the savings goals' pace and house readiness average
   * (insights/recentMonths.ts): which were left out as not comparable with
   * today, and which kept ones predate an account's records. Null for a past month.
   */
  projectionWindow: RecentMonths | null;
  /** Each savings goal's fund at past month-ends, by goal id, for its chart; empty for a past month. */
  goalHistory: Record<string, { period: string; value: number }[]>;
  /**
   * Trip/project groups with activity in the VIEWED period — facts (portion,
   * running net, span, link), never analytics: the figures are plain sums of
   * the tagged rows as the group's ledger view lists them, and no analyzer
   * reads the tag. Empty means the section is ABSENT — a group is opt-in
   * content like goals, so an empty heading would imply the engine went
   * looking for trips.
   */
  trips: TripRow[];
  /**
   * True when the period on screen has no insight rows at all — only the
   * admitted current month can be in this state, since every other reachable
   * period earned its place by having rows. The page words its quiet line
   * differently here: "nothing needs attention" is a claim the engine LOOKED,
   * and on a month nothing has synced yet it has not.
   */
  emptyPeriod: boolean;
  /**
   * What the period's spending came to, the headline of a month that is not
   * being lived in (`pace` answers for the one that is), with the period
   * before it for scale. The analyzer's own total, the figure the Spending
   * archive row prints. Null when the period has no spending row: the guard
   * sits on the figure, not on a page gate.
   */
  spent: { total: number; previous: number | null } | null;
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
        text: `${titleCase(item.subject)} ${money(item.amount)}, newly recognised as recurring`,
        consequence: `${perYear} committed`,
        stake: item.stake,
      };
    case "ONE_OFF":
      return {
        chip: "One-off",
        tone: "neutral",
        // The RANK, not just the median it beat. This row now replaces the
        // anomaly row it was promoted from rather than sitting above a second
        // copy, and the rank is the only thing that copy contributed —
        // "higher than N%" is what the anomaly convention requires the UI to
        // show, precisely because a ratio against a heavy-tailed median reads
        // as a claim about what a dinner costs.
        text:
          item.rank === undefined
            ? `${titleCase(item.subject)} ${money(item.amount)}, against ${money(item.baseline ?? 0)} typical`
            : `${titleCase(item.subject)} ${money(item.amount)}, ${higherThan(item.rank.percentileOfHistory, item.rank.of)} (median ${money(item.baseline ?? 0)})`,
        // Deliberately NOT annualised: it happened once, so once is the cost.
        consequence: "one-off, not recurring",
        stake: item.stake,
      };
  }
}

function renderAnomaly(p: AnomalyPayload): InsightRow["text"] {
  return p.kind === "TRANSACTION"
    ? `${titleCase(p.description ?? "Transaction")} ${money(p.amount)}, ${higherThan(p.percentileOfHistory, `your ${p.categoryName ?? "spending here"}`)} (median ${money(p.typicalAmount)})`
    : `${p.categoryName ?? "Category"} total ${money(p.amount)}, ${higherThan(p.percentileOfHistory, "prior months")} (median ${money(p.typicalAmount)})`;
}

// The archive rows below were one punctuated sentence each: "Merchant — price
// · 25 charges · last Sep 4", the same dash-and-dot cadence on every line of
// the page. Each is now a name and a column of facts, the layout the
// commitments panel already used.
type RowBody = Pick<InsightRow, "text" | "facts">;

/** Where a recurring row stands as of the month on screen. */
interface RecurringState {
  /** Under "No longer charging": two cycles with no charge. */
  lapsed: boolean;
  /** The billing date it missed while still listed (missedCharge), or null. */
  missed: Date | null;
  /** The year of the month on screen. */
  year: number;
}

function renderRecurring(p: RecurringChargePayload, tracked: boolean, state: RecurringState): RowBody {
  const price = p.priceIncreased
    ? `raised to ${money(p.lastAmount)} (was ${money(p.previousAverageAmount ?? p.averageAmount)})`
    : `${money(priceNow(p))} ${p.cadence.toLowerCase()}`;
  // shortDate, not the raw ISO string: this line sits among "Jul 9 – Jul 20",
  // "in 3d · Aug 6" and "~September 2028", so a bare 2026-07-06 was the only
  // machine-shaped date on the page. It carries its YEAR under "No longer
  // charging", whose last charges can be any year (a bare "last Mar 3" there
  // could be years old), and wherever the day falls outside the year on screen
  // (a yearly plan, December's charge read in January).
  const day = (d: Date) => (state.lapsed || d.getUTCFullYear() !== state.year ? shortDateYear(d) : shortDate(d));
  return {
    text: titleCase(p.merchant),
    facts: [
      price,
      `${p.occurrences} charges`,
      `last ${day(new Date(`${p.lastDate}T12:00:00Z`))}`,
      ...(state.missed !== null ? [`missed ${day(state.missed)}`] : []),
      // The charges above are the whole plan's, under every descriptor the
      // bank used for it (recurring.ts, continues), so the count is not a
      // surprise beside a name that only covers the newest of them.
      ...(p.aliases !== undefined ? [`billed under ${p.aliases.length + 1} names`] : []),
      ...(tracked ? ["registered"] : []),
    ],
  };
}

/** Named because the annualised total is hung off this group by title. */
const RECURRING_TITLE = "Recurring charges";

/** Named because the digest suppresses rows from this group by title. */
const ANOMALY_TITLE = "Anomalies";

/**
 * The archive rows /insights still prints. Net worth, cash flow and spending
 * by category each printed one row a month that /trends draws better, with a
 * Dismiss that meant nothing; the page now links there instead.
 */
const GROUPS: { type: "ANOMALY" | "RECURRING_CHARGE"; title: string }[] = [
  { type: "ANOMALY", title: ANOMALY_TITLE },
  { type: "RECURRING_CHARGE", title: RECURRING_TITLE },
];
const SHOWN_TYPES = new Set<string>(["ANOMALY", "RECURRING_CHARGE"]);

const LAPSED_TITLE = "No longer charging";

function toRow(
  row: { id: string; type: string; payload: unknown; dismissed: boolean },
  isRegistered: (merchant: string) => boolean,
  asOf: Date,
  decisions: Decisions,
  year: number,
  /** Now, while the month on screen is the one being lived in; null for a past month. */
  now: Date | null,
): InsightRow {
  if (row.type === "ANOMALY") {
    const p = row.payload as AnomalyPayload;
    return { id: row.id, type: "ANOMALY", dismissed: row.dismissed, chip: null, tone: "neg", text: renderAnomaly(p), facts: [] };
  }
  const p = row.payload as RecurringChargePayload;
  const lapsed = !isActive(p, asOf) || isCancelled(p, decisions);
  // A lapsed row has already moved under "No longer charging", which
  // says more than "missed" could.
  const missed = lapsed ? null : missedCharge(p, asOf);
  // A plan that lapsed or missed its date has no next charge to promise.
  const next = now !== null && !lapsed && missed === null ? nextChargeOf(p, now) : undefined;
  return {
    id: row.id,
    type: "RECURRING_CHARGE",
    dismissed: row.dismissed,
    // MISSED outranks PRICE UP: a raised price that is no longer being
    // charged is the lesser news, and the price fact still says it.
    chip: missed !== null ? "Missed" : p.priceIncreased ? "Price up" : null,
    tone: missed === null && p.priceIncreased ? "neg" : "neutral",
    ...renderRecurring(p, isRegistered(p.merchant), { lapsed, missed, year }),
    ...(next !== undefined ? { next } : {}),
  };
}

export async function getInsightsPageData(requestedPeriod?: string): Promise<InsightsPageData | null> {
  // One `now` for the whole request: the period admission, the current-period
  // gate and the commitment windows must agree on which month is being lived
  // in, or a render straddling midnight could admit one month and gate another.
  const now = new Date();
  // Anomalies are the bulk of the Insight table (one per category per month)
  // and the page shows one month of them, so it reads the month it expects to
  // land on and fetches another only when the selection lands elsewhere.
  const expected = requestedPeriod !== undefined && /^d{4}-d{2}$/.test(requestedPeriod) ? requestedPeriod : periodKey(now, "MONTH");
  const [insightRows, registered, settingRows, accountRows, cashIds, taggedRows] = await Promise.all([
    prisma.insight.findMany({
      where: { OR: [{ type: { not: "ANOMALY" } }, { type: "ANOMALY", period: expected }] },
    }),
    getSubscriptionStatuses(prisma),
    // Goals, readiness config and the stored rate observation in ONE
    // statement — on Turso the count of round trips is the cost, so four
    // findUniques would pay for three reads nobody needs.
    prisma.setting.findMany({
      where: { key: { in: [SAVINGS_GOALS_KEY, NET_WORTH_GOAL_KEY, HOUSE_READINESS_KEY, MORTGAGE_RATE_KEY, NEW_PAY_KEY, RECURRING_DECISIONS_KEY] } },
    }),
    // Balances for the goal funds. Unconditional rather than gated on the
    // setting existing: a gate costs about its own round trip anyway, and
    // this joins the concurrent group instead. `type` is here so a cash goal
    // can resolve the operator's cash definition from the same rows.
    // Ordered like set-goals' listing: a cash goal's account names render in
    // declaration-independent order, and unordered findMany is unspecified.
    prisma.account.findMany({ select: { id: true, name: true, balance: true, type: true }, orderBy: { institution: 'asc' } }),
    readCashAccountIds(prisma),
    // Every tagged row, for the TRIPS section — four scalar columns over the
    // few rows that carry a tag, joining the concurrent group (one round
    // trip, no gate: a gate would cost about what it saves).
    prisma.transaction.findMany({
      // `>= ""` rather than `not: null`: SQLite plans IS NOT NULL as a scan of
      // the table, and a range on the label's index reads only the tagged rows.
      where: { groupLabel: { gte: "" } },
      select: { groupLabel: true, date: true, amount: true, flow: true },
    }),
  ]);
  const settingValue = (key: string) => settingRows.find((r) => r.key === key)?.value ?? null;
  // What the operator answered on Recurring charges' alerts: a cancelled plan
  // is treated as a lapsed one everywhere below.
  const decisions = parseDecisions(settingValue(RECURRING_DECISIONS_KEY));
  const selection = selectPeriod(
    monthlyRows(insightRows).map((r) => r.period),
    requestedPeriod,
    now,
  );
  if (selection === null) return null;
  const { period, prevPeriod, nextPeriod, clampedFrom } = selection;
  const landedAnomalies =
    period === expected ? [] : await prisma.insight.findMany({ where: { type: "ANOMALY", period } });
  const monthly = monthlyRows([...insightRows, ...landedAnomalies]);
  // Same predicate the commitments fold uses, so a row cannot read "registered"
  // while the panel below bills it a second time as undetected.
  const isRegistered = (merchant: string) =>
    registered.some((s) => s.enabled && matchesSubscription(s.merchantPattern, merchant));

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
    row.type === "RECURRING_CHARGE" &&
    (!isActive(row.payload as RecurringChargePayload, asOf) || isCancelled(row.payload as RecurringChargePayload, decisions));
  // A day in this year prints without one (renderRecurring).
  const year = Number(period.slice(0, 4));

  // Read before the rows are built: a live plan's next charge is only
  // projected for the month being lived in.
  const viewingNow = now >= periodStart(period) && now < periodEndExclusive(period);

  // Built here because the rows lose their payload the moment they become
  // InsightRows, and the suppression below needs the identity, not the prose.
  const anomalyKeyByRowId = new Map<string, string | null>(
    inPeriod
      .filter((r) => r.type === "ANOMALY")
      .map((r) => [r.id, anomalyDedupeKey(r.payload as unknown as AnomalyPayload)]),
  );

  const groups = GROUPS.map((g) => ({
    title: g.title,
    note: null as string | null,
    rows: inPeriod
      .filter((r) => r.type === g.type && !lapsed(r))
      .map((r) => toRow(r, isRegistered, asOf, decisions, year, viewingNow ? now : null))
      .sort((a, b) => Number(a.dismissed) - Number(b.dismissed)),
  }));
  groups.push({
    title: LAPSED_TITLE,
    note: null,
    rows: inPeriod
      .filter(lapsed)
      .map((r) => toRow(r, isRegistered, asOf, decisions, year, null))
      .sort((a, b) => Number(a.dismissed) - Number(b.dismissed)),
  });

  // Commitments look FORWARD from now, so they only make sense while the period
  // on screen is the one we are living in. On June's page in July, "due in the
  // next 30 days" would be a July number under a June heading.
  const periodEnd = periodEndExclusive(period);
  const viewingCurrentPeriod = now >= periodStart(period) && now < periodEnd;
  const detected = mergeDetectedSubscriptions(ofType<DetectedCharge>(monthly, "RECURRING_CHARGE").map((r) => r.payload));
  const commitments =
    viewingCurrentPeriod && (detected.length > 0 || registered.length > 0)
      ? upcomingCommitments(detected, registered, now, 30, (sub) => isCancelled(sub, decisions))
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
  //
  // A charge that MISSED its billing date stays listed, flagged, but is not
  // projected for a year: the commitments panel already stopped counting it,
  // and the two projections on one page must agree on what is still billing.
  const activeThisPeriod = inPeriod
    .filter((r) => r.type === "RECURRING_CHARGE" && !lapsed(r))
    .map((r) => r.payload as unknown as DetectedCharge)
    .filter((c) => missedCharge(c, asOf) === null);
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
  // The DISPLAYED notice comes from getPeriodCoverage, which loads what each
  // short account actually contributed. coverageOf is kept for the baseline
  // maths below, which only needs covered/total — but using it for the notice
  // too meant every gap fell through to NO_DATA, so /insights called July
  // "understated by an unknown amount" while /trends called the same month
  // "not directly comparable … contributing $104.32". One month, two claims.
  const shown = await getPeriodCoverage(period);

  // Baseline coverage travels WITH the number rather than filtering it out.
  // Excluding incomplete periods was the first instinct and it is wrong here:
  // the newest card was opened part-way through this very month, so every prior
  // period counts as incomplete and the pace call would go dark for months.
  const spendingRows = ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY");
  const thisPeriod = spendingRows.find((r) => r.period === period);
  const priors = priorPeriods(spendingRows, period, coverageOf);

  // Same comparability gate as the pace call, from the same function: two
  // answers to "is this month comparable?" on one screen would be one too many.
  const comparablePriors = spendingRows
    .filter((r) => r.period < period)
    .filter((r) => {
      const c = coverageOf(r.period);
      return isComparableBaseline(c === null ? undefined : { covered: c.covered, total: c.total });
    })
    .map((r) => r.payload);

  const alerts = viewingCurrentPeriod
    ? recurringAlerts(
        livePlans(
          inPeriod
            .filter((r) => r.type === "RECURRING_CHARGE" && !r.dismissed)
            .map((r) => r.payload as unknown as DetectedCharge),
          decisions,
          asOf,
        ),
        decisions,
        now,
      )
    : { shown: [], folded: [] };

  const digestItems = computeDigest({
    spending: thisPeriod?.payload ?? null,
    priorSpending: comparablePriors,
    // Dismissed rows do not get to lead the page — dismissing one is a
    // statement that it does not need attention.
    recurring: inPeriod
      .filter((r) => r.type === "RECURRING_CHARGE" && !r.dismissed && !lapsed(r))
      .map((r) => r.payload as unknown as RecurringChargePayload)
      // A rise the operator kept is no longer news, here or in the alerts.
      .map((p) => (riseKept(p, decisions) ? { ...p, priceIncreased: false } : p)),
    anomalies: inPeriod
      .filter((r) => r.type === "ANOMALY" && !r.dismissed)
      .map((r) => r.payload as unknown as AnomalyPayload),
    minOccurrences: DEFAULT_RECURRING_OPTIONS.minOccurrences,
  });
  const digest = digestItems.map(renderDigest);

  /**
   * A finding the digest LED with does not also appear as a row below it.
   *
   * The two read the same insights, so a promoted one printed twice about
   * 400px apart, in different words and a different order — and for a
   * category, against a different baseline: July's Groceries led with
   * "$448.89, against $107.12 in comparable months" and reappeared as "total
   * $448.89 — higher than all prior months (median $78.24)". Two medians for
   * one category on one screen. Both are right (the digest measures against
   * COMPARABLE periods, the anomaly against ALL history) and that is exactly
   * why showing both without a word of explanation is worse than showing one.
   *
   * The digest wins because it is the page's lead and it ranks by what the
   * finding COSTS, and because digest.ts already decided this for the
   * category case — "CATEGORY_TOTAL anomalies are left out: category movement
   * is already covered above, and better" — a decision that governed what
   * entered the digest and never reached what the stream printed.
   *
   * Nothing is lost: the promoted row now carries the rank ("higher than N%")
   * that was the anomaly stream's own contribution. Dismissed anomalies never
   * enter the digest, so they are never suppressed by it — they stay where a
   * reader who asks for dismissed rows expects them.
   */
  const promoted = new Set(
    digestItems.map((i) => i.dedupeKey).filter((k): k is string => k !== null),
  );
  const anomalyGroup = groups.find((g) => g.title === ANOMALY_TITLE);
  if (anomalyGroup !== undefined && promoted.size > 0) {
    anomalyGroup.rows = anomalyGroup.rows.filter((r) => {
      const key = anomalyKeyByRowId.get(r.id);
      return key === undefined || key === null || !promoted.has(key);
    });
  }

  // A category total the digest's ONE-OFF explains is the same money told
  // twice: once the redesign set the anomalies directly under the digest,
  // "Brightline Electronics $1,249.00, one-off" sat on the line above
  // "Shopping total $1,249.00, higher than all prior months". Left out when
  // the category, without the one-offs the digest leads with, is no higher
  // than its median; a total still unusual without them keeps its row.
  if (anomalyGroup !== undefined && promoted.size > 0) {
    const explained = explainedByOneOffs(
      inPeriod
        .filter((r) => r.type === "ANOMALY")
        .map((r) => ({ id: r.id, payload: r.payload as unknown as AnomalyPayload })),
      promoted,
    );
    anomalyGroup.rows = anomalyGroup.rows.filter((r) => !explained.has(r.id));
  }

  let pace: Pace | null = null;
  if (viewingCurrentPeriod && thisPeriod !== undefined) {
    // Committed to the END OF THIS MONTH, which is a different window from the
    // rolling 30 days above — it is the floor under this month's projection,
    // not the same question.
    const daysLeft = Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000));
    const dueBeforeMonthEnd = upcomingCommitments(detected, registered, now, daysLeft, (sub) => isCancelled(sub, decisions)).total;
    pace = computePace({
      period,
      now,
      spentSoFar: thisPeriod.payload.totalSpending,
      committedRemaining: dueBeforeMonthEnd,
      priors,
    });
  }

  // Complete months only — the period on screen is the current one whenever
  // this runs, so everything before it is complete. Same shape Overview feeds
  // computeRunway, with `net` where runway takes `totalSpending`.
  const declaredGoals = parseGoals(settingValue(SAVINGS_GOALS_KEY));
  const goalAccounts = accountRows.map((a) => ({ id: a.id, name: a.name, balance: Number(a.balance) }));
  const cashAccountRows = accountRows.filter((a) =>
    countsAsCash({ id: a.id, type: a.type, balance: Number(a.balance) }, cashIds),
  );
  const completeCashFlow = ofType<CashFlowTrendPayload>(monthly, "CASH_FLOW_TREND").filter(
    (r) => r.period < period,
  );
  // Pay as it is now (payLevel.ts): every paycheck on record, the month being
  // lived in included, so a raise this month is seen; earlier paychecks are
  // topped up to it, and one-off pay is left out, in every pace below.
  const pay = payLevels(
    ofType<CashFlowTrendPayload>(monthly, "CASH_FLOW_TREND").flatMap((r) => r.payload.paychecks ?? []),
    parseNewPay(settingValue(NEW_PAY_KEY)),
  );
  const regular = (r: { period: string; payload: CashFlowTrendPayload }) =>
    (pay.topUps[r.period] ?? 0) - (r.payload.oneOffIncome ?? 0);
  // The months the paces and readiness average: the last six complete ones,
  // less any from before too many of today's accounts' records begin.
  const projectionWindow = recentMonths(
    completeCashFlow.map((r) => r.period),
    accountCoverage.map((a) => a.firstTransaction),
  );
  const windowFlow = completeCashFlow.filter((r) => projectionWindow.used.includes(r.period));

  // Complete month-ends as the NET_WORTH_GROWTH rows record them, each
  // account's value included: the net worth goal reads them, and so do the
  // savings goals' charts and the cash reconciliation below.
  const netWorthMonths = ofType<NetWorthGrowthPayload>(monthly, "NET_WORTH_GROWTH")
    .filter((r) => r.period < period)
    .map(({ period: p, payload }) => ({
      period: p,
      value: payload.netWorth,
      estimated: payload.estimatedAccountIds.length > 0,
      leftOut: payload.excludedAccountIds ?? [],
      marketGains: payload.marketGains ?? null,
      byAccount: payload.byAccount ?? null,
      flowsByAccount: payload.investmentFlowsByAccount ?? null,
      interestByAccount: payload.interestByAccount ?? null,
    }));

  // The reconciliation a cash goal's projection owes: the rate assumes every
  // saved dollar stays in cash, and a standing transfer out makes the landing
  // optimistic — so measure what cash ACTUALLY did over the SAME window the
  // rate averages. Measured from the fund's month-end BALANCES, the figures
  // its chart draws. Summing its transactions was right only while every
  // cash account was a bank account: an investment account counted as cash
  // books its trades and sweeps as rows, and the sum said a fund that was
  // growing had been shrinking every month. The transaction sum
  // remains only for rows stored before per-account values existed.
  let observedCashGrowth: number | null = null;
  const basisKeys = projectionWindow.used;
  // A cash goal's fund is cash AFTER the cards it pays: its balance, its
  // record and its reconciliation all count the cards' balances against it.
  const cardRows = accountRows.filter((a) => a.type === "CREDIT");
  const cashFundIds = [...cashAccountRows, ...cardRows].map((a) => a.id);
  const fromBalances =
    viewingCurrentPeriod && declaredGoals.some((g) => g.cash === true)
      ? fundGrowthOver(netWorthMonths, cashFundIds, basisKeys)
      : null;
  if (fromBalances !== null) {
    observedCashGrowth = fromBalances;
  } else if (viewingCurrentPeriod && declaredGoals.some((g) => g.cash === true) && basisKeys.length > 0) {
    const grown = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        accountId: { in: cashFundIds },
        date: { gte: periodStart(basisKeys[0]), lt: periodStart(period) },
      },
    });
    observedCashGrowth = Number(grown._sum.amount ?? 0) / basisKeys.length;
  }

  const goals =
    viewingCurrentPeriod && declaredGoals.length > 0
      ? assessGoals({
          goals: declaredGoals,
          accounts: goalAccounts,
          // The same cash definition Overview's CASH figure uses — resolved
          // here, at render, so a cash goal tracks whatever the operator's
          // declaration says TODAY, not what it said at declaration time.
          cashAccounts: cashAccountRows.map((a) => ({ id: a.id, name: a.name, balance: Number(a.balance) })),
          cards: cardRows.map((a) => ({ id: a.id, name: a.name, balance: Number(a.balance) })),
          // One-off pay (a bonus beside a paycheck) left out, paychecks at today's pay.
          // Only the comparable months, so a month before a card's records
          // began is not averaged in as a cheap one.
          completeMonthlyNet: windowFlow.map((r) => r.payload.net + regular(r)),
          observedCashGrowth,
          now,
        })
      : [];

  // The net worth goal: live progress against the target, dates from the
  // last complete month-end. Everything it reads is already loaded (the
  // NET_WORTH_GROWTH rows, the balances, the cash definition): no round trip.
  const declaredNetWorthGoal = parseNetWorthGoal(settingValue(NET_WORTH_GOAL_KEY));
  const netWorthGoal =
    viewingCurrentPeriod && declaredNetWorthGoal !== null
      ? assessNetWorthGoal({
          goal: declaredNetWorthGoal,
          // Overview's headline, the signed sum of every balance.
          liveNetWorth: accountRows.reduce((sum, a) => sum + Number(a.balance), 0),
          months: netWorthMonths,
          // Invested money is what a market return applies to: investment
          // accounts OUTSIDE the cash definition, so an account the operator
          // counts as cash is never credited with a stock return.
          investedIds: new Set(
            accountRows
              .filter((a) => a.type === "INVESTMENT" && !countsAsCash({ id: a.id, type: a.type, balance: Number(a.balance) }, cashIds))
              .map((a) => a.id),
          ),
          // What cash earns is measured per account in the same definition.
          cashAccounts: cashAccountRows.map((a) => ({ id: a.id, name: a.name })),
          liveCash: cashAccountRows.map((a) => ({ id: a.id, balance: Number(a.balance) })),
          monthlySpending: completeCashFlow.map((r) => r.payload.spending),
          oneOffs: Object.fromEntries(completeCashFlow.map((r) => [r.period, r.payload.oneOffPay ?? []])),
          pay,
        })
      : null;

  // Each savings goal's fund, month-end by month-end, for its chart: the
  // per-account values the net worth rows carry, summed over the fund's
  // accounts (the cash definition TODAY for a cash goal, as its balance is).
  // Only the months the saving pace is measured over, plus the month-end
  // before them: the definition is today's, and further back it draws a
  // history the fund never had. An account counted as cash now held a
  // brokerage's shares until a reshuffle, and a longer line climbed to many
  // times the fund and fell off a cliff that was never the fund's.
  const goalHistory: Record<string, { period: string; value: number }[]> = {};
  if (viewingCurrentPeriod) {
    for (const g of declaredGoals) {
      goalHistory[g.id] = fundHistory(netWorthMonths, g.cash === true ? cashFundIds : g.accountIds, GOAL_RATE_MONTHS + 1);
    }
  }

  // House readiness: the residual form, built PER MONTH before averaging.
  // Income comes from the same complete cash-flow months the goal rate uses;
  // non-housing is that month's totalSpending minus its Rent & Housing row
  // (nonHousingSpending — absent means $0 housing, a negative refund month
  // pushes non-housing above the total, both correct arithmetic). A month
  // with no spending row at all falls back to the cash-flow spending figure,
  // which equals totalSpending by construction (both are the app's one net
  // spending number), with housing unknown — i.e. $0, the same reading.
  // The FUND is the FIRST declared goal's assessed balance — the model
  // measures readiness of the declared plan, so no goal means no fund and no
  // panel, exactly like no config.
  // The rate is TYPED-FIRST: a personal quote in the stored config outranks
  // the fetched index (a national average is nobody's actual rate), and with
  // neither a typed rate nor a stored observation the resolver returns null —
  // no panel, no invented rate, exactly the pre-fetcher behavior.
  const storedReadiness = parseReadiness(settingValue(HOUSE_READINESS_KEY));
  const storedRate = parseMortgageRate(settingValue(MORTGAGE_RATE_KEY));
  const readinessConfig =
    storedReadiness === null
      ? null
      : resolveReadinessRate(storedReadiness, storedRate?.observation ?? null);
  let readiness: ReadinessAssessment | null = null;
  // NO_ACCOUNTS forces the goal's saved to 0 as BROKEN CONFIG, not $0 saved —
  // feeding it through would render "the $0.00 fund caps you at ~$0.00" as if
  // that were a readiness verdict. A rate refusal on the goal is different:
  // the fund's balance is still real, and readiness has its own refusals.
  if (
    viewingCurrentPeriod &&
    readinessConfig !== null &&
    goals.length > 0 &&
    goals[0].refusal !== 'NO_ACCOUNTS'
  ) {
    const spendingByPeriod = new Map(spendingRows.map((r) => [r.period, r.payload]));
    // What the fund itself earns ends with the purchase that spends it, so it
    // is no part of the budget the payment comes out of.
    const fundIds = goals[0].goal.cash === true ? cashFundIds : goals[0].goal.accountIds;
    const fundEarned = (r: { payload: CashFlowTrendPayload }) =>
      fundIds.reduce((sum, id) => sum + (r.payload.earnedByAccount?.[id] ?? 0), 0);
    readiness = assessReadiness({
      config: readinessConfig,
      fund: goals[0].saved,
      // Regular pay at today's amount: a bonus month is not a budget, and a
      // raise is. The fund's own interest left out.
      completeMonthlyIncome: windowFlow.map((r) => r.payload.income + regular(r) - fundEarned(r)),
      completeMonthlyNonHousing: windowFlow.map((r) => {
        const s = spendingByPeriod.get(r.period);
        return s === undefined ? r.payload.spending : nonHousingSpending(s);
      }),
    });
  }

  // Trips are a VIEW over rows, so they need no insight row from the period —
  // a group is shown wherever its rows actually landed, which is the whole
  // point: a March trip paid across February and March appears on both pages,
  // and neither month lies.
  const trips = tripsForPeriod(
    taggedRows
      .filter((t): t is typeof t & { groupLabel: string } => t.groupLabel !== null)
      .map((t) => ({ groupLabel: t.groupLabel, date: t.date, amount: Number(t.amount), flow: t.flow })),
    period,
  );

  return {
    period,
    periodLabel: monthLabel(period),
    prevPeriod,
    nextPeriod,
    clampedFrom,
    isCurrentPeriod: viewingCurrentPeriod,
    groups: groups.filter((g) => g.rows.length > 0),
    dismissedCount: inPeriod.filter((r) => r.dismissed && SHOWN_TYPES.has(r.type)).length,
    recurringAlerts: alerts,
    commitments,
    pace,
    coverage: shown !== null && !shown.complete ? shown : null,
    digest,
    goals,
    readiness,
    netWorthGoal,
    projectionWindow: viewingCurrentPeriod ? projectionWindow : null,
    goalHistory,
    trips,
    emptyPeriod: inPeriod.length === 0,
    spent:
      thisPeriod === undefined
        ? null
        : { total: thisPeriod.payload.totalSpending, previous: thisPeriod.payload.previousTotalSpending },
  };
}
