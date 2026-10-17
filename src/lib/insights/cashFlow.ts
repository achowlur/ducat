import type { CashFlowTrendPayload, PeriodGranularity } from '../../types/contracts';
import { oneOffPay } from './oneOffPay';
import { inPeriod, previousPeriodKey } from './periods';
import { isReimbursement, reimbursementCredits, type ReimbursementCredit } from './reimbursements';
import { pctDelta, round2 } from './stats';
import type { TxnData } from './types';

function flowsFor(txns: TxnData[], credits: ReimbursementCredit[], key: string): { income: number; spending: number } {
  let income = 0;
  let spending = 0;
  for (const t of txns) {
    if (t.flow === 'TRANSFER') continue;
    // Reimbursements are money coming BACK, not earnings — they reduce
    // spending (below) instead of inflating income.
    if (isReimbursement(t)) continue;
    if (!inPeriod(t.date, key)) continue;
    if (t.flow === 'INFLOW') income += t.amount;
    else spending += -t.amount;
  }
  for (const credit of credits) {
    if (inPeriod(credit.date, key)) spending -= credit.amount;
  }
  return { income, spending };
}

export function computeCashFlowTrend(
  txns: TxnData[],
  periods: string[],
  granularity: PeriodGranularity,
): Map<string, CashFlowTrendPayload> {
  const credits = reimbursementCredits(txns);
  // Judged over the whole history: whether pay repeats is a question about
  // the paydays around it, which other periods hold.
  const oneOffs = oneOffPay(txns);
  const result = new Map<string, CashFlowTrendPayload>();
  for (const key of periods) {
    const current = flowsFor(txns, credits, key);
    const extra = oneOffs.filter((o) => inPeriod(o.date, key));
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
      oneOffPay: extra.map((o) => ({ date: o.date.toISOString().slice(0, 10), amount: o.amount, payer: o.payer, settled: o.settled })),
    });
  }
  return result;
}
