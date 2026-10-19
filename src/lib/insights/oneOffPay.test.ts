import { describe, expect, it } from 'vitest';
import { computeCashFlowTrend } from './cashFlow';
import { irregularIncome, judgePay, oneOffPay } from './oneOffPay';
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

  // Invented: the bank renames "Acme Payroll direct dep" to "Acme Payroll"
  // two paydays before the newest, at a slightly higher amount. Judged apart,
  // the new name had too few deposits to be a payer, and its paychecks fell
  // to income from no regular source.
  it("judges a renamed payer's first paychecks with the run they continue, under its newest name", () => {
    const renamed = Array.from({ length: 12 }, (_, i) =>
      i < 10 ? deposit(payday(i), 2000, 'acme payroll direct dep') : deposit(payday(i), 2080, 'acme payroll'),
    );
    const pay = judgePay(renamed);
    expect(pay.oneOffs).toEqual([]);
    expect(pay.paychecks).toHaveLength(12);
    expect(new Set(pay.paychecks.map((p) => p.payer))).toEqual(new Set(['acme payroll']));
    expect(irregularIncome(renamed, pay)).toEqual([]);
  });
});

// Invented: the same paychecks, a tax refund, a sale, a monthly side job and
// money sent by Zelle in three months by three people.
describe('irregularIncome', () => {
  const month = (m: number, d = 12) => new Date(Date.UTC(2026, m, d, 12));
  const refund = deposit(month(3), 1240, 'irs treas 310', true, 'IRS TREAS 310 TAX REF');
  const sale = deposit(month(5), 900, 'marketplace payout', true, 'MARKETPLACE PAYOUT');
  const sideJob = [0, 1, 2, 3, 4, 5, 6].map((m) => deposit(month(m, 20), 300 + m * 25, 'brightpath tutoring', true, 'BRIGHTPATH TUTORING'));
  const gifts = [2, 3, 4].map((m) => deposit(month(m, 8), 200, 'zelle transfer', true, 'ZELLE FROM A PERSON'));
  const interest = [0, 1, 2].map((m) => deposit(month(m, 28), 12, 'harbor savings', true, 'INTEREST PAYMENT'));
  const all = [...paychecks(16), refund, sale, ...sideJob, ...gifts, ...interest];

  it('finds a refund, a sale and money a person sent; never pay, a monthly source or interest', () => {
    expect(irregularIncome(all).map((o) => o.id)).toEqual([gifts[0].id, gifts[1].id, refund.id, gifts[2].id, sale.id]);
  });

  it('counts a new source as regular once it pays in three of the seven months around a deposit', () => {
    const fresh = [4, 5, 6].map((m) => deposit(month(m, 20), 450, 'lodger rent', true, 'LODGER RENT'));
    expect(irregularIncome(fresh)).toEqual([]);
    expect(irregularIncome(fresh.slice(0, 2)).map((o) => o.id)).toEqual(fresh.slice(0, 2).map((t) => t.id));
  });

  // The failure: a refund counted in a month's income, read as a saving habit.
  it('reaches the cash-flow rows as one-off income, left out of every pace', () => {
    const rows = computeCashFlowTrend(all, ['2026-04'], 'MONTH');
    const april = rows.get('2026-04')!;
    expect(april.oneOffIncome).toBe(1440);
    expect(april.oneOffPay?.map((o) => o.amount)).toEqual([200, 1240]);
    expect(april.income).toBeGreaterThan(april.oneOffIncome!);
  });
});

describe('earned income on the cash-flow rows', () => {
  // Invented: $12 of interest on a savings account inside March's income.
  it('carries the interest inside income by account, for readiness to leave the fund\'s out', () => {
    const interest = { ...deposit(new Date(Date.UTC(2026, 2, 28, 12)), 12, 'harbor savings', true, 'INTEREST PAYMENT'), accountId: 'savings' };
    const march = computeCashFlowTrend([...paychecks(8), interest], ['2026-03'], 'MONTH').get('2026-03')!;
    expect(march.earnedByAccount).toEqual({ savings: 12 });
    expect(march.oneOffIncome).toBe(0);
  });
});
