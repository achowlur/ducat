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
}

export interface PeriodCoverage {
  period: string;
  covered: number;
  total: number;
  complete: boolean;
  /** Names of accounts whose history starts after this period began. */
  missing: string[];
}

/** An account covers a period only if its history starts at or before the period does. */
function covers(account: AccountCoverage, start: Date): boolean {
  return account.firstTransaction !== null && account.firstTransaction.getTime() <= start.getTime();
}

export function periodCoverage(period: string, accounts: AccountCoverage[]): PeriodCoverage {
  const start = periodStart(period);
  const missing = accounts.filter((a) => !covers(a, start)).map((a) => a.name);
  return {
    period,
    covered: accounts.length - missing.length,
    total: accounts.length,
    complete: missing.length === 0,
    missing,
  };
}

/**
 * The earliest instant at which every account has data — analytics from here
 * forward are comparable, earlier ones are partial. Null when any account has
 * no transactions (nothing is fully covered).
 */
export function coverageFloor(accounts: AccountCoverage[]): Date | null {
  if (accounts.length === 0) return null;
  let floor = new Date(0);
  for (const a of accounts) {
    if (a.firstTransaction === null) return null;
    if (a.firstTransaction.getTime() > floor.getTime()) floor = a.firstTransaction;
  }
  return floor;
}
