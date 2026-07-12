export type AccountType = 'DEPOSITORY' | 'CREDIT' | 'INVESTMENT' | 'LOAN';

export type TransactionFlow = 'INFLOW' | 'OUTFLOW' | 'TRANSFER';

export type ConnectorType = 'SIMPLEFIN' | 'CSV';

export type InsightType = string;

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

export interface Insight {
  id: string;
  type: InsightType;
  period: string;
  payload: Record<string, unknown>;
  dismissed: boolean;
  createdAt: Date;
}

export interface Connector {
  readonly type: ConnectorType;
  listAccounts(): Promise<NormalizedAccount[]>;
  fetchTransactions(since: Date): Promise<NormalizedTransaction[]>;
}
