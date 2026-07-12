import type { AccountType, NetWorthGrowthPayload, PeriodGranularity } from '../../types/contracts';
import { periodEndExclusive, previousPeriodKey } from './periods';
import { round2, round4 } from './stats';
import type { AccountData, SnapshotData, TxnData } from './types';

/**
 * Balance of one account at instant `at` (exclusive of transactions after it).
 *
 * Preferred source: the latest BalanceSnapshot at or before `at`, rolled
 * forward with the account's transactions between the snapshot and `at`.
 * Fallback: reconstruct from the account's current balance/balanceDate by
 * removing (or adding) transactions between `at` and balanceDate. The fallback
 * is flagged `estimated` — for INVESTMENT accounts it misses market moves.
 */
export function balanceAt(
  account: AccountData,
  snapshots: SnapshotData[],
  txns: TxnData[],
  at: Date,
): { balance: number; estimated: boolean } {
  const own = snapshots
    .filter((s) => s.accountId === account.id && s.date.getTime() <= at.getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const anchor = own.length > 0
    ? { balance: own[own.length - 1].balance, date: own[own.length - 1].date, estimated: false }
    : { balance: account.balance, date: account.balanceDate, estimated: true };

  let balance = anchor.balance;
  const lo = Math.min(anchor.date.getTime(), at.getTime());
  const hi = Math.max(anchor.date.getTime(), at.getTime());
  const forward = anchor.date.getTime() <= at.getTime();
  for (const t of txns) {
    if (t.accountId !== account.id) continue;
    const ts = t.date.getTime();
    if (ts <= lo || ts > hi) continue;
    balance += forward ? t.amount : -t.amount;
  }
  return { balance, estimated: anchor.estimated };
}

export function computeNetWorthGrowth(
  accounts: AccountData[],
  snapshots: SnapshotData[],
  txns: TxnData[],
  periods: string[],
  granularity: PeriodGranularity,
): Map<string, NetWorthGrowthPayload> {
  const netWorthAt = (key: string): { total: number; byType: Partial<Record<AccountType, number>>; estimated: string[] } => {
    // "End of period" = last instant before the next period starts.
    const at = new Date(periodEndExclusive(key).getTime() - 1);
    let total = 0;
    const byType: Partial<Record<AccountType, number>> = {};
    const estimated: string[] = [];
    for (const account of accounts) {
      const { balance, estimated: isEstimated } = balanceAt(account, snapshots, txns, at);
      total += balance;
      byType[account.type] = round2((byType[account.type] ?? 0) + balance);
      if (isEstimated) estimated.push(account.id);
    }
    return { total: round2(total), byType, estimated };
  };

  const result = new Map<string, NetWorthGrowthPayload>();
  for (const key of periods) {
    const current = netWorthAt(key);
    const prevKey = previousPeriodKey(key);
    // Only compare when the previous period is also in scope; otherwise we'd
    // report growth against a period with no data behind it.
    const previous = periods.includes(prevKey) ? netWorthAt(prevKey) : null;
    const growthRate =
      previous !== null && previous.total !== 0
        ? round4((current.total - previous.total) / Math.abs(previous.total))
        : null;
    result.set(key, {
      granularity,
      netWorth: current.total,
      previousNetWorth: previous === null ? null : previous.total,
      growthRate,
      byAccountType: current.byType,
      estimatedAccountIds: current.estimated,
    });
  }
  return result;
}
