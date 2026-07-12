import type {
  AccountType,
  Connector,
  NormalizedAccount,
  NormalizedTransaction,
} from '../../types/contracts';
import { normalizeMerchant } from './normalize';

/**
 * SimpleFIN Bridge connector (https://www.simplefin.org/protocol.html).
 *
 * Auth model, per HARD RULES: bank credentials live exclusively with the
 * SimpleFIN Bridge — this app only ever holds the access URL (a revocable,
 * read-only feed credential), which comes from .env.
 *
 * Protocol notes:
 * - The access URL embeds basic-auth credentials. fetch() rejects URLs with
 *   embedded credentials, so they're extracted into an Authorization header.
 * - Amounts arrive as signed strings, negative = money out — already our
 *   convention. balance-date/posted are unix seconds.
 * - Pending transactions are skipped: they mutate or vanish, which would
 *   corrupt the (accountId, externalId) dedupe key.
 */

interface SimplefinOrg {
  name?: string;
  domain?: string;
}

interface SimplefinTransaction {
  id: string;
  posted: number;
  amount: string;
  description?: string;
  payee?: string;
  pending?: boolean;
}

interface SimplefinAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  'balance-date': number;
  org?: SimplefinOrg;
  transactions?: SimplefinTransaction[];
}

export interface SimplefinResponse {
  errors?: string[];
  accounts?: SimplefinAccount[];
}

/**
 * SimpleFIN provides no account-type field, so type is inferred from
 * name/institution keywords. DEPOSITORY is the fallback; a wrong guess is
 * correctable in the DB and stays stable on re-sync (sync only sets type
 * at account creation).
 */
export function inferAccountType(accountName: string, orgName: string): AccountType {
  const haystack = `${accountName} ${orgName}`.toLowerCase();
  if (/credit|visa|mastercard|amex|discover it|card/.test(haystack)) return 'CREDIT';
  if (/loan|mortgage|heloc/.test(haystack)) return 'LOAN';
  if (/broker|invest|401k|401\(k\)|403b|ira|roth|hsa|fidelity|vanguard|schwab|etrade/.test(haystack)) {
    return 'INVESTMENT';
  }
  return 'DEPOSITORY';
}

/** Exchange a one-time setup token (base64 claim URL) for the access URL. */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const trimmed = setupToken.trim();
  const claimUrl = trimmed.startsWith('http')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8').trim();
  if (!claimUrl.startsWith('https://')) {
    throw new Error('Setup token did not decode to an https claim URL');
  }
  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Claim failed (${res.status}): setup tokens are single-use — generate a fresh one`);
  }
  return (await res.text()).trim();
}

export class SimplefinConnector implements Connector {
  readonly type = 'SIMPLEFIN';

  private readonly baseUrl: string;
  private readonly authHeader: string;
  private cached: SimplefinResponse | null = null;
  private cachedSince: number | null = null;
  private warnings: string[] = [];

  constructor(accessUrl: string) {
    const url = new URL(accessUrl);
    if (url.username === '' || url.password === '') {
      throw new Error('SimpleFIN access URL must embed credentials (https://user:pass@host/simplefin)');
    }
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  private async fetchData(since: Date): Promise<SimplefinResponse> {
    const sinceUnix = Math.floor(since.getTime() / 1000);
    if (this.cached !== null && this.cachedSince !== null && this.cachedSince <= sinceUnix) {
      return this.cached;
    }
    const res = await fetch(`${this.baseUrl}/accounts?start-date=${sinceUnix}`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) {
      throw new Error(`SimpleFIN request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as SimplefinResponse;
    if (data.errors !== undefined && data.errors.length > 0) {
      // SimpleFIN uses errors for warnings too (e.g. "connect a bank");
      // surface them without failing the sync. The sync pipeline persists
      // them to SyncLog via feedWarnings().
      this.warnings = [...new Set([...this.warnings, ...data.errors])];
      console.warn('SimpleFIN reported:', data.errors.join('; '));
    }
    this.cached = data;
    this.cachedSince = sinceUnix;
    return data;
  }

  feedWarnings(): string[] {
    return [...this.warnings];
  }

  async listAccounts(): Promise<NormalizedAccount[]> {
    // One API call serves both listAccounts and fetchTransactions — the
    // /accounts endpoint returns everything. 30 days back is plenty for
    // the account listing; fetchTransactions refetches if it needs more.
    const data = await this.fetchData(new Date(Date.now() - 30 * 86_400_000));
    return (data.accounts ?? []).map((a) => ({
      externalId: a.id,
      connectorType: this.type,
      institution: a.org?.name ?? a.org?.domain ?? 'Unknown',
      name: a.name,
      type: inferAccountType(a.name, a.org?.name ?? ''),
      currency: a.currency,
      balance: Number(a.balance),
      balanceDate: new Date(a['balance-date'] * 1000),
      isStale: false,
    }));
  }

  async fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
    const data = await this.fetchData(since);
    const txns: NormalizedTransaction[] = [];
    for (const account of data.accounts ?? []) {
      for (const t of account.transactions ?? []) {
        if (t.pending === true || t.posted === 0) continue;
        const date = new Date(t.posted * 1000);
        if (date.getTime() < since.getTime()) continue;
        const amount = Number(t.amount);
        const description = t.description ?? '';
        txns.push({
          accountExternalId: account.id,
          externalId: t.id,
          date,
          amount,
          description,
          normalizedMerchant: normalizeMerchant(t.payee !== undefined && t.payee !== '' ? t.payee : description),
          flow: amount >= 0 ? 'INFLOW' : 'OUTFLOW',
          source: this.type,
        });
      }
    }
    return txns;
  }
}
