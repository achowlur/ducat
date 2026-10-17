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

export const ACCOUNT_TYPES = ['DEPOSITORY', 'CREDIT', 'INVESTMENT', 'LOAN'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type TransactionFlow = 'INFLOW' | 'OUTFLOW' | 'TRANSFER';

export type ConnectorType = 'SIMPLEFIN' | 'CSV' | 'PDF';

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
   * Each account's period-end value counted into `netWorth`, by account id
   * (an account left out is absent). Lets a reader split net worth by a line
   * the account type cannot draw, such as the operator's cash definition (the
   * net worth goal applies a market return to invested money only). Absent on
   * payloads stored before 2026-10-16.
   */
  byAccount?: Record<string, number>;
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
   * `investmentNetFlows` by account (accounts with none absent): money in
   * positive, out negative. Absent on payloads stored before 2026-10-16.
   */
  investmentFlowsByAccount?: Record<string, number>;
  /**
   * Interest and dividends EARNED in the period, by bank or investment
   * account (accounts with none absent), as positive dollars: what a cash
   * account's yield is measured from. Never the change in value, which a
   * deposit, or a fund the account held, would pass off as earnings. Absent
   * on payloads stored before 2026-10-17.
   */
  interestByAccount?: Record<string, number>;
  /**
   * Accounts whose period-end balance is not that period's own: reconstructed
   * from transaction history, or (investment) a snapshot from earlier.
   */
  estimatedAccountIds: string[];
  /**
   * The investment accounts among those whose value is CARRIED from an
   * earlier period, its market movement since unseen. Absent on payloads
   * stored before 2026-10-15.
   */
  carriedAccountIds?: string[];
  /**
   * Accounts LEFT OUT of `netWorth` because their balance is unknown for the
   * period (records that start late): the figure is smaller than the truth by
   * them, and every screen names them. Absent on payloads stored before
   * 2026-10-15, when such a period was not drawn at all.
   */
  excludedAccountIds?: string[];
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
  /**
   * ISO date of the newest transaction of ANY kind on the account that carried
   * the most recent occurrence: how far that account's records reach, so a
   * charge that never came can be told from records that simply stop. Absent
   * on rows generated before it existed (regeneration fills it in).
   */
  accountThrough?: string;
  /**
   * Earlier merchant strings the same plan was billed under, oldest first,
   * when the bank renamed its descriptor mid-plan (`merchant` is the newest).
   * Absent when the plan only ever had one.
   */
  aliases?: string[];
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
  /**
   * Fraction of the compared history this amount exceeds, 0–1. What the UI
   * shows, because `amount / typicalAmount` reads as "you spent 4× what a
   * dinner costs" when the median of a heavy-tailed category is nothing like
   * the cost of a dinner. `deviation` still does the ranking.
   */
  percentileOfHistory: number;
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
  /** The ImportBatch (statement file) the row came from; feeds and CSVs set none. */
  importBatchId?: string;
  /**
   * A category the SOURCE itself assigned, already mapped to one of Ducat's
   * category names (a card issuer's export carries one per purchase). The
   * pipeline uses it only where no rule matched, and never for a P2P payment
   * or a row inside an investment account (sync/sourceCategory.ts).
   */
  sourceCategory?: string;
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

/**
 * One stored observation of a published market rate — the normalized shape
 * the FRED mortgage-rate fetcher (`src/lib/rates/`) writes and the readiness
 * panel reads. It lives here, beside the other normalized shapes, so nothing
 * downstream depends on FRED's own response format.
 */
export interface RateObservation {
  /** The provider's series id, e.g. "OBMMIC30YF" — named in the UI. */
  seriesId: string;
  /** Yearly rate in percent (6.651 = 6.651%/yr), the readiness convention. */
  ratePct: number;
  /**
   * The series' OWN date for this value (YYYY-MM-DD) — the as-of the UI must
   * show. Distinct from `fetchedAt`: an observation fetched today can be
   * days old, and showing the fetch time would read fresher than it is.
   */
  observationDate: string;
  /** When this instance fetched it (ISO instant) — freshness of the FETCH. */
  fetchedAt: string;
}
