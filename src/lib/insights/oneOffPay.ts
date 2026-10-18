import { isP2P } from '../p2p';
import { round2 } from './stats';
import type { TxnData } from './types';

/**
 * Pay, sorted into PAYCHECKS and ONE-OFF pay (a bonus deposited beside a
 * paycheck, back pay, a payout). One-off pay is real income, but a
 * projection that averages it in reads a bonus month as a habit, so the
 * saving paces and house readiness leave it out; paychecks are what they
 * project from, at the CURRENT amount (ui/payLevel.ts)
 * (docs/conventions/goals-and-insights.md, ONE-OFF PAY).
 *
 * A deposit is REGULAR pay when the same amount (within 2%) from the same
 * payer arrives on at least three of the eight paydays around it, four
 * before and four after. Both sides together, so a raise counts from its
 * first paycheck once it repeats, the last paycheck at the old amount still
 * counts, and one extra payday (a bonus paid on its own date) cannot break a
 * run; a second payment every other payday is regular too.
 *
 * Anything else from a payer that pays on a schedule is a ONE-OFF when it is
 * EXTRA: beside a regular paycheck on the same day, or between two regular
 * paydays (or soon after the last one) rather than in a paycheck's place. A
 * bonus that comes back a month later is still beside a paycheck, so two
 * bonuses in a row never read as a raise. A deposit standing where a
 * paycheck should be IS that paycheck, at a new amount or an odd one: a
 * raise counts as income the day it lands.
 *
 * Only income-category inflows, never interest or dividends, and only payers
 * whose deposits are mostly regular (three or more, and three in four): a
 * bank's interest that happens to repeat to the cent is not a salary.
 */

const SAME_PAY = 0.02;
const NEIGHBOURS = 4;
const NEEDED = 3;
/** Share of a payer's deposits that must be regular before its odd ones are judged. */
const MOSTLY = 0.75;
const EARNED = /\b(interest|dividend)\b/i;

/** Interest or a dividend, by its wording: earned on money held, never pay. */
export const isEarned = (t: Pick<TxnData, 'description'>) => EARNED.test(t.description);
const DAY_MS = 86_400_000;

export interface PayDeposit {
  id: string;
  date: Date;
  amount: number;
  payer: string;
}

export const samePay = (a: number, b: number) => Math.abs(a - b) <= SAME_PAY * Math.max(Math.abs(a), Math.abs(b));
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Every payer's deposits sorted: the paychecks, and the one-off pay beside or between them. */
export function judgePay(txns: readonly TxnData[]): { paychecks: PayDeposit[]; oneOffs: PayDeposit[] } {
  const byPayer = new Map<string, TxnData[]>();
  for (const t of txns) {
    if (t.flow !== 'INFLOW' || t.amount <= 0 || !t.categoryIsIncome || t.reimbursesId !== null) continue;
    if (isEarned(t)) continue;
    const key = `${t.accountId}\u0001${t.normalizedMerchant}`;
    const list = byPayer.get(key);
    if (list === undefined) byPayer.set(key, [t]);
    else list.push(t);
  }

  const paychecks: PayDeposit[] = [];
  const oneOffs: PayDeposit[] = [];
  const of = (t: TxnData): PayDeposit => ({ id: t.id, date: t.date, amount: round2(t.amount), payer: t.normalizedMerchant });
  for (const deposits of byPayer.values()) {
    // Paydays: the distinct days this payer paid, oldest first, each with its amounts.
    const days = new Map<string, number[]>();
    for (const t of deposits) {
      const day = dayOf(t.date);
      const amounts = days.get(day);
      if (amounts === undefined) days.set(day, [t.amount]);
      else amounts.push(t.amount);
    }
    const paydays = [...days.keys()].sort();
    const paidOn = (i: number, amount: number) => days.get(paydays[i])!.some((a) => samePay(a, amount));

    const judged = deposits.map((t) => {
      const i = paydays.indexOf(dayOf(t.date));
      let matches = 0;
      const later = Math.min(NEIGHBOURS, paydays.length - 1 - i);
      for (let k = Math.max(0, i - NEIGHBOURS); k <= i + later; k += 1) if (k !== i && paidOn(k, t.amount)) matches += 1;
      return { t, regular: matches >= NEEDED };
    });
    const regulars = judged.filter((j) => j.regular).length;
    if (regulars < NEEDED || regulars < MOSTLY * judged.length) continue;

    // The days a regular paycheck landed, and the usual gap between them.
    const regularDays = [...new Set(judged.filter((j) => j.regular).map((j) => dayOf(j.t.date)))].sort();
    const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
    const gaps = regularDays.slice(1).map((d, k) => (at(d) - at(regularDays[k])) / DAY_MS).sort((a, b) => a - b);
    const usual = gaps.length === 0 ? 0 : gaps[Math.floor(gaps.length / 2)];
    for (const j of judged) {
      if (j.regular) {
        paychecks.push(of(j.t));
        continue;
      }
      const day = dayOf(j.t.date);
      const prev = regularDays.filter((d) => d < day).at(-1);
      const next = regularDays.find((d) => d > day);
      const sincePrev = prev === undefined ? Infinity : (at(day) - at(prev)) / DAY_MS;
      // Extra pay: beside a paycheck, between two paydays no further apart
      // than usual, or soon after the last one. Otherwise it stands where a
      // paycheck should, and is one.
      const beside = regularDays.includes(day);
      const between = prev !== undefined && next !== undefined && (at(next) - at(prev)) / DAY_MS <= 1.5 * usual;
      const early = next === undefined && sincePrev < 0.75 * usual;
      if (beside || between || early) oneOffs.push(of(j.t));
      else paychecks.push(of(j.t));
    }
  }
  const byDate = (a: PayDeposit, b: PayDeposit) => a.date.getTime() - b.date.getTime();
  return { paychecks: paychecks.sort(byDate), oneOffs: oneOffs.sort(byDate) };
}

/** One-off pay alone. */
export function oneOffPay(txns: readonly TxnData[]): PayDeposit[] {
  return judgePay(txns).oneOffs;
}

/** Months either side of a deposit in which its source must pay again to be a regular source. */
const SOURCE_REACH = 3;
/** Months, of the seven around a deposit, its source must pay in. */
const SOURCE_MONTHS = 3;

const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/**
 * Income from NO REGULAR SOURCE: a tax refund, the proceeds of a sale, money
 * a person sent that is not linked to what it repays. Real income, but like a
 * bonus it does not come again next month, so every saving pace and readiness
 * income leave it out with one-off pay, and the screens say so.
 *
 * Judged only among income-category inflows that are neither a paycheck nor
 * one-off pay (judgePay has the salary-like payers), never interest or
 * dividends. A source is REGULAR when it paid in at least three of the seven
 * months around the deposit (rent from a lodger, a side job's monthly
 * invoice), both sides counted, so a new stream counts once it continues. A
 * payment rail (Zelle, Venmo, PayPal...) is never a source: it pools every
 * person who ever sent money, and three gifts from three people in three
 * months would read as a stream.
 */
export function irregularIncome(
  txns: readonly TxnData[],
  judged: { paychecks: readonly PayDeposit[]; oneOffs: readonly PayDeposit[] } = judgePay(txns),
): PayDeposit[] {
  const pay = new Set([...judged.paychecks, ...judged.oneOffs].map((p) => p.id));
  const candidates = txns.filter(
    (t) =>
      t.flow === 'INFLOW' &&
      t.amount > 0 &&
      t.categoryIsIncome &&
      t.reimbursesId === null &&
      !isEarned(t) &&
      !pay.has(t.id),
  );
  const monthsBySource = new Map<string, Set<number>>();
  for (const t of candidates) {
    if (isP2P(t)) continue;
    const key = `${t.accountId}${t.normalizedMerchant}`;
    const months = monthsBySource.get(key) ?? new Set<number>();
    months.add(monthIndex(t.date));
    monthsBySource.set(key, months);
  }
  const regular = (t: TxnData) => {
    if (isP2P(t)) return false;
    const months = monthsBySource.get(`${t.accountId}${t.normalizedMerchant}`)!;
    const m = monthIndex(t.date);
    let paid = 0;
    for (let k = m - SOURCE_REACH; k <= m + SOURCE_REACH; k += 1) if (months.has(k)) paid += 1;
    return paid >= SOURCE_MONTHS;
  };
  return candidates
    .filter((t) => !regular(t))
    .map((t) => ({ id: t.id, date: t.date, amount: round2(t.amount), payer: t.normalizedMerchant }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
