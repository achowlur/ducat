import { periodStart } from './periods';

/**
 * Data-coverage accounting.
 *
 * Accounts rarely share the same history depth: a live aggregator feed reaches
 * back 90 days, one bank's CSV export offers 18 months, a brokerage's offers
 * five years. Analytics computed across a period the data doesn't fully cover
 * are UNDERSTATED, not wrong-by-a-little — and the month a new account's
 * history begins looks like a spending spike that never happened.
 *
 * The engine can't fix that (the transactions genuinely aren't there), so the
 * goal is to make it visible instead of silently wrong: report which accounts
 * actually reach back into a period, and where full coverage begins.
 */
export interface AccountCoverage {
  accountId: string;
  name: string;
  /** Null when the account has no transactions at all. */
  firstTransaction: Date | null;
  /** What this account contributed to the period being asked about. */
  periodSpending?: number;
}

/**
 * An account that does not reach back across the whole period, and what that
 * costs. The two cases are NOT the same claim and were reported as one:
 *
 *   STARTED_MID_PERIOD — the period straddles the account's first transaction.
 *     Its data IS in the totals, just not for the whole period, so nothing is
 *     missing and the period merely is not comparable with earlier ones. The
 *     dollars are known exactly.
 *   NO_DATA — the account's history begins after this period ended, so it
 *     contributed nothing. Here the totals really are understated, by an
 *     amount that cannot be known.
 */
export type CoverageGapKind = 'STARTED_MID_PERIOD' | 'NO_DATA';

export interface CoverageGap {
  name: string;
  kind: CoverageGapKind;
  /** Known contribution to this period; 0 for NO_DATA, where the shortfall is unknowable. */
  contributed: number;
}

export interface PeriodCoverage {
  period: string;
  covered: number;
  total: number;
  complete: boolean;
  gaps: CoverageGap[];
  /** Summed known contribution of the straddling accounts. */
  contributedByPartial: number;
  /** True when at least one account has no data for the period at all. */
  hasUnknownShortfall: boolean;
}

/** An account covers a period only if its history starts at or before the period does. */
function covers(account: AccountCoverage, start: Date): boolean {
  return account.firstTransaction !== null && account.firstTransaction.getTime() <= start.getTime();
}

export function periodCoverage(period: string, accounts: AccountCoverage[]): PeriodCoverage {
  const start = periodStart(period);
  const gaps: CoverageGap[] = accounts
    .filter((a) => !covers(a, start))
    .map((a) => {
      const contributed = a.periodSpending ?? 0;
      // Contributing anything at all means its history began inside the
      // period, which is a different — and much weaker — claim than absence.
      const kind: CoverageGapKind = contributed > 0 ? 'STARTED_MID_PERIOD' : 'NO_DATA';
      return { name: a.name, kind, contributed };
    });

  return {
    period,
    covered: accounts.length - gaps.length,
    total: accounts.length,
    complete: gaps.length === 0,
    gaps,
    contributedByPartial: Math.round(
      gaps.filter((g) => g.kind === 'STARTED_MID_PERIOD').reduce((s, g) => s + g.contributed, 0) * 100,
    ) / 100,
    hasUnknownShortfall: gaps.some((g) => g.kind === 'NO_DATA'),
  };
}
