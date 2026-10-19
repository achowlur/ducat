/**
 * The month's recap on Overview: during the first days of a month, three
 * figures for the month that just closed. It is a RECAP, not an alert: nothing
 * in it asks for an answer, so it does not wear ActionAlert.
 *
 * Every figure is another screen's own, never a second definition:
 *   - Spent: spendingBreakdown's total, as Overview and /insights print it,
 *     against the middle of the comparable months before it (recentMonths).
 *   - Net worth: growthBetween's split, the "saved" /trends prints, with
 *     markets and accounts joining named apart.
 *   - The goal: the net worth goal's date and shift as /insights assesses it,
 *     else the first savings goal's landing.
 * Any of the three can be absent (analyzers legitimately emit nothing); the
 * recap states the absence in words and never reads one as zero.
 */
import type {
  CashFlowTrendPayload,
  NetWorthGrowthPayload,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { assessGoals, GOAL_RATE_MIN_MONTHS, monthsAfterTarget, parseGoals, type GoalAssessment } from "../insights/goals";
import { previousPeriodKey, periodKey } from "../insights/periods";
import { P2P_UNREVIEWED_ID } from "../p2p";
import { recentMonths } from "../insights/recentMonths";
import { median, round2 } from "../insights/stats";
import { monthLabel, shortMonthLabel } from "./format";
import { ofType, type InsightLike } from "./insightRows";
import { growthBetween, type NetWorthPoint } from "./netWorthGrowth";
import { assessNetWorthGoal, parseNetWorthGoal, type NetWorthGoalAssessment } from "./netWorthGoal";
import { parseNewPay, payLevels } from "./payLevel";
import { spendingBreakdown } from "./spendingBreakdown";

/** The recap speaks on days 1 to 7 of a month (UTC, like every period key). */
export const RECAP_LAST_DAY = 7;

/** Months a "typical" month needs behind it before the recap prints one. */
export const RECAP_MIN_TYPICAL_MONTHS = 3;

/** A category has to run at least this far over typical to be named. */
export const RECAP_MOVED_MIN = 25;

/** The month the recap is about, or null outside days 1 to 7. */
export function recapPeriod(now: Date): string | null {
  return now.getUTCDate() <= RECAP_LAST_DAY ? previousPeriodKey(periodKey(now, "MONTH")) : null;
}

export interface RecapSpent {
  total: number;
  /** The middle of the comparable months before; null with fewer than RECAP_MIN_TYPICAL_MONTHS. */
  typical: number | null;
  /** total less typical (negative = under); null when typical is. */
  vsTypical: number | null;
  /** What to discount, in words; null when nothing. */
  caveat: string | null;
}

export interface RecapNetWorth {
  change: number;
  saved: number;
  markets: number;
  /** Accounts joining the total; 0 when none did. */
  joined: number;
  caveat: string | null;
}

export interface RecapGoal {
  name: string;
  /** "Aug 2027"; null when no date can be given. */
  lands: string | null;
  /** Words under the date. */
  sub: string;
}

export interface RecapMoved {
  category: string;
  spending: number;
  typical: number;
  over: number;
}

export interface MonthRecap {
  period: string;
  /** "September". */
  monthName: string;
  /** Null when the month has no spending row. */
  spent: RecapSpent | null;
  /** Null when the month, or the one before it, has no net worth row. */
  netWorth: RecapNetWorth | null;
  /** Null when no goal is declared. */
  goal: RecapGoal | null;
  /** Null when no category ran over typical, or there is no typical to measure against. */
  moved: RecapMoved | null;
}

export interface RecapSettings {
  netWorthGoal: string | null;
  savingsGoals: string | null;
  newPay: string | null;
}

export interface RecapInput {
  now: Date;
  /** Month-granularity insight rows: net worth, spending and cash flow. */
  rows: InsightLike[];
  accounts: { id: string; name: string; type: string; balance: number }[];
  /** Accounts the operator counts as cash, by id, resolved by liquidity.countsAsCash. */
  cashAccountIds: ReadonlySet<string>;
  /** Where each account's records begin (recentMonths' coverage input). */
  firstRecords: readonly (Date | null)[];
  settings: RecapSettings;
}

const monthsPhrase = (n: number) => `${n} month${n === 1 ? "" : "s"}`;

function shiftWords(shift: number | null): string {
  if (shift === null) return "";
  if (shift === 0) return "same date as a month ago";
  return shift < 0 ? `${monthsPhrase(-shift)} sooner` : `${monthsPhrase(shift)} later`;
}

function netWorthGoalRecap(a: NetWorthGoalAssessment): RecapGoal {
  const name = "Net worth goal";
  if (a.reached) return { name, lands: null, sub: "reached" };
  if (a.saving === null) return { name, lands: null, sub: "needs more months of history" };
  if (a.saving.lands === null) return { name, lands: null, sub: "no date at the current pace" };
  return { name, lands: shortMonthLabel(a.saving.lands), sub: shiftWords(a.saving.shift) };
}

function savingsGoalRecap(a: GoalAssessment): RecapGoal {
  const name = a.goal.name;
  if (a.reached) return { name, lands: null, sub: "reached" };
  if (a.refusal === "TOO_FEW_MONTHS") {
    return { name, lands: null, sub: `needs ${GOAL_RATE_MIN_MONTHS} months of history` };
  }
  if (a.refusal !== null || a.landsMonth === null) return { name, lands: null, sub: "no date at the current pace" };
  const after = monthsAfterTarget(a.landsMonth, a.goal.targetMonth);
  const sub =
    after === null
      ? ""
      : after === 0
        ? "on its target month"
        : after < 0
          ? `${monthsPhrase(-after)} ahead of target`
          : `${monthsPhrase(after)} behind target`;
  return { name, lands: shortMonthLabel(a.landsMonth), sub };
}

export function buildMonthRecap(input: RecapInput): MonthRecap | null {
  const { now, rows, accounts, settings } = input;
  const period = recapPeriod(now);
  if (period === null) return null;
  const current = periodKey(now, "MONTH");

  const spendingSeries = ofType<SpendingByCategoryPayload>(rows, "SPENDING_BY_CATEGORY");
  const recapSpending = spendingSeries.find((s) => s.period === period) ?? null;

  // Typical: the middle of the comparable complete months BEFORE the recap
  // month, the window the runway averages, so the two never disagree on which
  // months count.
  const before = recentMonths(
    spendingSeries.filter((s) => s.period < period).map((s) => s.period),
    input.firstRecords,
  );
  const baseline = spendingSeries.filter((s) => before.used.includes(s.period));
  const enough = baseline.length >= RECAP_MIN_TYPICAL_MONTHS;

  let spent: RecapSpent | null = null;
  let moved: RecapMoved | null = null;
  if (recapSpending !== null) {
    const total = spendingBreakdown(recapSpending.payload).total;
    const typical = enough ? round2(median(baseline.map((s) => spendingBreakdown(s.payload).total))) : null;
    const own = recentMonths([period], input.firstRecords, 1);
    spent = {
      total,
      typical,
      vsTypical: typical === null ? null : round2(total - typical),
      caveat:
        own.dropped.length > 0
          ? `${own.dropped[0].missing} of ${own.dropped[0].total} accounts had no records yet`
          : null,
    };
    if (enough) {
      for (const c of recapSpending.payload.categories) {
        // Not a category the month moved: Uncategorized and unreviewed P2P are
        // queues the open nudges below already name.
        if (c.spending <= 0 || c.categoryId === null || c.categoryId === P2P_UNREVIEWED_ID) continue;
        const typicalHere = median(
          baseline.map((s) => s.payload.categories.find((x) => x.categoryId === c.categoryId)?.spending ?? 0),
        );
        const over = round2(c.spending - typicalHere);
        // A category with no typical month (new this month) has nothing to be over.
        if (typicalHere > 0 && over >= RECAP_MOVED_MIN && (moved === null || over > moved.over)) {
          moved = { category: c.categoryName ?? "Uncategorized", spending: c.spending, typical: round2(typicalHere), over };
        }
      }
    }
  }

  // Complete month-ends oldest first, as /insights reads them.
  const growthRows = ofType<NetWorthGrowthPayload>(rows, "NET_WORTH_GROWTH").filter((r) => r.period < current);
  const months = growthRows.map(({ period: p, payload }) => ({
    period: p,
    value: payload.netWorth,
    estimated: payload.estimatedAccountIds.length > 0,
    leftOut: payload.excludedAccountIds ?? [],
    marketGains: payload.marketGains ?? null,
    byAccount: payload.byAccount ?? null,
    flowsByAccount: payload.investmentFlowsByAccount ?? null,
    interestByAccount: payload.interestByAccount ?? null,
  }));
  const at = months.findIndex((m) => m.period === period);
  let netWorth: RecapNetWorth | null = null;
  if (at > 0 && months[at - 1].period === previousPeriodKey(period)) {
    const points: NetWorthPoint[] = months;
    const g = growthBetween(points, at - 1, at);
    const row = growthRows[at].payload;
    const notes: string[] = [];
    const leftOut = row.excludedAccountIds?.length ?? 0;
    if (leftOut > 0) notes.push(`${leftOut} account${leftOut === 1 ? "" : "s"} left out`);
    if (row.estimatedAccountIds.length > 0) notes.push(`${row.estimatedAccountIds.length} balances estimated`);
    netWorth = {
      change: g.change,
      saved: g.saved,
      markets: g.markets,
      joined: g.joined,
      caveat: notes.length === 0 ? null : notes.join(", "),
    };
  }

  // The goal. Declared state only: with none, the third column is absent.
  let goal: RecapGoal | null = null;
  const cashFlow = ofType<CashFlowTrendPayload>(rows, "CASH_FLOW_TREND");
  const complete = cashFlow.filter((r) => r.period < current);
  const pay = payLevels(cashFlow.flatMap((r) => r.payload.paychecks ?? []), parseNewPay(settings.newPay));
  const declaredNetWorth = parseNetWorthGoal(settings.netWorthGoal);
  if (declaredNetWorth !== null) {
    const cash = accounts.filter((a) => input.cashAccountIds.has(a.id));
    goal = netWorthGoalRecap(
      assessNetWorthGoal({
        goal: declaredNetWorth,
        liveNetWorth: accounts.reduce((sum, a) => sum + a.balance, 0),
        months,
        investedIds: new Set(accounts.filter((a) => a.type === "INVESTMENT" && !input.cashAccountIds.has(a.id)).map((a) => a.id)),
        cashAccounts: cash.map((a) => ({ id: a.id, name: a.name })),
        liveCash: cash.map((a) => ({ id: a.id, balance: a.balance })),
        monthlySpending: complete.map((r) => r.payload.spending),
        oneOffs: Object.fromEntries(complete.map((r) => [r.period, r.payload.oneOffPay ?? []])),
        pay,
      }),
    );
  } else {
    const declared = parseGoals(settings.savingsGoals);
    if (declared.length > 0) {
      const window = recentMonths(complete.map((r) => r.period), input.firstRecords);
      const regular = (r: { period: string; payload: CashFlowTrendPayload }) =>
        (pay.topUps[r.period] ?? 0) - (r.payload.oneOffIncome ?? 0);
      const cash = accounts.filter((a) => input.cashAccountIds.has(a.id));
      const cards = accounts.filter((a) => a.type === "CREDIT");
      const [first] = assessGoals({
        goals: declared,
        accounts,
        cashAccounts: cash,
        cards,
        completeMonthlyNet: complete.filter((r) => window.used.includes(r.period)).map((r) => r.payload.net + regular(r)),
        now,
      });
      goal = savingsGoalRecap(first);
    }
  }

  return { period, monthName: monthLabel(period).split(" ")[0], spent, netWorth, goal, moved };
}
