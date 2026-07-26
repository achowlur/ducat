import type { AccountType, NetWorthGrowthPayload, PeriodGranularity } from '../../types/contracts';
import { inPeriod, periodEndExclusive, periodStart, previousPeriodKey } from './periods';
import { round2, round4 } from './stats';
import type { AccountData, SnapshotData, TxnData } from './types';

/**
 * Balance of one account at instant `at` (exclusive of transactions after it).
 *
 * Preferred source: the latest BalanceSnapshot at or before `at`, rolled
 * forward with the account's transactions between the snapshot and `at`.
 * Fallback: reconstruct from the account's current balance/balanceDate by
 * removing (or adding) transactions between `at` and balanceDate, flagged
 * `estimated`.
 *
 * `known: false` means the balance is NOT recoverable and callers must not
 * substitute a number. That happens for an INVESTMENT account with no usable
 * snapshot: a brokerage's value moves with the market, and market moves are not
 * transactions, so rolling a balance through trades (every "YOU BOUGHT" is cash
 * leaving with no offsetting entry for what it bought) yields a figure with no
 * relationship to what the account was worth.
 *
 * `investmentSnapshotNotBefore` bounds how stale a market-valued account's
 * snapshot may be. Rolling one FORWARD is the same fiction as rolling it back:
 * an August month-end carried to September ignores a month of market movement
 * on a six-figure portfolio. Callers pass the period start, which makes the
 * contract "an investment balance is known for a period only if a snapshot
 * falls inside that period" — i.e. import one month-end per month you want.
 */
export function balanceAt(
  account: AccountData,
  snapshots: SnapshotData[],
  txns: TxnData[],
  at: Date,
  options: { investmentSnapshotNotBefore?: Date } = {},
): { balance: number; estimated: boolean; known: boolean } {
  const marketValued = account.type === 'INVESTMENT';
  const floor = marketValued ? options.investmentSnapshotNotBefore?.getTime() : undefined;
  const own = snapshots
    .filter(
      (s) =>
        s.accountId === account.id &&
        s.date.getTime() <= at.getTime() &&
        (floor === undefined || s.date.getTime() >= floor),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (own.length === 0 && marketValued) {
    return { balance: 0, estimated: true, known: false };
  }

  const anchor = own.length > 0
    ? { balance: own[own.length - 1].balance, date: own[own.length - 1].date, estimated: false }
    : { balance: account.balance, date: account.balanceDate, estimated: true };

  // A market-valued snapshot is the account's TOTAL worth, so its own trades
  // must not be applied to it: "YOU BOUGHT VTI -$51,834.59" moves cash into
  // securities inside the same account and leaves the total unchanged, but
  // rolling it forward subtracts the $51,834.59 outright. (SimpleFIN reports
  // trades as plain OUTFLOWs — only the Fidelity CSV mapping flags them
  // TRANSFER — so this is the normal case for a live feed, not an edge one.)
  // The snapshot is reported as-is, flagged estimated whenever it isn't the
  // period-end value it's standing in for.
  if (marketValued) {
    const staleBy = at.getTime() - anchor.date.getTime();
    return { balance: anchor.balance, estimated: staleBy > 3 * 86_400_000, known: true };
  }

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
  return { balance, estimated: anchor.estimated, known: true };
}

export function computeNetWorthGrowth(
  accounts: AccountData[],
  snapshots: SnapshotData[],
  txns: TxnData[],
  periods: string[],
  granularity: PeriodGranularity,
): Map<string, NetWorthGrowthPayload> {
  /**
   * Null when any account's balance is unrecoverable for the period. A net
   * worth missing an account is not a smaller net worth, it's a wrong one —
   * better to report nothing for that period than a confident fiction. In
   * practice this means history begins where balance snapshots begin.
   */
  const netWorthAt = (key: string): { total: number; invTotal: number; byType: Partial<Record<AccountType, number>>; estimated: string[] } | null => {
    // "End of period" = last instant before the next period starts.
    const at = new Date(periodEndExclusive(key).getTime() - 1);
    const notBefore = periodStart(key);
    let total = 0;
    let invTotal = 0;
    const byType: Partial<Record<AccountType, number>> = {};
    const estimated: string[] = [];
    for (const account of accounts) {
      const { balance, estimated: isEstimated, known } = balanceAt(account, snapshots, txns, at, {
        investmentSnapshotNotBefore: notBefore,
      });
      if (!known) return null;
      total += balance;
      if (account.type === 'INVESTMENT') invTotal += balance;
      byType[account.type] = round2((byType[account.type] ?? 0) + balance);
      if (isEstimated) estimated.push(account.id);
    }
    return { total: round2(total), invTotal: round2(invTotal), byType, estimated };
  };

  const investmentAccountIds = new Set(accounts.filter((a) => a.type === 'INVESTMENT').map((a) => a.id));
  /**
   * Net money CROSSING an investment account's boundary in the period. Any
   * balance change not explained by it is market movement.
   *
   * Most activity inside a brokerage moves nothing in or out: buying a security
   * turns cash into shares, a dividend is earned in place, a reinvestment does
   * both. Counting those as flows is badly wrong — one month of trading
   * ($59,552.76 of purchases against a $3,628.42 deposit) turned a real ~$2.5k gain
   * into a reported $64.79k one. Only genuine transfers count.
   *
   * Classification is by exclusion because brokerage verbs are a small stable
   * set while transfer descriptors vary by institution; anything unrecognised
   * counts as a flow, which understates gains rather than inflating them.
   */
  const internalActivity =
    /\b(you bought|you sold|reinvest\w*|dividend|interest\b|cap(ital)? gain|advisory fee|in lieu of|redemption|exchange (in|out))\b/i;
  /**
   * Direction taken from the wording when the wording is unambiguous, because
   * sources disagree on the sign. The SAME monthly $3,628.42 transfer, same
   * account and same description, arrives as +1400 from Fidelity's own CSV and
   * -1400 from SimpleFIN. Fidelity's export and the paired debit on the funding
   * account both say it is money IN, so the wording is the reliable signal and
   * only the magnitude is taken from the amount.
   */
  const inboundWording = /\b(received|transferred from|deposit|contribution|rollover in)\b/i;
  const outboundWording = /\b(withdrawal|transferred to|distribution|rollover out)\b/i;
  const investmentFlows = (key: string): number => {
    let sum = 0;
    for (const t of txns) {
      if (!investmentAccountIds.has(t.accountId) || !inPeriod(t.date, key)) continue;
      if (internalActivity.test(t.description)) continue;
      const magnitude = Math.abs(t.amount);
      sum += inboundWording.test(t.description)
        ? magnitude
        : outboundWording.test(t.description)
          ? -magnitude
          : t.amount;
    }
    return round2(sum);
  };

  const result = new Map<string, NetWorthGrowthPayload>();
  for (const key of periods) {
    const current = netWorthAt(key);
    if (current === null) continue;
    const prevKey = previousPeriodKey(key);
    // Only compare when the previous period is also in scope; otherwise we'd
    // report growth against a period with no data behind it.
    const previous = periods.includes(prevKey) ? netWorthAt(prevKey) : null;
    const growthRate =
      previous !== null && previous.total !== 0
        ? round4((current.total - previous.total) / Math.abs(previous.total))
        : null;
    const flows = investmentFlows(key);
    const marketGains =
      previous === null ? null : round2(current.invTotal - previous.invTotal - flows);
    result.set(key, {
      granularity,
      netWorth: current.total,
      previousNetWorth: previous === null ? null : previous.total,
      growthRate,
      byAccountType: current.byType,
      marketGains,
      investmentNetFlows: flows,
      estimatedAccountIds: current.estimated,
    });
  }
  return result;
}
