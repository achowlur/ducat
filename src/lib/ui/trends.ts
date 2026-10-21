import type { NetWorthGrowthPayload } from "../../types/contracts";
import type { TxnData } from "../insights/types";
import { prisma } from "../prisma";
import { isClosedBox } from "../sync/closedBox";
import { monthlyRows, ofType } from "./insightRows";
import { buildEntries, type Entry } from "./report";
import { dailyNetWorth, type DailyNetWorth } from "./dailyNetWorth";
import { localDayKey } from "./format";
import { pollsForBalances } from "../health/health";

export interface MonthPoint {
  period: string; // "2026-07"
  label: string; // "Jul"
}

export interface TrendsSource {
  entries: Entry[];
  /**
   * Accounts that can hold income or spending, with the day ("2026-08-14")
   * their records begin: an INVESTMENT account is a closed box (sync/closedBox.ts) and holds
   * neither, so it is never a group, a filter or a coverage gap here.
   */
  accounts: { id: string; name: string; firstDay: string | null }[];
  accountNames: Map<string, string>;
  categories: { id: string; name: string; isIncome: boolean }[];
  netWorth: (MonthPoint & {
    value: number;
    estimated: boolean;
    /** Accounts the month's figure leaves out, by name: no value for them that month. */
    leftOut: string[];
    marketGains: number | null;
  })[];
  /** Net worth day by day where every account has a balance (dailyNetWorth.ts): the line zoomed past three months. */
  daily: DailyNetWorth;
}

function shortMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

/**
 * Everything /trends draws, in ONE round of queries: its cards are sums over
 * the same entries, so each control change costs one fetch, never one per card.
 * Columns are SELECTED, not included: a relation include is a statement of its
 * own on Turso, and category names join in memory from a table of a few dozen.
 */
export async function getTrendsSource(): Promise<TrendsSource> {
  const [txnRows, categories, accounts, netWorthRows, snapshots] = await Promise.all([
    prisma.transaction.findMany({
      select: {
        id: true,
        accountId: true,
        date: true,
        amount: true,
        description: true,
        normalizedMerchant: true,
        flow: true,
        categoryId: true,
        reimbursesId: true,
      },
    }),
    prisma.category.findMany({ select: { id: true, name: true, isIncome: true }, orderBy: { name: "asc" } }),
    prisma.account.findMany({ select: { id: true, name: true, type: true, connectorType: true }, orderBy: { name: "asc" } }),
    prisma.insight.findMany({ where: { type: "NET_WORTH_GROWTH" } }),
    // Every balance on record, three narrow columns: the daily line needs each
    // account's newest one too, to tell a closed account from a silent one.
    prisma.balanceSnapshot.findMany({ select: { accountId: true, date: true, balance: true } }),
  ]);

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const txns: TxnData[] = txnRows.map((t) => {
    const category = t.categoryId === null ? undefined : categoryById.get(t.categoryId);
    return {
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amount: Number(t.amount),
      description: t.description,
      normalizedMerchant: t.normalizedMerchant,
      flow: t.flow,
      categoryId: t.categoryId,
      categoryName: category?.name ?? null,
      categoryIsIncome: category?.isIncome ?? false,
      reimbursesId: t.reimbursesId,
    };
  });

  const firstByAccount = new Map<string, string>();
  for (const t of txnRows) {
    const day = t.date.toISOString().slice(0, 10);
    const seen = firstByAccount.get(t.accountId);
    if (seen === undefined || day < seen) firstByAccount.set(t.accountId, day);
  }
  const open = accounts.filter((a) => !isClosedBox(a.type));

  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  return {
    entries: buildEntries(txns),
    accounts: open.map((a) => ({ id: a.id, name: a.name, firstDay: firstByAccount.get(a.id) ?? null })),
    accountNames,
    categories,
    netWorth: ofType<NetWorthGrowthPayload>(monthlyRows(netWorthRows), "NET_WORTH_GROWTH").map(
      ({ period, payload }) => ({
        period,
        label: shortMonth(period),
        value: payload.netWorth,
        estimated: payload.estimatedAccountIds.length > 0,
        leftOut: (payload.excludedAccountIds ?? []).map((id) => accountNames.get(id) ?? "an account no longer listed"),
        marketGains: payload.marketGains ?? null,
      }),
    ),
    daily: dailyNetWorth({
      // A brokerage fed by an aggregator reports the previous trading day's
      // close: dated back a day so the daily line follows its market day.
      accounts: accounts.map((a) => ({ ...a, priorClose: a.type === "INVESTMENT" && pollsForBalances(a.connectorType) })),
      snapshots: snapshots.map((s) => ({ accountId: s.accountId, date: s.date, balance: Number(s.balance) })),
      txns,
      dayOf: localDayKey,
      today: localDayKey(new Date()),
    }),
  };
}
