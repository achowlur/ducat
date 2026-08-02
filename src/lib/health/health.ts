import type { PrismaClient } from '../../generated/prisma/client';
import { MORTGAGE_RATE_KEY, parseMortgageRate, type StoredMortgageRate } from '../rates/mortgageRate';
import { PROVIDER_TRUST_CARDS } from './providers';
import type {
  GappedAccountSignal,
  LastSyncInfo,
  ProviderHealth,
  ProviderId,
  ProviderStatusLevel,
  StaleAccountSignal,
} from './types';

export interface HealthOptions {
  /** A successful sync older than this counts as overdue. */
  syncOverdueDays: number;
  /** An account balanceDate older than this counts as stale. */
  staleBalanceDays: number;
  /** Recent window for transaction-gap detection. */
  gapWindowDays: number;
  /** Only accounts averaging at least this many txns/month are gap-checked. */
  gapMinTypicalPerMonth: number;
  /** Recent volume below this fraction of typical flags a gap. */
  gapThresholdRatio: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = {
  syncOverdueDays: 3,
  staleBalanceDays: 5,
  gapWindowDays: 30,
  gapMinTypicalPerMonth: 4,
  gapThresholdRatio: 0.25,
};

const DAY_MS = 86_400_000;

interface AccountLite {
  id: string;
  name: string;
  type: string;
  balanceDate: Date;
  isStale: boolean;
}

interface TxnLite {
  accountId: string;
  date: Date;
}

/** Pure signal: accounts whose balance has silently stopped updating. */
export function findStaleAccounts(
  accounts: AccountLite[],
  now: Date,
  staleBalanceDays: number,
): StaleAccountSignal[] {
  return accounts
    .map((a) => ({
      accountId: a.id,
      accountName: a.name,
      balanceDate: a.balanceDate,
      daysStale: Math.floor((now.getTime() - a.balanceDate.getTime()) / DAY_MS),
    }))
    .filter((s) => s.daysStale > staleBalanceDays)
    .sort((a, b) => b.daysStale - a.daysStale);
}

/**
 * Pure signal: accounts whose recent transaction volume collapsed vs their
 * own history — the fingerprint of an upstream feed silently dropping data
 * (accounts still listed, balances may even update, transactions missing).
 *
 * INVESTMENT accounts are exempt, because transaction volume is not a liveness
 * signal for them and pretending otherwise cries wolf most of the year. Their
 * rows are overwhelmingly DIVIDEND RECEIVED, which arrive in quarter-end
 * clusters: one real brokerage account here ran 52 transactions in June and 2
 * in July, so a rolling 30-day window against a flat monthly mean flagged it
 * every off-quarter month. Widening the window does not fix it either — it
 * drags the BASELINE back into the CSV-backfilled era, which captured every
 * trade and statement line where the live feed does not, and at 90 days two
 * accounts landed within 0.03 of the threshold instead of one over it.
 *
 * Nothing is lost by the exemption. A dead brokerage feed stops refreshing the
 * BALANCE, which `findStaleAccounts` catches in five days — sooner than a
 * volume gap could, and without depending on whether a dividend was due.
 */
const GAP_EXEMPT_TYPES = new Set(['INVESTMENT']);

export function findGappedAccounts(
  accounts: AccountLite[],
  txns: TxnLite[],
  now: Date,
  options: Pick<HealthOptions, 'gapWindowDays' | 'gapMinTypicalPerMonth' | 'gapThresholdRatio'>,
): GappedAccountSignal[] {
  const windowStart = now.getTime() - options.gapWindowDays * DAY_MS;
  const signals: GappedAccountSignal[] = [];

  for (const account of accounts) {
    if (GAP_EXEMPT_TYPES.has(account.type)) continue;
    const own = txns.filter((t) => t.accountId === account.id);
    const historical = own.filter((t) => t.date.getTime() < windowStart);
    if (historical.length === 0) continue;

    const oldest = historical.reduce((min, t) => Math.min(min, t.date.getTime()), Infinity);
    const historyMonths = (windowStart - oldest) / (30 * DAY_MS);
    if (historyMonths < 1) continue; // not enough history to define "typical"

    const typicalPerMonth = historical.length / historyMonths;
    if (typicalPerMonth < options.gapMinTypicalPerMonth) continue;

    const recentCount = own.length - historical.length;
    const expectedInWindow = typicalPerMonth * (options.gapWindowDays / 30);
    if (recentCount < expectedInWindow * options.gapThresholdRatio) {
      signals.push({
        accountId: account.id,
        accountName: account.name,
        typicalPerMonth: Math.round(typicalPerMonth * 10) / 10,
        recentCount,
        windowDays: options.gapWindowDays,
      });
    }
  }
  return signals;
}

/**
 * Age of the STORED rate observation (the series' own date, never the fetch
 * time) that flags the FRED feed. The series is daily but publishes business
 * days with a one-business-day lag, so a long holiday weekend legitimately
 * reads four or five days old — seven is the first age that can only mean
 * the fetch or the release has stalled. Same reasoning as staleBalanceDays: 5,
 * one notch looser because market holidays cluster harder than bank weekends.
 */
export const RATE_STALE_DAYS = 7;

/**
 * Pure signal for the FRED rate feed, which has no accounts and writes no
 * SyncLog: its health IS the stored observation — how old the series' own
 * date is, and whether the last fetch recorded a failure. LOCAL signals only,
 * like everything in this module. Null when nothing was ever stored, so an
 * instance that never opted in carries no FRED health at all.
 */
export function deriveFredRateStatus(
  stored: StoredMortgageRate | null,
  now: Date,
): { status: ProviderStatusLevel; reasons: string[] } | null {
  if (stored === null) return null;
  const reasons: string[] = [];
  let status: ProviderStatusLevel = 'OK';
  const warn = (reason: string) => {
    reasons.push(reason);
    if (status === 'OK') status = 'WARN';
  };

  if (stored.lastError !== null) warn(`Last rate fetch failed: ${stored.lastError.message}`);
  if (stored.observation === null) {
    warn('No rate observation stored yet');
  } else {
    const daysOld = Math.floor(
      (now.getTime() - Date.parse(stored.observation.observationDate)) / DAY_MS,
    );
    if (daysOld > RATE_STALE_DAYS) {
      warn(`Stored rate observation is ${daysOld} days old (${stored.observation.observationDate})`);
    }
  }
  if (reasons.length === 0) reasons.push('All signals normal');
  // Informational, last — reasons[0] stays the most important line, the same
  // ordering contract deriveStatus keeps for expected feed notices.
  if (stored.observation !== null) {
    reasons.push(
      `Latest stored: ${stored.observation.ratePct}% observed ${stored.observation.observationDate}`,
    );
  }
  return { status, reasons };
}

/**
 * Feed messages that describe how a provider WORKS rather than something
 * wrong with it. SimpleFIN's free tier caps a request at 90 days and reports
 * that on every single sync, so treating it as a warning parked the provider
 * on amber permanently — and a light that never goes green is one nobody
 * reads. Matched narrowly on purpose: any other feed message still warns.
 */
const EXPECTED_FEED_NOTICES = [/date range exceeds limit/i];

export function isExpectedFeedNotice(text: string): boolean {
  return EXPECTED_FEED_NOTICES.some((pattern) => pattern.test(text));
}

function deriveStatus(
  lastSync: LastSyncInfo | null,
  syncOverdue: boolean,
  staleAccounts: StaleAccountSignal[],
  gappedAccounts: GappedAccountSignal[],
): { status: ProviderStatusLevel; reasons: string[] } {
  if (lastSync === null) {
    return { status: 'UNKNOWN', reasons: ['Never synced'] };
  }
  const reasons: string[] = [];
  let status: ProviderStatusLevel = 'OK';
  const warn = (reason: string) => {
    reasons.push(reason);
    if (status === 'OK') status = 'WARN';
  };

  if (!lastSync.ok) {
    reasons.push(`Last sync failed: ${lastSync.errorText ?? 'unknown error'}`);
    status = 'ERROR';
  }
  // Expected notices are reported but never degrade status, and they come
  // last so `reasons[0]` is always the most important thing about a provider
  // (Overview shows only that first line).
  const notices: string[] = [];
  for (const err of lastSync.feedErrors) {
    if (isExpectedFeedNotice(err)) notices.push(`Expected for this provider: ${err}`);
    else warn(`Provider reported: ${err}`);
  }
  if (syncOverdue) warn('No successful sync recently');
  for (const s of staleAccounts) {
    warn(`"${s.accountName}" balance hasn't updated in ${s.daysStale} days`);
  }
  for (const g of gappedAccounts) {
    warn(
      `"${g.accountName}" transactions dropped off: ${g.recentCount} in the last ${g.windowDays} days vs ~${g.typicalPerMonth}/month historically`,
    );
  }
  if (reasons.length === 0) reasons.push('All signals normal');
  reasons.push(...notices);
  return { status, reasons };
}

/**
 * Derives provider health purely from LOCAL data: sync history, feed
 * warnings recorded at sync time, balance staleness, and transaction-volume
 * gaps. Deliberately makes no network requests — opening the app must not
 * announce itself to anyone (see HARD RULES).
 */
export async function getProviderHealth(
  prisma: PrismaClient,
  options: HealthOptions = DEFAULT_HEALTH_OPTIONS,
  now: Date = new Date(),
): Promise<ProviderHealth[]> {
  const connectorTypes = Object.keys(PROVIDER_TRUST_CARDS) as ProviderId[];
  const results: ProviderHealth[] = [];

  for (const connectorType of connectorTypes) {
    if (connectorType === 'FRED') {
      const row = await prisma.setting.findUnique({ where: { key: MORTGAGE_RATE_KEY } });
      const stored = parseMortgageRate(row?.value ?? null);
      const derived = deriveFredRateStatus(stored, now);
      if (derived !== null) {
        results.push({
          connectorType,
          trustCard: PROVIDER_TRUST_CARDS[connectorType],
          status: derived.status,
          reasons: derived.reasons,
          lastSync: null,
          // The last successful FETCH — an instant, so /providers' header
          // dates the feed the same way it dates a connector's sync.
          lastSuccessfulSyncAt:
            stored === null || stored.observation === null
              ? null
              : new Date(stored.observation.fetchedAt),
          syncOverdue: false,
          accountCount: 0,
          staleAccounts: [],
          gappedAccounts: [],
        });
      }
      continue;
    }

    const accounts = await prisma.account.findMany({
      where: { connectorType },
      select: { id: true, name: true, type: true, balanceDate: true, isStale: true },
    });
    const lastLog = await prisma.syncLog.findFirst({
      where: { connectorType },
      orderBy: { finishedAt: 'desc' },
    });
    const lastOkLog = lastLog?.ok === true
      ? lastLog
      : await prisma.syncLog.findFirst({
          where: { connectorType, ok: true },
          orderBy: { finishedAt: 'desc' },
        });

    if (accounts.length === 0 && lastLog === null) continue; // provider unused

    const lastSync: LastSyncInfo | null = lastLog === null ? null : {
      at: lastLog.finishedAt,
      ok: lastLog.ok,
      errorText: lastLog.errorText,
      feedErrors: Array.isArray(lastLog.feedErrors) ? lastLog.feedErrors.map(String) : [],
    };
    const lastSuccessfulSyncAt = lastOkLog?.finishedAt ?? null;
    const syncOverdue =
      lastSuccessfulSyncAt === null ||
      now.getTime() - lastSuccessfulSyncAt.getTime() > options.syncOverdueDays * DAY_MS;

    // CSV is manual and point-in-time: overdue/stale signals would be
    // permanent false alarms, so only sync errors apply.
    const isPolling = connectorType !== 'CSV';
    const staleAccounts = isPolling ? findStaleAccounts(accounts, now, options.staleBalanceDays) : [];
    const txns = isPolling
      ? await prisma.transaction.findMany({
          where: { accountId: { in: accounts.map((a) => a.id) } },
          select: { accountId: true, date: true },
        })
      : [];
    const gappedAccounts = isPolling ? findGappedAccounts(accounts, txns, now, options) : [];

    const { status, reasons } = deriveStatus(
      lastSync,
      isPolling && syncOverdue,
      staleAccounts,
      gappedAccounts,
    );

    results.push({
      connectorType,
      trustCard: PROVIDER_TRUST_CARDS[connectorType],
      status,
      reasons,
      lastSync,
      lastSuccessfulSyncAt,
      syncOverdue: isPolling && syncOverdue,
      accountCount: accounts.length,
      staleAccounts,
      gappedAccounts,
    });
  }
  return results;
}
