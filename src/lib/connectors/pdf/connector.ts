import type {
  AccountType,
  Connector,
  NormalizedAccount,
  NormalizedTransaction,
} from '../../../types/contracts';
import { normalizeMerchant, sanitizeBankText } from '../normalize';

/** An account statement rows are filed into: always one that already exists. */
export interface PdfAccountTarget {
  externalId: string;
  name: string;
  institution: string;
  type: AccountType;
  currency: string;
}

export interface PdfImportRow {
  accountExternalId: string;
  externalId: string;
  date: Date;
  amount: number;
  description: string;
  /**
   * The text the merchant is read from, when the description carries more
   * (a late-posted row's "(transaction date ...)" note), so the note never
   * splits one payee into two in the rules and the grouped review.
   */
  merchantText?: string;
  importBatchId: string;
}

/**
 * Statement rows as a connector, so they travel the same pipeline as a feed
 * or a CSV: rules, the closed box, transfer pairing and insights all apply.
 *
 * It offers only the rows the import plan decided to ADD
 * (src/lib/sync/statementImport.ts); which statement rows the database
 * already holds is the plan's question, not this class's.
 *
 * Every account is reported STALE, so a statement import never writes an
 * account's current balance: statements are history, and their closing
 * balances land as snapshots dated to each statement instead.
 */
export class PdfStatementConnector implements Connector {
  readonly type = 'PDF';

  constructor(
    private readonly accounts: (PdfAccountTarget & { lastPeriodEnd: Date })[],
    private readonly rows: PdfImportRow[],
  ) {}

  listAccounts(): Promise<NormalizedAccount[]> {
    return Promise.resolve(
      this.accounts.map((a) => ({
        externalId: a.externalId,
        connectorType: this.type,
        institution: a.institution,
        name: a.name,
        type: a.type,
        currency: a.currency,
        balance: 0,
        balanceDate: a.lastPeriodEnd,
        isStale: true,
      })),
    );
  }

  fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.date.getTime() >= since.getTime())
        .map((r) => {
          const description = sanitizeBankText(r.description);
          return {
            accountExternalId: r.accountExternalId,
            externalId: r.externalId,
            date: r.date,
            amount: r.amount,
            description,
            normalizedMerchant: normalizeMerchant(sanitizeBankText(r.merchantText ?? r.description)),
            flow: r.amount >= 0 ? ('INFLOW' as const) : ('OUTFLOW' as const),
            source: this.type,
            importBatchId: r.importBatchId,
          };
        }),
    );
  }
}
