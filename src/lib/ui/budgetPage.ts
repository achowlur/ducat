import type { SpendingByCategoryPayload } from "../../types/contracts";
import { monthKeyBack, periodKey } from "../insights/periods";
import { median } from "../insights/stats";
import { prisma } from "../prisma";
import { BUDGET_KEY, buildBudget, parseBudget, YEARLY_WINDOW, type Budget } from "./budget";
import { accountCoverageFrom, firstRecords } from "./coverage";
import { goalInputs } from "./goalInputs";
import { monthlyRows, ofType } from "./insightRows";
import { NEW_PAY_KEY, parseNewPay } from "./payLevel";

/** Cash flow reaches back as far as Overview's goals read it: pay levels look for raises across it. */
const PAY_MONTHS_BACK = 24;

/**
 * Everything /budget draws, in ONE round trip: this month and the yearly
 * window's spending, the cash flow the income line is read from, the
 * accounts and where their records begin (which months are comparable), and
 * the two Settings.
 */
export async function getBudgetData(now: Date = new Date()): Promise<Budget> {
  const [insightRows, accounts, firsts, settings] = await Promise.all([
    prisma.insight.findMany({
      where: {
        OR: [
          { type: "SPENDING_BY_CATEGORY", period: { gte: monthKeyBack(now, YEARLY_WINDOW) } },
          { type: "CASH_FLOW_TREND", period: { gte: monthKeyBack(now, PAY_MONTHS_BACK) } },
        ],
      },
      select: { type: true, period: true, payload: true, dismissed: true },
    }),
    prisma.account.findMany({ select: { id: true, name: true, type: true, balance: true } }),
    firstRecords(),
    prisma.setting.findMany({ where: { key: { in: [BUDGET_KEY, NEW_PAY_KEY] } } }),
  ]);
  const setting = (key: string) => settings.find((s) => s.key === key)?.value ?? null;
  const monthly = monthlyRows(insightRows.map((r) => ({ ...r, payload: r.payload as unknown })));
  const firstTransactions = accountCoverageFrom(accounts, firsts).map((a) => a.firstTransaction);

  // A typical month's income as the goals read it (goalInputs): the
  // comparable months, paychecks at today's pay, one-off pay left out; the
  // middle of them, as every "typical month" in the app is.
  const inputs = goalInputs({
    monthly,
    period: periodKey(now, "MONTH"),
    accounts,
    cashIds: [],
    firstTransactions,
    newPay: parseNewPay(setting(NEW_PAY_KEY)),
  });
  const incomes = inputs.windowFlow.map((r) => r.payload.income + inputs.regular(r));
  const income = incomes.length === 0 ? null : Math.round(median(incomes) * 100) / 100;

  return buildBudget({
    now,
    months: ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY"),
    firstTransactions,
    choices: parseBudget(setting(BUDGET_KEY)),
    income,
  });
}
