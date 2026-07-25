import { createHash } from 'node:crypto';
import type {
  AccountType,
  Connector,
  NormalizedAccount,
  NormalizedTransaction,
  TransactionFlow,
} from '../../types/contracts';
import type { CsvMapping } from './csvMappings';
import { parseCsv } from './csvParser';
import { normalizeMerchant } from './normalize';

/**
 * CSV files carry no account metadata, so the caller must say which
 * account the file belongs to.
 */
export interface CsvAccountDescriptor {
  externalId: string;
  name: string;
  institution: string;
  type: AccountType;
  currency?: string;
  /**
   * Ignore rows dated on or after this date (exclusive cut-off).
   *
   * Transaction dedupe is (accountId, externalId), and a CSV row's id is a
   * content hash while an aggregator's is the feed's own id — so the SAME
   * real transaction arriving from both sources does NOT dedupe. When
   * backfilling history into an account a live feed already covers, cut the
   * import at the date the feed's coverage begins.
   */
  until?: Date;
}

/**
 * Maps a raw account value from a multi-account file to the account it belongs
 * to. Returning null skips the row (reported via `unresolvedAccounts`), which
 * is the safe default — filing a transaction under the wrong account silently
 * corrupts both accounts' history.
 */
export type CsvAccountResolver = (rawAccount: string) => CsvAccountDescriptor | null;

function parseDate(raw: string, format: 'MDY' | 'YMD'): Date | null {
  const cleaned = raw.trim();
  const parts = format === 'MDY'
    ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cleaned)
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (parts === null) return null;
  const [y, m, d] = format === 'MDY'
    ? [Number(parts[3]), Number(parts[1]), Number(parts[2])]
    : [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Noon UTC so local-timezone rendering never shifts the calendar day.
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,]/g, '');
  if (cleaned === '') return null;
  const parenthesized = /^\((.*)\)$/.exec(cleaned);
  const n = Number(parenthesized === null ? cleaned : `-${parenthesized[1]}`);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export class CsvConnector implements Connector {
  readonly type = 'CSV';

  private readonly rows: { date: Date; amount: number; description: string; merchant: string; flow: TransactionFlow; balance: number | null; externalId: string; account: CsvAccountDescriptor }[];
  /** Accounts actually seen in the file, in first-seen order. */
  private readonly accounts: CsvAccountDescriptor[] = [];
  /** Raw account values the resolver rejected, and how many rows each cost. */
  readonly unresolvedAccounts = new Map<string, number>();
  /** Rows dropped by the mapping's skipRowWhen filter (pending transactions). */
  skippedRows = 0;

  constructor(
    content: string,
    mapping: CsvMapping,
    account: CsvAccountDescriptor | CsvAccountResolver,
  ) {
    // Routing is driven by the caller's intent, not by the mapping: a resolver
    // means "this file may hold several accounts". Given a plain descriptor,
    // every row belongs to it and the account column is irrelevant — so a
    // per-account export still imports fine under a multi-account mapping.
    const routing = typeof account === 'function';
    const resolve: CsvAccountResolver = routing ? account : () => account;
    const parsed = parseCsv(content);
    if (parsed.length === 0) throw new Error('CSV file is empty');

    let header: string[] | null = null;
    let dataRows = parsed;
    if (mapping.hasHeader) {
      // Some banks (Fidelity) put preamble lines above the real header:
      // find the first row containing the mapped date column name.
      const headerIndex = parsed.findIndex((r) =>
        r.some((c) => c.trim().toLowerCase() === String(mapping.date).toLowerCase()),
      );
      if (headerIndex === -1) {
        throw new Error(`CSV header row with column "${String(mapping.date)}" not found — wrong mapping?`);
      }
      header = parsed[headerIndex].map((c) => c.trim().toLowerCase());
      dataRows = parsed.slice(headerIndex + 1);
    }

    const col = (row: string[], selector: string | number): string => {
      if (typeof selector === 'number') return row[selector] ?? '';
      const idx = header === null ? -1 : header.indexOf(selector.toLowerCase());
      return idx === -1 ? '' : (row[idx] ?? '');
    };

    // A missing account column would silently resolve every row to '' and file
    // the whole file under one account — fail loudly instead.
    if (routing && mapping.account !== undefined && typeof mapping.account === 'string') {
      if (header === null || !header.includes(mapping.account.toLowerCase())) {
        throw new Error(
          `CSV is missing the account column "${mapping.account}". Columns found: ${(header ?? []).join(', ')}`,
        );
      }
    }

    // externalId: banks put no IDs in CSVs, so derive a deterministic one
    // from (date, amount, description) plus an occurrence counter, making
    // re-imports of overlapping files dedupe while genuine same-day
    // duplicates (two identical coffees) stay distinct.
    const occurrences = new Map<string, number>();

    this.rows = [];
    for (const row of dataRows) {
      const skip = mapping.skipRowWhen;
      if (skip !== undefined && skip.pattern.test(col(row, skip.column))) {
        this.skippedRows++;
        continue;
      }
      const date = parseDate(col(row, mapping.date), mapping.dateFormat);
      const amount = parseAmount(col(row, mapping.amount));
      if (date === null || amount === null) {
        if (mapping.skipUnparseable === true) continue;
        throw new Error(`Unparseable CSV row (date/amount): ${JSON.stringify(row)}`);
      }

      const rawAccount =
        routing && mapping.account !== undefined ? col(row, mapping.account).trim() : '';
      const target = resolve(rawAccount);
      if (target === null) {
        this.unresolvedAccounts.set(rawAccount, (this.unresolvedAccounts.get(rawAccount) ?? 0) + 1);
        continue;
      }
      if (!this.accounts.some((a) => a.externalId === target.externalId)) this.accounts.push(target);
      const signed = mapping.invertAmount === true ? -amount : amount;
      const description = mapping.description
        .map((s) => col(row, s).trim())
        .filter((s) => s !== '')
        .join(' — ');
      const merchantRaw = mapping.merchant === undefined ? '' : col(row, mapping.merchant).trim();
      const merchant = normalizeMerchant(merchantRaw !== '' ? merchantRaw : description);

      const isTransfer = (mapping.transferPatterns ?? []).some((p) => p.test(description));
      const flow: TransactionFlow = isTransfer ? 'TRANSFER' : signed >= 0 ? 'INFLOW' : 'OUTFLOW';

      const balanceRaw = mapping.balance === undefined ? null : parseAmount(col(row, mapping.balance));

      const fingerprint = `${date.toISOString().slice(0, 10)}|${signed.toFixed(2)}|${description}`;
      // Counter is scoped per account so a transaction's id is the same whether
      // it arrived in a combined export or a single-account one. The hash input
      // stays account-free (ids may collide across accounts, which is harmless:
      // dedupe is (accountId, externalId)).
      const counterKey = `${target.externalId}|${fingerprint}`;
      const nth = (occurrences.get(counterKey) ?? 0) + 1;
      occurrences.set(counterKey, nth);
      const externalId = `csv-${createHash('sha256').update(`${fingerprint}|${nth}`).digest('hex').slice(0, 24)}`;

      this.rows.push({ date, amount: signed, description, merchant, flow, balance: balanceRaw, externalId, account: target });
    }
  }

  listAccounts(): Promise<NormalizedAccount[]> {
    return Promise.resolve(
      this.accounts.map((account) => {
        const until = account.until?.getTime() ?? Infinity;
        const rows = this.rows.filter(
          (r) => r.account.externalId === account.externalId && r.date.getTime() < until,
        );
        const withBalance = rows
          .filter((r) => r.balance !== null)
          .sort((a, b) => a.date.getTime() - b.date.getTime());
        // A capped import is a historical backfill: the rows stop before today,
        // so this file's last balance is NOT the current one. Never say it is.
        const latest = account.until === undefined ? withBalance[withBalance.length - 1] : undefined;
        const balanceDate = rows.reduce(
          (max, r) => (r.date.getTime() > max.getTime() ? r.date : max),
          new Date(0),
        );
        return {
          externalId: account.externalId,
          connectorType: this.type,
          institution: account.institution,
          name: account.name,
          type: account.type,
          currency: account.currency ?? 'USD',
          balance: latest === undefined ? 0 : (latest.balance as number),
          balanceDate,
          // Without a running-balance column the true balance is unknown.
          isStale: latest === undefined,
        };
      }),
    );
  }

  fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => {
          const until = r.account.until?.getTime() ?? Infinity;
          return r.date.getTime() >= since.getTime() && r.date.getTime() < until;
        })
        .map((r) => ({
          accountExternalId: r.account.externalId,
          externalId: r.externalId,
          date: r.date,
          amount: r.amount,
          description: r.description,
          normalizedMerchant: r.merchant,
          flow: r.flow,
          source: this.type,
        })),
    );
  }
}
