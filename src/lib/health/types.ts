import type { ConnectorType, RecurringCadence } from '../../types/contracts';

/**
 * Static, honest context about a data provider — displayed with its live
 * status so known residual risks stay visible, not just remembered.
 */
export interface ProviderTrustCard {
  connectorType: ConnectorType;
  displayName: string;
  /** Where the data physically flows, end to end. */
  dataPath: string;
  /** Risks accepted by using this provider — permanent, not incident-driven. */
  residualRisks: string[];
  /** How to cut this provider's access immediately. */
  revocation: string;
}

export type ProviderStatusLevel = 'OK' | 'WARN' | 'ERROR' | 'UNKNOWN';

export interface StaleAccountSignal {
  accountId: string;
  accountName: string;
  balanceDate: Date;
  daysStale: number;
}

export interface GappedAccountSignal {
  accountId: string;
  accountName: string;
  /** Historical transactions/month for this account. */
  typicalPerMonth: number;
  /** Transactions seen in the recent window. */
  recentCount: number;
  windowDays: number;
}

export interface LastSyncInfo {
  at: Date;
  ok: boolean;
  errorText: string | null;
  feedErrors: string[];
}

export interface ProviderHealth {
  connectorType: ConnectorType;
  trustCard: ProviderTrustCard;
  status: ProviderStatusLevel;
  /** Human-readable reasons behind the status, worst first. */
  reasons: string[];
  lastSync: LastSyncInfo | null;
  lastSuccessfulSyncAt: Date | null;
  syncOverdue: boolean;
  accountCount: number;
  staleAccounts: StaleAccountSignal[];
  gappedAccounts: GappedAccountSignal[];
}

export interface SubscriptionCharge {
  transactionId: string;
  date: Date;
  /** Positive magnitude. */
  amount: number;
}

export interface SubscriptionStatus {
  id: string;
  name: string;
  enabled: boolean;
  expectedAmount: number;
  cadence: RecurringCadence;
  nextPaymentDate: Date;
  daysUntilNextPayment: number;
  lastCharge: SubscriptionCharge | null;
  /** Set when the most recent charge differs from the expected amount. */
  priceDrift: { expected: number; actual: number; deltaPct: number } | null;
}
