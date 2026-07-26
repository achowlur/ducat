import { describe, expect, it } from 'vitest';
import {
  enumeratePeriods,
  granularityOfKey,
  inPeriod,
  periodEndExclusive,
  periodKey,
  periodStart,
  previousPeriodKey,
} from './periods';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('periodKey', () => {
  it('formats month, quarter, and year keys', () => {
    const d = utc(2026, 7, 12);
    expect(periodKey(d, 'MONTH')).toBe('2026-07');
    expect(periodKey(d, 'QUARTER')).toBe('2026-Q3');
    expect(periodKey(d, 'YEAR')).toBe('2026');
  });

  it('computes ISO weeks, including year-boundary weeks', () => {
    // Jan 1 2026 is a Thursday -> belongs to 2026-W01
    expect(periodKey(utc(2026, 1, 1), 'WEEK')).toBe('2026-W01');
    // Dec 29 2025 (Monday) opens the week containing Jan 1 2026
    expect(periodKey(utc(2025, 12, 29), 'WEEK')).toBe('2026-W01');
    // Dec 30 2024 (Monday) belongs to 2025-W01
    expect(periodKey(utc(2024, 12, 30), 'WEEK')).toBe('2025-W01');
    expect(periodKey(utc(2026, 7, 12), 'WEEK')).toBe('2026-W28');
  });
});

describe('granularityOfKey', () => {
  it('recognizes each format and rejects garbage', () => {
    expect(granularityOfKey('2026')).toBe('YEAR');
    expect(granularityOfKey('2026-Q3')).toBe('QUARTER');
    expect(granularityOfKey('2026-07')).toBe('MONTH');
    expect(granularityOfKey('2026-W28')).toBe('WEEK');
    expect(() => granularityOfKey('julio')).toThrow();
  });
});

describe('periodStart / periodEndExclusive', () => {
  it('bounds months correctly', () => {
    expect(periodStart('2026-07')).toEqual(utc(2026, 7, 1));
    expect(periodEndExclusive('2026-07')).toEqual(utc(2026, 8, 1));
    expect(periodEndExclusive('2025-12')).toEqual(utc(2026, 1, 1));
  });

  it('bounds ISO weeks correctly', () => {
    // 2026-W01 runs Mon Dec 29 2025 .. Sun Jan 4 2026
    expect(periodStart('2026-W01')).toEqual(utc(2025, 12, 29));
    expect(periodEndExclusive('2026-W01')).toEqual(utc(2026, 1, 5));
  });

  it('bounds quarters and years', () => {
    expect(periodStart('2026-Q3')).toEqual(utc(2026, 7, 1));
    expect(periodEndExclusive('2026-Q3')).toEqual(utc(2026, 10, 1));
    expect(periodStart('2026')).toEqual(utc(2026, 1, 1));
    expect(periodEndExclusive('2026')).toEqual(utc(2027, 1, 1));
  });
});

describe('previousPeriodKey', () => {
  it('steps back across year boundaries', () => {
    expect(previousPeriodKey('2026-01')).toBe('2025-12');
    expect(previousPeriodKey('2026-Q1')).toBe('2025-Q4');
    expect(previousPeriodKey('2026')).toBe('2025');
    expect(previousPeriodKey('2026-W01')).toBe('2025-W52');
  });
});

describe('enumeratePeriods', () => {
  it('lists consecutive months inclusive of both endpoints', () => {
    expect(enumeratePeriods(utc(2025, 11, 15), utc(2026, 2, 1), 'MONTH')).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02',
    ]);
  });

  it('returns empty when from is after to', () => {
    expect(enumeratePeriods(utc(2026, 2, 1), utc(2026, 1, 1), 'MONTH')).toEqual([]);
  });
});

describe('inPeriod', () => {
  it('is inclusive of start, exclusive of next period start', () => {
    expect(inPeriod(utc(2026, 7, 1), '2026-07')).toBe(true);
    expect(inPeriod(new Date(Date.UTC(2026, 6, 31, 23, 59, 59)), '2026-07')).toBe(true);
    expect(inPeriod(utc(2026, 8, 1), '2026-07')).toBe(false);
  });
});

describe('memoized period bounds', () => {
  // Bounds are cached because inPeriod is called hundreds of thousands of
  // times per insight run. The cache holds NUMBERS and every caller gets a
  // fresh Date — caching the Date itself would let one caller's mutation
  // silently redefine the period for everyone after it.
  it('hands every caller its own Date, so a mutation cannot poison the cache', () => {
    const first = periodStart('2026-07');
    first.setUTCDate(20);
    expect(periodStart('2026-07').toISOString()).toBe('2026-07-01T00:00:00.000Z');

    const end = periodEndExclusive('2026-07');
    end.setUTCFullYear(1999);
    expect(periodEndExclusive('2026-07').toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(inPeriod(utc(2026, 7, 15), '2026-07')).toBe(true);
  });

  it('returns identical bounds on a repeat call for every granularity', () => {
    for (const key of ['2026', '2026-Q3', '2026-07', '2026-W28']) {
      expect(periodStart(key).getTime()).toBe(periodStart(key).getTime());
      expect(periodEndExclusive(key).getTime()).toBe(periodEndExclusive(key).getTime());
    }
  });
});
