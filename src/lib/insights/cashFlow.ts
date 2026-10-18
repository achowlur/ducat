import type { CashFlowTrendPayload, PeriodGranularity } from '../../types/contracts';
import { irregularIncome, isEarned, judgePay, type PayDeposit } from './oneOffPay';
import { inPeriod, previousPeriodKey } from './periods';
import { isReimbursement, reimbursementCredits, type ReimbursementCredit } from './reimbursements';
import { pctDelta, round2 } from './stats';
import type { TxnData } from './types';

function flowsFor(
  txns: TxnData[],
  credits: ReimbursementCredit[],
  key: string,
): { income: number; spending: number; earned: Record<string, number> } {
  let income = 0;
  let spending = 0;
  const earned: Record<string, number> = {};
  for (const t of txns) {
    if (t.flow === 'TRANSFER') continue;
    // Reimbursements are money coming BACK, not earnings — they reduce
    // spending (below) instead of inflating income.
    if (isReimbursement(t)) continue;
    if (!inPeriod(t.date, key)) continue;
    if (t.flow === 'INFLOW') {
      income += t.amount;
      if (isEarned(t)) earned[t.accountId] = round2((earned[t.accountId] ?? 0) + t.amount);
    } else spending += -t.amount;
  }
  for (const credit of credits) {
    if (inPeriod(credit.date, key)) spending -= credit.amount;
  }
  return { income, spending, earned };
}

export function computeCashFlowTrend(
  txns: TxnData[],
  periods: string[],
  granularity: PeriodGranularity,
): Map<string, CashFlowTrendPayload> {
  const credits = reimbursementCredits(txns);
  // Judged over the whole history: whether pay repeats is a question about
  // the paydays around it, which other periods hold.
  const pay = judgePay(txns);
  // One-off income: extra pay beside paychecks, and income from no regular
  // source (a refund, a sale, money a person sent).
  const oneOffs = [...pay.oneOffs, ...irregularIncome(txns, pay)];
  const item = (o: PayDeposit) => ({ date: o.date.toISOString().slice(0, 10), amount: o.amount, payer: o.payer });
  const result = new Map<string, CashFlowTrendPayload>();
  for (const key of periods) {
    const current = flowsFor(txns, credits, key);
    const extra = oneOffs.filter((o) => inPeriod(o.date, key)).sort((a, b) => a.date.getTime() - b.date.getTime());
    const prevKey = previousPeriodKey(key);
    const previous = periods.includes(prevKey) ? flowsFor(txns, credits, prevKey) : null;
    result.set(key, {
      granularity,
      income: round2(current.income),
      spending: round2(current.spending),
      net: round2(current.income - current.spending),
      previousIncome: previous === null ? null : round2(previous.income),
      previousSpending: previous === null ? null : round2(previous.spending),
      previousNet: previous === null ? null : round2(previous.income - previous.spending),
      incomeDeltaPct: pctDelta(current.income, previous === null ? null : previous.income),
      spendingDeltaPct: pctDelta(current.spending, previous === null ? null : previous.spending),
      oneOffIncome: round2(extra.reduce((sum, o) => sum + o.amount, 0)),
      oneOffPay: extra.map(item),
      paychecks: pay.paychecks.filter((o) => inPeriod(o.date, key)).map(item),
      earnedByAccount: current.earned,
    });
  }
  return result;
}
