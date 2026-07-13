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
}

export interface SnapshotData {
  accountId: string;
  date: Date;
  balance: number;
}
