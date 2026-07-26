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
      missing: [],
    });
  });

  it('names the accounts whose history starts after the period does', () => {
    expect(periodCoverage('2025-06', accounts)).toMatchObject({
      covered: 2,
      complete: false,
      missing: ['Visa'],
    });
    expect(periodCoverage('2022-06', accounts)).toMatchObject({
      covered: 1,
      complete: false,
      missing: ['Checking', 'Visa'],
    });
  });

  // The month an account's history begins is only partially covered by it —
  // counting it as complete is exactly how a coverage-start artifact gets
  // mistaken for a real spending jump.
  it('does not count an account that starts mid-period as covering it', () => {
    expect(periodCoverage('2025-01', accounts).missing).toContain('Checking');
    expect(periodCoverage('2025-02', accounts).missing).not.toContain('Checking');
  });

  it('treats an account with no transactions as covering nothing', () => {
    expect(periodCoverage('2026-06', [acct('Empty', null)]).complete).toBe(false);
  });
});
