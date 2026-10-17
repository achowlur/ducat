import { describe, expect, it } from 'vitest';
import { oneOffPay } from './oneOffPay';
import type { TxnData } from './types';

// Invented: an employer paying every two weeks, a raise, bonuses beside
// paychecks, and a bank's interest that differs every month.

let nextId = 0;
const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 9, 12);

function deposit(date: Date, amount: number, payer = 'harbor works payroll', income = true): TxnData {
  return {
    id: `p${++nextId}`,
    accountId: 'checking',
    date,
    amount,
    description: payer.toUpperCase(),
    normalizedMerchant: payer,
    flow: 'INFLOW',
    categoryId: income ? 'income' : 'dining',
    categoryName: income ? 'Income' : 'Dining',
    categoryIsIncome: income,
    reimbursesId: null,
  };
}

/** `count` paydays two weeks apart, the first `raiseAt` at 2,000.00 and the rest at 2,100.00. */
function paychecks(count: number, raiseAt = count): TxnData[] {
  return Array.from({ length: count }, (_, i) => deposit(new Date(start + i * 14 * DAY), i < raiseAt ? 2000 : 2100));
}
const payday = (i: number) => new Date(start + i * 14 * DAY);

describe('oneOffPay', () => {
  it('leaves regular paychecks alone, a raise included from both sides of it', () => {
    expect(oneOffPay(paychecks(16, 8))).toEqual([]);
  });

  it('finds a bonus paid beside a paycheck, even one that comes back a month later', () => {
    const bonusA = deposit(payday(9), 3000);
    const bonusB = deposit(payday(11), 3000);
    const found = oneOffPay([...paychecks(16, 8), bonusA, bonusB]);
    expect(found.map((f) => [f.id, f.amount, f.settled])).toEqual([
      [bonusA.id, 3000, true],
      [bonusB.id, 3000, true],
    ]);
  });

  it('leaves a bonus too recent to judge unsettled, and settles it once two paydays pass without it', () => {
    const recent = deposit(payday(15), 1500);
    expect(oneOffPay([...paychecks(16), recent])).toEqual([
      expect.objectContaining({ id: recent.id, settled: false }),
    ]);
    const later = [...paychecks(18), recent];
    expect(oneOffPay(later)).toEqual([expect.objectContaining({ id: recent.id, settled: true })]);
  });

  it('counts a raise as a one-off only until it repeats', () => {
    const justRaised = paychecks(10, 9);
    expect(oneOffPay(justRaised)).toEqual([expect.objectContaining({ amount: 2100, settled: false })]);
    expect(oneOffPay(paychecks(13, 9))).toEqual([]);
  });

  it('tolerates a bonus paid on a day of its own', () => {
    const own = deposit(new Date(start + (5 * 14 + 4) * DAY), 2500);
    expect(oneOffPay([...paychecks(14), own]).map((f) => f.id)).toEqual([own.id]);
  });

  it('never judges a payer without a salary-like run, or money that is not income', () => {
    const interest = [12.4, 13.1, 12.9, 14.2, 13.8, 15.0].map((a, i) => deposit(new Date(start + i * 30 * DAY), a, 'harbor savings'));
    const refund = deposit(payday(3), 80, 'oakline hardware', false);
    expect(oneOffPay([...paychecks(8), ...interest, refund])).toEqual([]);
  });
});
