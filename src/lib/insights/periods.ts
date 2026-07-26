import type { PeriodGranularity } from '../../types/contracts';

/**
 * Period keys: WEEK "2026-W28" (ISO week) | MONTH "2026-07" |
 * QUARTER "2026-Q3" | YEAR "2026". All date math is UTC.
 */

const DAY_MS = 86_400_000;

function isoWeekParts(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const year = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week = 1 + Math.round((date.getTime() - jan4.getTime()) / DAY_MS / 7 - (3 - jan4DayNum) / 7);
  return { year, week };
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4.getTime() - jan4DayNum * DAY_MS);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * DAY_MS);
}

export function periodKey(date: Date, granularity: PeriodGranularity): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  switch (granularity) {
    case 'WEEK': {
      const { year, week } = isoWeekParts(date);
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'MONTH':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'QUARTER':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'YEAR':
      return String(y);
  }
}

export function granularityOfKey(key: string): PeriodGranularity {
  if (/^\d{4}$/.test(key)) return 'YEAR';
  if (/^\d{4}-Q[1-4]$/.test(key)) return 'QUARTER';
  if (/^\d{4}-W\d{2}$/.test(key)) return 'WEEK';
  if (/^\d{4}-\d{2}$/.test(key)) return 'MONTH';
  throw new Error(`Unrecognized period key: ${key}`);
}

function startOf(key: string, g: PeriodGranularity): Date {
  switch (g) {
    case 'YEAR':
      return new Date(Date.UTC(Number(key), 0, 1));
    case 'QUARTER': {
      const [y, q] = key.split('-Q');
      return new Date(Date.UTC(Number(y), (Number(q) - 1) * 3, 1));
    }
    case 'MONTH': {
      const [y, m] = key.split('-');
      return new Date(Date.UTC(Number(y), Number(m) - 1, 1));
    }
    case 'WEEK': {
      const [y, w] = key.split('-W');
      return isoWeekStart(Number(y), Number(w));
    }
  }
}

function endOf(start: Date, g: PeriodGranularity): Date {
  switch (g) {
    case 'YEAR':
      return new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
    case 'QUARTER':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1));
    case 'MONTH':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    case 'WEEK':
      return new Date(start.getTime() + 7 * DAY_MS);
  }
}

/**
 * Period bounds as epoch milliseconds, memoized. A period key is immutable —
 * "2026-07" names the same instants forever — so a cache entry cannot go
 * stale, and the work it skips (a regex to classify the key, a split, UTC
 * date math, two Date allocations) was being repeated on every one of the
 * hundreds of thousands of `inPeriod` calls an insight run makes.
 *
 * Numbers, not Dates: every caller still gets its own Date, so none of them
 * can mutate what the next one reads.
 */
const BOUNDS = new Map<string, { start: number; end: number }>();

function bounds(key: string): { start: number; end: number } {
  const cached = BOUNDS.get(key);
  if (cached !== undefined) return cached;
  const g = granularityOfKey(key);
  const start = startOf(key, g);
  const computed = { start: start.getTime(), end: endOf(start, g).getTime() };
  BOUNDS.set(key, computed);
  return computed;
}

/** Inclusive start of the period (UTC midnight). */
export function periodStart(key: string): Date {
  return new Date(bounds(key).start);
}

/** Exclusive end: the instant the next period starts. */
export function periodEndExclusive(key: string): Date {
  return new Date(bounds(key).end);
}

export function previousPeriodKey(key: string): string {
  const g = granularityOfKey(key);
  const start = periodStart(key);
  return periodKey(new Date(start.getTime() - DAY_MS), g);
}

/** All period keys from the one containing `from` through the one containing `to`. */
export function enumeratePeriods(from: Date, to: Date, granularity: PeriodGranularity): string[] {
  if (from.getTime() > to.getTime()) return [];
  const keys: string[] = [];
  let cursor = periodKey(from, granularity);
  const last = periodKey(to, granularity);
  keys.push(cursor);
  while (cursor !== last) {
    cursor = periodKey(periodEndExclusive(cursor), granularity);
    keys.push(cursor);
    if (keys.length > 10_000) throw new Error('enumeratePeriods runaway');
  }
  return keys;
}

export function inPeriod(date: Date, key: string): boolean {
  const { start, end } = bounds(key);
  const t = date.getTime();
  return t >= start && t < end;
}
