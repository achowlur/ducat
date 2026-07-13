/**
 * Normalization contract shared by every layer.
 *
 * Sign conventions (SimpleFIN-style):
 * - Transaction amounts are signed. Positive = money in (INFLOW),
 *   negative = money out (OUTFLOW). TRANSFER amounts may carry either sign.
 * - Account balances are signed. Liability accounts (CREDIT, LOAN) carry
 *   negative balances, so net worth is the plain sum of all balances.
 *
 * Insight payloads report money as positive magnitudes (e.g. `spending: 123.45`
 * means $123.45 spent) except net worth, which stays signed.
 */

export type AccountType = 'DEPOSITORY' | 'CREDIT' | 'INVESTMENT' | 'LOAN';

export type TransactionFlow = 'INFLOW' | 'OUTFLOW' | 'TRANSFER';

export type ConnectorType = 'SIMPLEFIN' | 'CSV';

/**
 * Period keys by granularity:
 * WEEK "2026-W28" (ISO week) | MONTH "2026-07" | QUARTER "2026-Q3" | YEAR "2026"
 */
export type PeriodGranularity = 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

export type RecurringCadence =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'YEARLY';

export interface NetWorthGrowthPayload {
  granularity: PeriodGranularity;
  /** Signed net worth at the end of the period. */
  netWorth: number;
  previousNetWorth: number | null;
  /** (netWorth - previous) / |previous|; null when no previous or previous is 0. */
  growthRate: number | null;
  byAccountType: Partial<Record<AccountType, number>>;
  /**
   * INVESTMENT-account value change not explained by transactions —
   * unrealized market movement. Deliberately NOT income (see cash flow):
   * it decomposes net worth growth into "markets" vs "everything else".
   * Null when the previous period is out of scope. Requires snapshots:
   * reconstruction-only investment accounts contribute 0 (unknowable).
   */
  marketGains: number | null;
  /** Net transaction flow into INVESTMENT accounts during the period. */
  investmentNetFlows: number;
  /**
   * Accounts whose period-end balance was reconstructed from transaction
   * history because no BalanceSnapshot covered the period. Reconstruction is
   * inaccurate for INVESTMENT accounts (market moves aren't transactions).
   */
  estimatedAccountIds: string[];
}

export interface CategorySpending {
  categoryId: string | null;
  categoryName: string | null;
  spending: number;
  previousSpending: number | null;
  /** (spending - previous) / previous; null when no previous period data. */
  deltaPct: number | null;
}

export interface SpendingByCategoryPayload {
  granularity: PeriodGranularity;
  totalSpending: number;
  previousTotalSpending: number | null;
  categories: CategorySpending[];
}

export interface CashFlowTrendPayload {
  granularity: PeriodGranularity;
  income: number;
  spending: number;
  net: number;
  previousIncome: number | null;
  previousSpending: number | null;
  previousNet: number | null;
  incomeDeltaPct: number | null;
  spendingDeltaPct: number | null;
}

export interface RecurringChargePayload {
  /** Normalized merchant, lowercased — also the identity key for dismissals. */
  merchant: string;
  cadence: RecurringCadence;
  averageAmount: number;
  lastAmount: number;
  /** ISO date (YYYY-MM-DD) of the most recent occurrence. */
  lastDate: string;
  occurrences: number;
  /** Median of all occurrences before the most recent one. */
  previousAverageAmount: number | null;
  priceIncreased: boolean;
}

export interface AnomalyPayload {
  kind: 'TRANSACTION' | 'CATEGORY_TOTAL';
  granularity: PeriodGranularity;
  /** Set when kind = TRANSACTION. */
  transactionId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** Merchant/description context for TRANSACTION anomalies. */
  description: string | null;
  /** Positive magnitude of the anomalous amount or category total. */
  amount: number;
  /** Historical median the amount was compared against. */
  typicalAmount: number;
  /** Robust z-score ((x - median) / (1.4826 * MAD)), capped at 99. */
  deviation: number;
}

export interface InsightPayloadMap {
  NET_WORTH_GROWTH: NetWorthGrowthPayload;
  SPENDING_BY_CATEGORY: SpendingByCategoryPayload;
  CASH_FLOW_TREND: CashFlowTrendPayload;
  RECURRING_CHARGE: RecurringChargePayload;
  ANOMALY: AnomalyPayload;
}

export type InsightType = keyof InsightPayloadMap;

export interface Insight<T extends InsightType = InsightType> {
  id: string;
  type: T;
  period: string;
  payload: InsightPayloadMap[T];
  dismissed: boolean;
  createdAt: Date;
}

export interface NormalizedAccount {
  externalId: string;
  connectorType: ConnectorType;
  institution: string;
  name: string;
  type: AccountType;
  currency: string;
  balance: number;
  balanceDate: Date;
  isStale: boolean;
}

export interface NormalizedTransaction {
  accountExternalId: string;
  externalId: string;
  date: Date;
  amount: number;
  description: string;
  normalizedMerchant: string;
  flow: TransactionFlow;
  source: ConnectorType;
}

export interface Connector {
  readonly type: ConnectorType;
  listAccounts(): Promise<NormalizedAccount[]>;
  fetchTransactions(since: Date): Promise<NormalizedTransaction[]>;
  /**
   * Non-fatal provider warnings observed during this session (e.g.
   * SimpleFIN's errors array: "Connection to X needs attention").
   * The sync pipeline persists them to SyncLog for the health panel.
   */
  feedWarnings?(): string[];
}
