import { describe, expect, it } from 'vitest';
import { judgePay, oneOffPay } from './oneOffPay';
import type { TxnData } from './types';

// Invented: an employer paying every two weeks, a raise, bonuses beside
// paychecks, and a bank's interest that differs every month.

let nextId = 0;
const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 9, 12);

function deposit(date: Date, amount: number, payer = 'harbor works payroll', income = true, description?: string): TxnData {
  return {
    id: `p${++nextId}`,
    accountId: 'checking',
    date,
    amount,
    description: description ?? payer.toUpperCase(),
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

describe('judgePay', () => {
  it('leaves regular paychecks alone, a raise included from both sides of it', () => {
    const pay = judgePay(paychecks(16, 8));
    expect(pay.oneOffs).toEqual([]);
    expect(pay.paychecks).toHaveLength(16);
  });

  // Two bonuses a month apart, each beside a paycheck: never a raise.
  it('finds a bonus paid beside a paycheck, even one that comes back a month later', () => {
    const bonusA = deposit(payday(9), 3000);
    const bonusB = deposit(payday(11), 3000);
    const pay = judgePay([...paychecks(16, 8), bonusA, bonusB]);
    expect(pay.oneOffs.map((f) => f.id)).toEqual([bonusA.id, bonusB.id]);
    expect(pay.paychecks).toHaveLength(16);
  });

  it('knows a bonus beside the newest paycheck at once', () => {
    const recent = deposit(payday(15), 1500);
    expect(oneOffPay([...paychecks(16), recent]).map((f) => f.id)).toEqual([recent.id]);
  });

  // The paycheck itself at a new amount is pay, the day it lands.
  it("counts a raise's first paycheck as a paycheck, not a one-off", () => {
    const pay = judgePay(paychecks(10, 9));
    expect(pay.oneOffs).toEqual([]);
    expect(pay.paychecks.at(-1)?.amount).toBe(2100);
  });

  it('tolerates a bonus paid on a day of its own', () => {
    const own = deposit(new Date(start + (5 * 14 + 4) * DAY), 2500);
    expect(oneOffPay([...paychecks(14), own]).map((f) => f.id)).toEqual([own.id]);
  });

  it('never judges a payer without a salary-like run, interest, or money that is not income', () => {
    const interest = [12.4, 12.4, 12.4, 14.2, 13.8, 15.0].map((a, i) =>
      deposit(new Date(start + i * 30 * DAY), a, 'harbor savings', true, 'INTEREST PAYMENT'),
    );
    const refund = deposit(payday(3), 80, 'oakline hardware', false);
    expect(oneOffPay([...paychecks(8), ...interest, refund])).toEqual([]);
  });
});
