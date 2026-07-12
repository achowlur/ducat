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
}

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

  private readonly rows: { date: Date; amount: number; description: string; merchant: string; flow: TransactionFlow; balance: number | null; externalId: string }[];
  private readonly account: CsvAccountDescriptor;

  constructor(content: string, mapping: CsvMapping, account: CsvAccountDescriptor) {
    this.account = account;
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

    // externalId: banks put no IDs in CSVs, so derive a deterministic one
    // from (date, amount, description) plus an occurrence counter, making
    // re-imports of overlapping files dedupe while genuine same-day
    // duplicates (two identical coffees) stay distinct.
    const occurrences = new Map<string, number>();

    this.rows = [];
    for (const row of dataRows) {
      const date = parseDate(col(row, mapping.date), mapping.dateFormat);
      const amount = parseAmount(col(row, mapping.amount));
      if (date === null || amount === null) {
        if (mapping.skipUnparseable === true) continue;
        throw new Error(`Unparseable CSV row (date/amount): ${JSON.stringify(row)}`);
      }
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
      const nth = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, nth);
      const externalId = `csv-${createHash('sha256').update(`${fingerprint}|${nth}`).digest('hex').slice(0, 24)}`;

      this.rows.push({ date, amount: signed, description, merchant, flow, balance: balanceRaw, externalId });
    }
  }

  listAccounts(): Promise<NormalizedAccount[]> {
    const withBalance = this.rows
      .filter((r) => r.balance !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const latest = withBalance[withBalance.length - 1];
    const balanceDate = this.rows.reduce(
      (max, r) => (r.date.getTime() > max.getTime() ? r.date : max),
      new Date(0),
    );
    return Promise.resolve([
      {
        externalId: this.account.externalId,
        connectorType: this.type,
        institution: this.account.institution,
        name: this.account.name,
        type: this.account.type,
        currency: this.account.currency ?? 'USD',
        balance: latest === undefined ? 0 : (latest.balance as number),
        balanceDate,
        // Without a running-balance column the true balance is unknown.
        isStale: latest === undefined,
      },
    ]);
  }

  fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.date.getTime() >= since.getTime())
        .map((r) => ({
          accountExternalId: this.account.externalId,
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
