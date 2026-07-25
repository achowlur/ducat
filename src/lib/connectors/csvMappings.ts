/**
 * Column mappings for bank CSV exports. Column selectors are header names
 * (case-insensitive) when hasHeader, otherwise zero-based indexes.
 *
 * Sign convention reminder: our contract wants negative = money out. All
 * three shipped banks already export that way; set invertAmount for banks
 * that emit debits as positive numbers.
 */
export interface CsvMapping {
  id: string;
  label: string;
  hasHeader: boolean;
  date: string | number;
  amount: string | number;
  /** Joined with ' — ' to form the transaction description. */
  description: (string | number)[];
  /** Column used for the normalized merchant; falls back to description. */
  merchant?: string | number;
  /**
   * Set when one file can hold several accounts (Fidelity exports all accounts
   * together). The importer resolves each distinct value in this column to a
   * target account; rows it can't resolve are skipped and reported rather than
   * silently filed under the wrong account.
   */
  account?: string | number;
  /** Running-balance column; the latest row's value becomes the account balance. */
  balance?: string | number;
  dateFormat: 'MDY' | 'YMD';
  invertAmount?: boolean;
  /**
   * Rows whose joined description matches are flagged TRANSFER at import:
   * brokerage trades, contributions, and internal moves are cash changing
   * form, not spending (see HARD RULES / analyzers tests).
   */
  transferPatterns?: RegExp[];
  /** Skip rows whose date doesn't parse (disclaimer footers, section titles). */
  skipUnparseable?: boolean;
}

export const CSV_MAPPINGS: Record<string, CsvMapping> = {
  'chase-checking': {
    id: 'chase-checking',
    label: 'Chase checking/savings export',
    hasHeader: true,
    // Header: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
    date: 'Posting Date',
    amount: 'Amount',
    description: ['Description'],
    balance: 'Balance',
    dateFormat: 'MDY',
  },
  'chase-credit': {
    id: 'chase-credit',
    label: 'Chase credit card export',
    hasHeader: true,
    // Header: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
    date: 'Transaction Date',
    amount: 'Amount',
    description: ['Description'],
    dateFormat: 'MDY',
    transferPatterns: [/\bpayment thank you\b/i],
  },
  'wells-fargo': {
    id: 'wells-fargo',
    label: 'Wells Fargo checking/savings export (headerless)',
    hasHeader: false,
    // Columns: "Date","Amount","*","Check Number","Description"
    date: 0,
    amount: 1,
    description: [4],
    dateFormat: 'MDY',
  },
  fidelity: {
    id: 'fidelity',
    label: 'Fidelity brokerage history export',
    hasHeader: true,
    // Header: Run Date,Action,Symbol,Description,Type,Quantity,Price ($),
    //         Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
    date: 'Run Date',
    amount: 'Amount ($)',
    description: ['Action', 'Symbol', 'Description'],
    merchant: 'Symbol',
    // Fidelity can export every account into one file. Only used when the
    // importer is asked to resolve accounts per row (no --external-id given);
    // override with --account-column if your export names it differently.
    account: 'Account Number',
    dateFormat: 'MDY',
    skipUnparseable: true, // Fidelity files end with disclaimer text rows
    transferPatterns: [
      /\byou bought\b/i,
      /\byou sold\b/i,
      /\breinvestment\b/i,
      /\bcontribution\b/i,
      /\btransfer\b/i,
      /\bjournaled\b/i,
    ],
  },
};
