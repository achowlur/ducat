import type { CategorySpending, PeriodGranularity, SpendingByCategoryPayload } from '../../types/contracts';
import { inPeriod, previousPeriodKey } from './periods';
import { reimbursementCredits, type ReimbursementCredit } from './reimbursements';
import { pctDelta, round2 } from './stats';
import type { TxnData } from './types';

interface CategoryTotals {
  total: number;
  byCategory: Map<string | null, { name: string | null; spending: number }>;
}

function spendingFor(txns: TxnData[], credits: ReimbursementCredit[], key: string): CategoryTotals {
  const byCategory = new Map<string | null, { name: string | null; spending: number }>();
  let total = 0;
  for (const t of txns) {
    if (t.flow !== 'OUTFLOW') continue; // TRANSFER excluded from all spending analytics
    if (!inPeriod(t.date, key)) continue;
    const spent = -t.amount; // outflows are negative; report positive magnitude
    total += spent;
    const entry = byCategory.get(t.categoryId) ?? { name: t.categoryName, spending: 0 };
    entry.spending += spent;
    byCategory.set(t.categoryId, entry);
  }
  // Reimbursements net against their category (a fronted dinner partly
  // Zelled back is spending you didn't ultimately do).
  for (const credit of credits) {
    if (!inPeriod(credit.date, key)) continue;
    total -= credit.amount;
    const entry = byCategory.get(credit.categoryId) ?? { name: credit.categoryName, spending: 0 };
    entry.spending -= credit.amount;
    byCategory.set(credit.categoryId, entry);
  }
  return { total, byCategory };
}

export function computeSpendingByCategory(
  txns: TxnData[],
  periods: string[],
  granularity: PeriodGranularity,
): Map<string, SpendingByCategoryPayload> {
  const credits = reimbursementCredits(txns);
  const result = new Map<string, SpendingByCategoryPayload>();
  for (const key of periods) {
    const current = spendingFor(txns, credits, key);
    const prevKey = previousPeriodKey(key);
    const previous = periods.includes(prevKey) ? spendingFor(txns, credits, prevKey) : null;

    const categories: CategorySpending[] = [...current.byCategory.entries()]
      .map(([categoryId, { name, spending }]) => {
        const prev = previous?.byCategory.get(categoryId)?.spending ?? null;
        return {
          categoryId,
          categoryName: name,
          spending: round2(spending),
          previousSpending: prev === null ? null : round2(prev),
          deltaPct: pctDelta(spending, prev),
        };
      })
      .sort((a, b) => b.spending - a.spending);

    result.set(key, {
      granularity,
      totalSpending: round2(current.total),
      previousTotalSpending: previous === null ? null : round2(previous.total),
      categories,
    });
  }
  return result;
}
