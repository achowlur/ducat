import { round2 } from "../insights/stats";
import { addMonths } from "./netWorthGoal";

/**
 * A savings goal's FUND over time, from the per-account month-end values the
 * net worth rows carry (NET_WORTH_GROWTH `byAccount`): its chart's record,
 * and the cash reconciliation printed beside its date.
 *
 * Balances, never a sum of transactions. Summing a fund's transactions was
 * right only while every account in it was a bank account: an investment
 * account counted as cash books its trades and money-market sweeps as rows,
 * and the sum said a growing fund had been shrinking every month.
 */

/** A month-end as the net worth rows record it; `byAccount` is null on rows stored before it existed. */
export interface MonthByAccount {
  period: string;
  byAccount: Record<string, number> | null;
}

/** The fund's value at one month-end: its accounts' values summed (an account absent that month counts nothing). */
export function fundValue(m: MonthByAccount, ids: readonly string[]): number {
  return round2(ids.reduce((sum, id) => sum + (m.byAccount?.[id] ?? 0), 0));
}

/**
 * The fund's last `count` month-ends that carry per-account values, oldest
 * first. Kept SHORT on purpose by the caller: a cash goal's fund is the cash
 * definition TODAY, and further back it draws a history the fund never had
 * (an account counted as cash now once held a brokerage's shares, and a long
 * line climbed to many times the fund before falling off a cliff that was
 * never the fund's).
 */
export function fundHistory(
  months: readonly MonthByAccount[],
  ids: readonly string[],
  count: number,
): { period: string; value: number }[] {
  return months
    .filter((m) => m.byAccount !== null)
    .slice(-count)
    .map((m) => ({ period: m.period, value: fundValue(m, ids) }));
}

/**
 * The fund's mean monthly growth over the months `windowKeys` (oldest
 * first): from the month-end BEFORE the first to the last, divided by their
 * count. Null when either end lacks per-account values, so the caller can
 * say nothing rather than guess.
 */
export function fundGrowthOver(
  months: readonly MonthByAccount[],
  ids: readonly string[],
  windowKeys: readonly string[],
): number | null {
  if (windowKeys.length === 0) return null;
  const base = months.find((m) => m.period === addMonths(windowKeys[0], -1));
  const end = months.find((m) => m.period === windowKeys[windowKeys.length - 1]);
  if (base?.byAccount == null || end?.byAccount == null) return null;
  return round2((fundValue(end, ids) - fundValue(base, ids)) / windowKeys.length);
}
