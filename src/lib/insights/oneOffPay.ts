import { round2 } from './stats';
import type { TxnData } from './types';

/**
 * Pay that is not salary: a bonus deposited beside a paycheck, back pay, a
 * payout. Real income, but a projection that averages it in reads a bonus
 * month as a habit, so the saving paces and house readiness leave it out
 * (docs/conventions/goals-and-insights.md, ONE-OFF PAY).
 *
 * A deposit is REGULAR pay when the same amount (within 2%) from the same
 * payer arrives on at least three of the eight paydays around it, four
 * before and four after. Both sides together, so a raise counts from its
 * first paycheck once it repeats, the last paycheck at the old amount still
 * counts, and one extra payday (a bonus paid on its own date) cannot break a
 * run; a second payment every other payday is regular too. Everything else
 * from a payer that pays on a schedule, and EXTRA, is a ONE-OFF: beside a
 * regular paycheck on the same day, or between two regular paydays no
 * further apart than usual (a bonus on its own date), even one that comes
 * back a month later. A deposit standing where a paycheck should be IS that
 * paycheck, at an odd amount: income. One too recent to judge
 * (paydays still to come could make it three) is UNSETTLED: left out like a
 * one-off, and said so, until the paydays decide it.
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
const DAY_MS = 86_400_000;

export interface OneOffPay {
  id: string;
  date: Date;
  amount: number;
  payer: string;
  /** False while its later paydays could still make it regular pay. */
  settled: boolean;
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) <= SAME_PAY * Math.max(Math.abs(a), Math.abs(b));
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export function oneOffPay(txns: readonly TxnData[]): OneOffPay[] {
  const byPayer = new Map<string, TxnData[]>();
  for (const t of txns) {
    if (t.flow !== 'INFLOW' || t.amount <= 0 || !t.categoryIsIncome || t.reimbursesId !== null) continue;
    if (EARNED.test(t.description)) continue;
    const key = `${t.accountId}\u0001${t.normalizedMerchant}`;
    const list = byPayer.get(key);
    if (list === undefined) byPayer.set(key, [t]);
    else list.push(t);
  }

  const out: OneOffPay[] = [];
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
    const paidOn = (i: number, amount: number) => days.get(paydays[i])!.some((a) => sameAmount(a, amount));

    const judged = deposits.map((t) => {
      const i = paydays.indexOf(dayOf(t.date));
      let matches = 0;
      const later = Math.min(NEIGHBOURS, paydays.length - 1 - i);
      for (let k = Math.max(0, i - NEIGHBOURS); k <= i + later; k += 1) if (k !== i && paidOn(k, t.amount)) matches += 1;
      const regular = matches >= NEEDED;
      // Paydays still to come could make it regular.
      const open = !regular && matches + (NEIGHBOURS - later) >= NEEDED;
      return { t, regular, open };
    });
    const regulars = judged.filter((j) => j.regular).length;
    if (regulars < NEEDED || regulars < MOSTLY * judged.length) continue;

    // The days a regular paycheck landed, and the usual gap between them.
    const regularDays = [...new Set(judged.filter((j) => j.regular).map((j) => dayOf(j.t.date)))].sort();
    const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
    const gaps = regularDays.slice(1).map((d, k) => (at(d) - at(regularDays[k])) / DAY_MS).sort((a, b) => a - b);
    const usual = gaps.length === 0 ? 0 : gaps[Math.floor(gaps.length / 2)];
    for (const j of judged) {
      if (j.regular) continue;
      const day = dayOf(j.t.date);
      const prev = regularDays.filter((d) => d < day).at(-1);
      const next = regularDays.find((d) => d > day);
      // Extra pay: beside a paycheck, or between two paydays no further apart
      // than usual. Otherwise it stands where a paycheck should, and is one.
      const beside = regularDays.includes(day);
      const between = prev !== undefined && next !== undefined && (at(next) - at(prev)) / DAY_MS <= 1.5 * usual;
      // Past the last paycheck nothing can tell yet: a bonus, or a raise's first.
      const pending = next === undefined && !beside;
      if (!beside && !between && !pending) continue;
      out.push({ id: j.t.id, date: j.t.date, amount: round2(j.t.amount), payer: j.t.normalizedMerchant, settled: !j.open && !pending });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}
