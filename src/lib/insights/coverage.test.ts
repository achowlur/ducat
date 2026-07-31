import { describe, expect, it } from 'vitest';
import { periodCoverage, type AccountCoverage } from './coverage';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

const acct = (name: string, first: Date | null): AccountCoverage => ({
  accountId: name,
  name,
  firstTransaction: first,
});

describe('periodCoverage', () => {
  const accounts = [
    acct('Brokerage', utc(2021, 3, 1)), // deep history
    acct('Checking', utc(2025, 1, 15)), // 18-month CSV
    acct('Visa', utc(2026, 4, 27)), // 90-day feed only
  ];

  it('reports every account as covering a period well inside all histories', () => {
    expect(periodCoverage('2026-06', accounts)).toMatchObject({
      covered: 3,
      total: 3,
      complete: true,
      gaps: [],
    });
  });

  it('names the accounts whose history starts after the period does', () => {
    expect(periodCoverage('2025-06', accounts)).toMatchObject({ covered: 2, complete: false });
    expect(periodCoverage('2025-06', accounts).gaps.map((g) => g.name)).toEqual(['Visa']);
    expect(periodCoverage('2022-06', accounts).gaps.map((g) => g.name)).toEqual(['Checking', 'Visa']);
  });

  // The month an account's history begins is only partially covered by it —
  // counting it as complete is exactly how a coverage-start artifact gets
  // mistaken for a real spending jump.
  it('does not count an account that starts mid-period as covering it', () => {
    expect(periodCoverage('2025-01', accounts).gaps.map((g) => g.name)).toContain('Checking');
    expect(periodCoverage('2025-02', accounts).gaps.map((g) => g.name)).not.toContain('Checking');
  });

  /**
   * The two gaps are different claims and the notice used to make only the
   * harsher one. An account that started mid-period is IN the totals and known
   * to the penny; an account with no data at all understates them by an amount
   * nobody can compute. Reporting a $104.32 transit card as though a mortgage
   * were missing is what this separation exists to stop.
   */
  describe('tells a mid-period start apart from an absent account', () => {
    const withSpend = [
      acct('Brokerage', utc(2021, 3, 1)),
      { ...acct('New card', utc(2026, 7, 11)), periodSpending: 40.25 },
      acct('Never used', utc(2026, 9, 1)),
    ];

    it('classifies a contributing account as a mid-period start, not a hole', () => {
      const c = periodCoverage('2026-07', withSpend);
      expect(c.gaps.find((g) => g.name === 'New card')).toEqual({
        name: 'New card',
        kind: 'STARTED_MID_PERIOD',
        contributed: 40.25,
      });
      expect(c.contributedByPartial).toBe(40.25);
    });

    it('classifies an account with nothing in the period as a real hole', () => {
      const c = periodCoverage('2026-07', withSpend);
      expect(c.gaps.find((g) => g.name === 'Never used')?.kind).toBe('NO_DATA');
      expect(c.hasUnknownShortfall).toBe(true);
    });

    it('reports no unknown shortfall when every gap is a mid-period start', () => {
      const c = periodCoverage('2026-07', withSpend.slice(0, 2));
      expect(c.complete).toBe(false);
      expect(c.hasUnknownShortfall).toBe(false);
      expect(c.contributedByPartial).toBe(40.25);
    });
  });

  it('treats an account with no transactions as covering nothing', () => {
    expect(periodCoverage('2026-06', [acct('Empty', null)]).complete).toBe(false);
  });
});
