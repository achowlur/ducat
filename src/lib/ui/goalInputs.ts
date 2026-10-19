import type { CashFlowTrendPayload, NetWorthGrowthPayload } from "../../types/contracts";
import { assessGoals, type GoalAssessment, type SavingsGoal } from "../insights/goals";
import { recentMonths, type RecentMonths } from "../insights/recentMonths";
import { countsAsCash } from "./liquidity";
import { assessNetWorthGoal, type NetWorthGoal, type NetWorthGoalAssessment, type NetWorthMonth } from "./netWorthGoal";
import { payLevels, type NewPay, type PayLevels } from "./payLevel";
import { ofType, type InsightLike } from "./insightRows";

interface GoalAccountRow {
  id: string;
  name: string;
  balance: unknown;
  type: string;
}

/**
 * What the goals stand on, built ONCE from rows a page already loaded, so
 * /insights (which draws the goals) and Overview (whose "Do this next" slot
 * names a goal's action) read the same figures from the same arithmetic.
 * Neither page queries anything here.
 */
export interface GoalInputs {
  pay: PayLevels;
  /** Complete months' cash flow, oldest first: everything before `period`. */
  completeCashFlow: { period: string; payload: CashFlowTrendPayload }[];
  /** The months the paces average (insights/recentMonths.ts). */
  projectionWindow: RecentMonths;
  /** completeCashFlow cut to the projection window. */
  windowFlow: { period: string; payload: CashFlowTrendPayload }[];
  /** A month's regular pay adjustment: paychecks at today's pay, one-off pay out. */
  regular: (r: { period: string; payload: CashFlowTrendPayload }) => number;
  /** Complete month-ends as the NET_WORTH_GROWTH rows record them, each account's value included. */
  netWorthMonths: NetWorthMonth[];
  /** The operator's cash definition, resolved today. */
  cashAccounts: { id: string; name: string; balance: number }[];
  cards: { id: string; name: string; balance: number }[];
  /** A cash goal's fund: cash AFTER the cards it pays. */
  cashFundIds: string[];
  /** Investment accounts outside the cash definition: what a market return applies to. */
  investedIds: Set<string>;
}

export function goalInputs(input: {
  /** monthlyRows output: NET_WORTH_GROWTH and CASH_FLOW_TREND rows among them. */
  monthly: InsightLike[];
  /** The month being lived in (or viewed); everything before it is complete. */
  period: string;
  accounts: readonly GoalAccountRow[];
  cashIds: readonly string[];
  /** Where each account's records begin (AccountCoverage.firstTransaction). */
  firstTransactions: readonly (Date | null)[];
  newPay: NewPay[];
}): GoalInputs {
  const { monthly, period, accounts, newPay } = input;
  const cash = (a: GoalAccountRow) => countsAsCash({ id: a.id, type: a.type, balance: Number(a.balance) }, input.cashIds);
  const cashAccounts = accounts.filter(cash).map((a) => ({ id: a.id, name: a.name, balance: Number(a.balance) }));
  const cards = accounts.filter((a) => a.type === "CREDIT").map((a) => ({ id: a.id, name: a.name, balance: Number(a.balance) }));
  const flows = ofType<CashFlowTrendPayload>(monthly, "CASH_FLOW_TREND");
  const completeCashFlow = flows.filter((r) => r.period < period);
  // Pay as it is now (payLevel.ts): every paycheck on record, the month being
  // lived in included, so a raise this month is seen; earlier paychecks are
  // topped up to it, and one-off pay is left out, in every pace below.
  const pay = payLevels(
    flows.flatMap((r) => r.payload.paychecks ?? []),
    newPay,
  );
  const regular = (r: { period: string; payload: CashFlowTrendPayload }) =>
    (pay.topUps[r.period] ?? 0) - (r.payload.oneOffIncome ?? 0);
  // The months the paces and readiness average: the last six complete ones,
  // less any from before too many of today's accounts' records begin.
  const projectionWindow = recentMonths(
    completeCashFlow.map((r) => r.period),
    input.firstTransactions,
  );
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
  return {
    pay,
    completeCashFlow,
    projectionWindow,
    windowFlow: completeCashFlow.filter((r) => projectionWindow.used.includes(r.period)),
    regular,
    netWorthMonths,
    cashAccounts,
    cards,
    cashFundIds: [...cashAccounts, ...cards].map((a) => a.id),
    investedIds: new Set(accounts.filter((a) => a.type === "INVESTMENT" && !cash(a)).map((a) => a.id)),
  };
}

/** The savings goals, assessed as /insights draws them. */
export function savingsGoalsFrom(
  g: GoalInputs,
  goals: SavingsGoal[],
  accounts: readonly GoalAccountRow[],
  now: Date,
  observedCashGrowth: number | null = null,
): GoalAssessment[] {
  return assessGoals({
    goals,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, balance: Number(a.balance) })),
    // The same cash definition Overview's CASH figure uses — resolved here,
    // at render, so a cash goal tracks whatever the operator's declaration
    // says TODAY, not what it said at declaration time.
    cashAccounts: g.cashAccounts,
    cards: g.cards,
    // One-off pay (a bonus beside a paycheck) left out, paychecks at today's pay.
    // Only the comparable months, so a month before a card's records
    // began is not averaged in as a cheap one.
    completeMonthlyNet: g.windowFlow.map((r) => r.payload.net + g.regular(r)),
    observedCashGrowth,
    now,
  });
}

/** The net worth goal, assessed as /insights draws it: live progress, dates from the last complete month-end. */
export function netWorthGoalFrom(
  g: GoalInputs,
  goal: NetWorthGoal,
  accounts: readonly GoalAccountRow[],
): NetWorthGoalAssessment {
  return assessNetWorthGoal({
    goal,
    // Overview's headline, the signed sum of every balance.
    liveNetWorth: accounts.reduce((sum, a) => sum + Number(a.balance), 0),
    months: g.netWorthMonths,
    investedIds: g.investedIds,
    // What cash earns is measured per account in the same definition.
    cashAccounts: g.cashAccounts.map((a) => ({ id: a.id, name: a.name })),
    liveCash: g.cashAccounts.map((a) => ({ id: a.id, balance: a.balance })),
    monthlySpending: g.completeCashFlow.map((r) => r.payload.spending),
    oneOffs: Object.fromEntries(g.completeCashFlow.map((r) => [r.period, r.payload.oneOffPay ?? []])),
    pay: g.pay,
  });
}
