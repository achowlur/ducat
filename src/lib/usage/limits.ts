import type { PrismaClient } from '../../generated/prisma/client';
import { databaseFailure } from '../ui/dbHealth';
import { dateTime } from '../ui/format';
import { pendingUsage, usageDay, usageMonth, type UsageMetric } from './meter';

/**
 * The free-plan allowances this instance runs inside, and how close the
 * counted usage (meter.ts) is to each.
 *
 * Each limit is the host's published free plan, checked on the date it carries.
 * A host that changes its plan changes this file; nothing here is read from the
 * host, because the app makes no call to any host's account API.
 */
export const LIMITS_CHECKED = '2026-10-18';

export const TURSO_FREE = { rowsRead: 500_000_000, rowsWritten: 10_000_000, storageGb: 5 } as const;
export const VERCEL_HOBBY = { invocations: 1_000_000, activeCpuHours: 4, transferGb: 100, functionsStorageGb: 10 } as const;
export const SIMPLEFIN_DAILY_REQUESTS = 24;
/**
 * Where "Sync now" stops for the day. A sync costs the bridge one or two
 * requests (the account list, then a longer window when the gap needs one), so
 * stopping here leaves the nightly cron its run inside the 24.
 */
export const SIMPLEFIN_SYNC_NOW_CAP = 20;

/** At or past this share of an allowance (used, or on pace by month end) a line warns. */
export const WARN_SHARE = 0.8;

export type UsageCounts = Partial<Record<UsageMetric, number>>;

export interface UsageReading {
  month: string;
  /** This month's totals. */
  monthly: UsageCounts;
  /** simplefin.requests today (UTC). */
  simplefinToday: number;
  /** The most simplefin.requests on any one UTC day this month. */
  simplefinBusiestDay: number;
  /** When counting began this month, if after the month began. */
  countedSince: Date | null;
}

export interface UsageLine {
  service: 'Turso' | 'Vercel' | 'SimpleFIN';
  label: string;
  used: number;
  limit: number;
  /** used / limit. */
  share: number;
  /** Projected share at month end at this month's rate; null when too early to say. */
  paceShare: number | null;
  warn: boolean;
}

/** Whether counting began after this month did, so its figures miss the start. */
export function countedPartway(reading: UsageReading): boolean {
  if (reading.countedSince === null) return false;
  return reading.countedSince.getTime() - monthBounds(reading.month).start.getTime() > 3_600_000;
}

function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/**
 * The month-end share at the rate counted so far, from when counting began.
 * Null under a day of counting: one busy hour extrapolated to a month is noise.
 */
export function paceShareOf(used: number, limit: number, reading: UsageReading, now: Date): number | null {
  const { start, end } = monthBounds(reading.month);
  const from = reading.countedSince !== null && reading.countedSince > start ? reading.countedSince : start;
  const counted = now.getTime() - from.getTime();
  if (counted < 86_400_000) return null;
  const projected = used + (used / counted) * Math.max(0, end.getTime() - now.getTime());
  return projected / limit;
}

function line(
  service: UsageLine['service'],
  label: string,
  used: number,
  limit: number,
  reading: UsageReading,
  now: Date,
): UsageLine {
  const share = used / limit;
  const paceShare = paceShareOf(used, limit, reading, now);
  return { service, label, used, limit, share, paceShare, warn: share >= WARN_SHARE || (paceShare ?? 0) >= 1 };
}

export function usageLines(reading: UsageReading, now: Date): UsageLine[] {
  const m = reading.monthly;
  const simplefin: UsageLine = {
    service: 'SimpleFIN',
    label: 'requests today',
    used: reading.simplefinToday,
    limit: SIMPLEFIN_DAILY_REQUESTS,
    share: reading.simplefinToday / SIMPLEFIN_DAILY_REQUESTS,
    paceShare: null,
    warn: Math.max(reading.simplefinToday, reading.simplefinBusiestDay) >= SIMPLEFIN_DAILY_REQUESTS * WARN_SHARE,
  };
  return [
    line('Turso', 'rows read', m['turso.rowsRead'] ?? 0, TURSO_FREE.rowsRead, reading, now),
    line('Turso', 'rows written', m['turso.rowsWritten'] ?? 0, TURSO_FREE.rowsWritten, reading, now),
    line('Vercel', 'requests served', m['app.requests'] ?? 0, VERCEL_HOBBY.invocations, reading, now),
    simplefin,
  ];
}

/**
 * This month's counts in one statement. Null when this database has no
 * UsageCount table yet (deployed ahead of its schema push): the section says
 * so, and the rest of the page still renders.
 */
export async function readUsage(prisma: PrismaClient, now: Date = new Date()): Promise<UsageReading | null> {
  const month = usageMonth(now);
  const { end } = monthBounds(month);
  let rows: { period: string; metric: string; count: bigint | number }[];
  try {
    rows = await prisma.usageCount.findMany({
      where: { period: { gte: month, lt: usageMonth(end) } },
      select: { period: true, metric: true, count: true },
    });
  } catch (error) {
    if (databaseFailure(error)?.kind === 'no-tables') return null;
    throw error;
  }
  const monthly: UsageCounts = {};
  const today = usageDay(now);
  let simplefinToday = 0;
  let simplefinBusiestDay = 0;
  for (const row of rows) {
    const n = Number(row.count);
    if (row.period === month) monthly[row.metric as UsageMetric] = n;
    else if (row.metric === 'simplefin.requests') {
      simplefinBusiestDay = Math.max(simplefinBusiestDay, n);
      if (row.period === today) simplefinToday = n;
    }
  }
  const since = monthly['meter.since'];
  return {
    month,
    monthly,
    simplefinToday,
    simplefinBusiestDay,
    countedSince: since === undefined ? null : new Date(since * 1000),
  };
}

/** The day the month's allowances reset (UTC), for "by Nov 1". */
export function usageResetsOn(reading: UsageReading): Date {
  return monthBounds(reading.month).end;
}

/** How long one server instance reuses a reading for the banner. */
export const USAGE_CACHE_MS = 10 * 60_000;

const globalForUsage = globalThis as unknown as { ducatUsageReading?: { at: number; reading: UsageReading | null } };

/**
 * readUsage for the banner every page carries: one statement per server
 * instance per USAGE_CACHE_MS, not one per page. Limits move over days, and a
 * banner that cost a round trip on every page would spend the allowance it
 * guards.
 */
export async function readUsageCached(prisma: PrismaClient, now: Date = new Date()): Promise<UsageReading | null> {
  const cached = globalForUsage.ducatUsageReading;
  if (
    cached !== undefined &&
    now.getTime() - cached.at < USAGE_CACHE_MS &&
    (cached.reading === null || cached.reading.month === usageMonth(now))
  ) {
    return cached.reading;
  }
  const reading = await readUsage(prisma, now);
  globalForUsage.ducatUsageReading = { at: now.getTime(), reading };
  return reading;
}

export function clearUsageCache(): void {
  delete globalForUsage.ducatUsageReading;
}

/**
 * Today's SimpleFIN requests as this instance knows them: what is stored, plus
 * what it has counted and not yet flushed (the meter writes after a response,
 * so a second tap a moment after the first would otherwise not see it).
 */
export async function simplefinRequestsToday(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const stored = (await readUsage(prisma, now))?.simplefinToday ?? 0;
  return stored + (pendingUsage()[`${usageDay(now)}|simplefin.requests`] ?? 0);
}

/**
 * Why "Sync now" refuses today, or null when it may run. The bridge disables a
 * token that keeps passing 24 requests a day, and only the cron, which the
 * data depends on, is allowed to spend what is left past the cap.
 */
export function syncNowRefusal(requestsToday: number, now: Date = new Date()): string | null {
  if (requestsToday < SIMPLEFIN_SYNC_NOW_CAP) return null;
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return (
    `SimpleFIN has had ${requestsToday} requests today, and it disables a token that keeps going past ${SIMPLEFIN_DAILY_REQUESTS} a day. ` +
    `Sync now is off until ${dateTime(resets)} so the nightly sync still runs.`
  );
}
