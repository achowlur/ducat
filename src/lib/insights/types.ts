import type { AccountType, TransactionFlow } from '../../types/contracts';

/**
 * Plain data shapes the analyzers operate on. The engine maps Prisma rows
 * (Decimal, relations) into these so the analyzers stay pure and testable.
 */

export interface TxnData {
  id: string;
  accountId: string;
  date: Date;
  /** Signed: positive = inflow, negative = outflow. */
  amount: number;
  description: string;
  normalizedMerchant: string;
  flow: TransactionFlow;
  categoryId: string | null;
  categoryName: string | null;
  /** True income category (Salary/Interest) — see Category.isIncome. */
  categoryIsIncome: boolean;
  /** Inflow linked to the specific outflow it pays back. */
  reimbursesId: string | null;
}

export interface AccountData {
  id: string;
  type: AccountType;
  /** Signed: liabilities negative. */
  balance: number;
  balanceDate: Date;
  /**
   * An aggregator-fed brokerage: the feed's balance values the PREVIOUS
   * trading day's close, so a snapshot of it belongs to the market day
   * before the local day it was stamped on (netWorth.ts marketDaySnapshots).
   */
  priorClose?: boolean;
}

export interface SnapshotData {
  accountId: string;
  date: Date;
  balance: number;
}
